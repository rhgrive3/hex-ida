import assert from 'node:assert/strict';
import test from 'node:test';

import '../../issue-1142-cil-stack-validation.mjs';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { validateCilEffectFunction } from '../../../js/managed/cil/validation.js';

function op(offset, { consumed=0, produced=0, controlEffects=[], callEffects=[], completeness='exact', bits=32 } = {}) {
  return {
    bytecodeOffset:offset,
    operationId:`op:${offset}`,
    consumedValues:Array.from({ length:consumed }, () => ({ bits })),
    producedValues:Array.from({ length:produced }, () => ({ bits })),
    controlEffects,
    callEffects,
    completeness,
  };
}

function validate(bundles, {
  maxStack=8,
  exceptionRegions=[],
  context={ returnStackSlots:0 },
} = {}) {
  return validateCilEffectFunction({
    methodId:'managed-method:test:0x06000001',
    profileId:'ecma-335',
    bundles,
    entryState:{ maxStack },
    exceptionRegions,
  }, context);
}

function region(kind, overrides = {}) {
  return {
    id:`region:${kind}`,
    startOffset:0,
    endOffset:2,
    handlerOffset:3,
    handlerLength:1,
    handlerEndOffset:4,
    handlerKind:kind,
    ...(kind === 'filter' ? { filterOffset:2 } : {}),
    ...overrides,
  };
}

function liftBytes(bytecode, exceptionClauses = []) {
  return liftCilMethod(0, {
    moduleId:'test',
    vmSpecEdition:'v4.0.30319',
    methodBodies:[{
      headerOffset:0,
      codeOffset:0,
      isTiny:false,
      maxStack:8,
      codeSize:bytecode.length,
      bytecode:Uint8Array.from(bytecode),
      exceptionClauses,
    }],
  });
}

test('#1142 missing maxStack or return-shape authority keeps spec validation partial', () => {
  const bundles = [op(0,{ controlEffects:[{ kind:'return' }] })];

  const missingMaxStack = validateCilEffectFunction({
    methodId:'managed-method:test:0x06000001',
    profileId:'ecma-335',
    bundles,
    entryState:{},
    exceptionRegions:[],
  }, { returnStackSlots:0 });
  assert.equal(missingMaxStack.status, 'partial');
  assert.equal(missingMaxStack.completeness.specValidation, 'partial');
  assert.ok(missingMaxStack.warnings.some((warning) => warning.code === 'cil-max-stack-unavailable'));

  const missingReturnShape = validate(bundles, { context:{} });
  assert.equal(missingReturnShape.status, 'partial');
  assert.equal(missingReturnShape.completeness.specValidation, 'partial');
  assert.ok(missingReturnShape.warnings.some((warning) => warning.code === 'cil-return-stack-shape-unavailable'));
});

test('#1142 handler ranges are protected and handler-end boundaries are validated', () => {
  for (const kind of ['catch', 'finally', 'filter']) {
    const exceptionRegion = region(kind);
    const report = validate([
      op(0,{ controlEffects:[{ kind:'branch', targetOffset:3 }] }),
      op(1),
      op(2),
      op(3,{ controlEffects:[{ kind:'return' }] }),
      op(4,{ controlEffects:[{ kind:'return' }] }),
    ], { exceptionRegions:[exceptionRegion] });
    assert.equal(report.status, 'invalid', `${kind} handler entry must not be reachable by ordinary branch`);
    assert.ok(report.errors.some((error) =>
      error.code === 'cil-branch-crosses-protected-region'
      && error.sourceOffset === 0
      && error.targetOffset === 3), `${kind} handler membership must participate in branch legality`);
  }

  const badHandlerEnd = validate([
    op(0), op(1), op(2), op(3), op(4,{ controlEffects:[{ kind:'return' }] }),
  ], {
    exceptionRegions:[region('catch', { handlerEndOffset:6, handlerLength:3 })],
  });
  assert.equal(badHandlerEnd.status, 'invalid');
  assert.ok(badHandlerEnd.errors.some((error) => error.code === 'cil-invalid-exception-region-boundary'));
});

test('#1142 switch validates every target and preserves lexical fallthrough', () => {
  const valid = validate([
    op(0,{ produced:1 }),
    op(1,{ consumed:1, controlEffects:[{ kind:'switch', targetOffsets:[3,4] }] }),
    op(2,{ controlEffects:[{ kind:'return' }] }),
    op(3,{ controlEffects:[{ kind:'return' }] }),
    op(4,{ controlEffects:[{ kind:'return' }] }),
  ]);
  assert.equal(valid.status, 'valid');
  const fact = valid.verifierFacts.find((entry) => entry.code === 'cil-stack-dataflow-validated');
  assert.equal(fact?.reachedBlocks, 5, 'switch targets and fallthrough must all be analyzed');

  const invalid = validate([
    op(0,{ produced:1 }),
    op(1,{ consumed:1, controlEffects:[{ kind:'switch', targetOffsets:[3,99] }] }),
    op(2,{ controlEffects:[{ kind:'return' }] }),
    op(3,{ controlEffects:[{ kind:'return' }] }),
  ]);
  assert.equal(invalid.status, 'invalid');
  assert.ok(invalid.errors.some((error) => error.code === 'cil-invalid-branch-target' && error.targetOffset === 99));
});

test('#1142 leave clears the stack, may exit try/catch, and cannot leave finally/filter', () => {
  const legal = validate([
    op(0,{ produced:1, controlEffects:[{ kind:'leave', targetOffset:2 }] }),
    op(1),
    op(2,{ controlEffects:[{ kind:'return' }] }),
    op(3,{ controlEffects:[{ kind:'endfinally' }] }),
  ], { exceptionRegions:[region('finally')] });
  assert.equal(legal.status, 'valid', 'leave from try must clear the stack and exit the protected scope');

  for (const kind of ['finally', 'filter']) {
    const exceptionRegion = region(kind, kind === 'filter'
      ? { startOffset:0, endOffset:1, filterOffset:2, handlerOffset:3, handlerEndOffset:4, handlerLength:1 }
      : {});
    const bundles = kind === 'filter'
      ? [
          op(0,{ controlEffects:[{ kind:'leave', targetOffset:4 }] }),
          op(1),
          op(2,{ controlEffects:[{ kind:'leave', targetOffset:4 }] }),
          op(3,{ controlEffects:[{ kind:'rethrow' }] }),
          op(4,{ controlEffects:[{ kind:'return' }] }),
        ]
      : [
          op(0,{ controlEffects:[{ kind:'leave', targetOffset:4 }] }),
          op(1),
          op(2),
          op(3,{ controlEffects:[{ kind:'leave', targetOffset:4 }] }),
          op(4,{ controlEffects:[{ kind:'return' }] }),
        ];
    const report = validate(bundles, { exceptionRegions:[exceptionRegion] });
    assert.equal(report.status, 'invalid', `leave from ${kind} must fail closed`);
    assert.ok(report.errors.some((error) =>
      error.code === 'cil-branch-crosses-protected-region'
      && error.targetOffset === 4));
  }
});

test('#1142 endfinally/endfilter/rethrow are terminal and do not lexically fall through', () => {
  const endFinally = validate([
    op(0,{ controlEffects:[{ kind:'endfinally' }] }),
    op(1,{ consumed:1 }),
  ], { context:{ returnStackSlots:0 } });
  assert.equal(endFinally.status, 'valid');
  assert.ok(!endFinally.errors.some((error) => error.code === 'cil-stack-underflow'));

  const endFilter = validate([
    op(0,{ produced:1 }),
    op(1,{ consumed:1, controlEffects:[{ kind:'endfilter' }] }),
    op(2,{ consumed:1 }),
  ]);
  assert.equal(endFilter.status, 'valid');
  assert.ok(!endFilter.errors.some((error) => error.code === 'cil-stack-underflow' && error.bytecodeOffset === 2));

  const rethrow = validate([
    op(0,{ controlEffects:[{ kind:'rethrow' }] }),
    op(1,{ consumed:1 }),
  ]);
  assert.equal(rethrow.status, 'valid');
  assert.ok(!rethrow.errors.some((error) => error.code === 'cil-stack-underflow'));
});

test('#1142 lifter preserves handler ranges and emits switch/exception control effects', () => {
  const withRegion = liftBytes([0x2a], [
    { kind:'catch', tryOffset:0, tryLength:1, handlerOffset:0, handlerLength:1, classTokenOrFilter:0x01000001 },
  ]);
  assert.equal(withRegion.exceptionRegions[0].handlerLength, 1);
  assert.equal(withRegion.exceptionRegions[0].handlerEndOffset, 1);

  const switched = liftBytes([
    0x16,
    0x45, 0x01, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x2a,
  ]);
  assert.equal(switched.bundles[1].mnemonic, 'switch');
  assert.deepEqual(switched.bundles[1].controlEffects, [{ kind:'switch', targetOffsets:[10] }]);

  const leave = liftBytes([0xde, 0x00, 0x2a]);
  assert.deepEqual(leave.bundles[0].controlEffects, [{ kind:'leave', targetOffset:2 }]);

  assert.deepEqual(liftBytes([0xdc]).bundles[0].controlEffects, [{ kind:'endfinally' }]);
  assert.deepEqual(liftBytes([0xfe, 0x1a]).bundles[0].controlEffects, [{ kind:'rethrow' }]);

  const filtered = liftBytes([0x16, 0xfe, 0x11]);
  assert.equal(filtered.bundles[1].mnemonic, 'endfilter');
  assert.deepEqual(filtered.bundles[1].controlEffects, [{ kind:'endfilter' }]);

  assert.throws(
    () => liftBytes([0x45, 0xff, 0xff, 0xff, 0x7f]),
    /cil-truncated-operand/,
    'switch table count must be bounded by the remaining bytecode',
  );
});
