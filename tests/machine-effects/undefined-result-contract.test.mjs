import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBitVectorValue,
  createIntrinsicEffectSummary,
  createMachineOperation,
  createTemporaryValue,
  createUndefinedResultDescriptor,
} from '../../js/semantics/effects/index.js';

function valueOperation(undefinedResult, widthBits = 32) {
  return createMachineOperation({
    kind: 'value',
    opcode: 'architectural-undefined-boundary',
    inputs: [createBitVectorValue(widthBits, 1n)],
    outputs: [createTemporaryValue('me01-undefined-result', createBitVectorValue(widthBits))],
    undefinedResult,
  });
}

test('canonical MachineEffects retains every undefined-result class without inventing a value', () => {
  const cases = [
    ['fully', '0xffffffff', null],
    ['conditional', '0xffffffff', { kind: 'divisor-zero', operandIndex: 0 }],
    ['partial', '0xffff0000', null],
    ['operand-dependent', '0xffffffff', { kind: 'count-at-least-width', operandIndex: 0 }],
  ];
  for (const [resultClass, mask, condition] of cases) {
    const operation = valueOperation({
      widthBits: 32,
      mask,
      class: resultClass,
      reason: `me01-${resultClass}`,
      ...(condition == null ? {} : { condition }),
    });
    assert.equal(operation.undefinedResult.class, resultClass);
    assert.equal(operation.undefinedResult.mask, mask);
    assert.equal('value' in operation.undefinedResult, false);
    assert.equal(Object.isFrozen(operation.undefinedResult), true);
    assert.deepEqual(JSON.parse(JSON.stringify(operation)).undefinedResult, operation.undefinedResult);
  }
});

test('undefined-result validation rejects malformed, unsupported, and width-inconsistent claims', () => {
  assert.throws(() => createUndefinedResultDescriptor({ widthBits: 32, mask: '0x0', class: 'partial', reason: 'zero' }), /invalid-undefined-result-mask/);
  let coercions = 0;
  assert.throws(() => createUndefinedResultDescriptor({ widthBits: { valueOf() { coercions++; return 32; } }, mask: '0x1', class: 'partial', reason: 'coerced-width' }), /invalid-undefined-result-width/);
  assert.throws(() => createUndefinedResultDescriptor({ widthBits: 32, mask: { toString() { coercions++; return '0x1'; } }, class: 'partial', reason: 'coerced-mask' }), /invalid-undefined-result-mask/);
  assert.equal(coercions, 0, 'descriptor validation must not coerce untrusted width or mask values');
  assert.throws(() => createUndefinedResultDescriptor({ widthBits: 32, mask: '0x1ffffffff', class: 'partial', reason: 'wide' }), /invalid-undefined-result-mask/);
  assert.throws(() => createUndefinedResultDescriptor({ widthBits: 32, mask: '0xffffffff', class: 'partial', reason: 'not-partial' }), /partial-undefined-result-mask-full/);
  assert.throws(() => createUndefinedResultDescriptor({ widthBits: 32, mask: '0xffff', class: 'fully', reason: 'not-full' }), /fully-undefined-result-mask-incomplete/);
  assert.throws(() => createUndefinedResultDescriptor({ widthBits: 32, mask: '0xffffffff', class: 'conditional', reason: 'missing-condition' }), /condition-required/);
  assert.throws(() => createUndefinedResultDescriptor({ widthBits: 32, mask: '0xffffffff', class: 'conditional', reason: 'unknown-condition', condition: { kind: 'caller-label', operandIndex: 0 } }), /invalid-undefined-result-condition-kind/);
  assert.throws(() => createUndefinedResultDescriptor({ widthBits: 32, mask: '0xffffffff', class: 'conditional', reason: 'extra-condition-field', condition: { kind: 'source-zero', operandIndex: 0, operand: 'source' } }), /unexpected-undefined-result-condition-field/);
  assert.throws(() => createUndefinedResultDescriptor({ widthBits: 32, mask: '0xffffffff', class: 'fully', reason: 'unexpected-condition', condition: { kind: 'source-zero', operandIndex: 0 } }), /condition-not-allowed/);
  assert.throws(() => createUndefinedResultDescriptor({ schemaVersion: 'future/v9', widthBits: 32, mask: '0xffffffff', class: 'fully', reason: 'future' }), /unsupported-undefined-result-schema/);
  assert.throws(() => createUndefinedResultDescriptor({ widthBits: 32, mask: '0xffffffff', class: 'fully', reason: 'extra', value: 0 }), /unexpected-undefined-result-field/);
  assert.throws(() => valueOperation({ widthBits: 64, mask: '0xffffffffffffffff', class: 'fully', reason: 'wrong-width' }, 32), /output-width-mismatch/);
  assert.throws(() => valueOperation({ widthBits: 32, mask: '0xffffffff', class: 'conditional', reason: 'bad-operand', condition: { kind: 'source-zero', operandIndex: 1 } }), /condition-operand-out-of-range/);
  assert.throws(() => createMachineOperation({
    kind:'intrinsic', intrinsicId:'ambiguous-results',
    effectSummary:createIntrinsicEffectSummary({
      inputs:[createBitVectorValue(32, 1n)],
      outputs:[
        createTemporaryValue('ambiguous-0', createBitVectorValue(32)),
        createTemporaryValue('ambiguous-1', createBitVectorValue(32)),
      ],
      registersRead:[], registersWritten:[], memoryRead:{ scope:'none' }, memoryWrite:{ scope:'none' },
      controlEffects:[], determinism:'input-dependent', symbolicDetail:'summary-only',
    }),
    undefinedResult:{ widthBits:32, mask:'0xffffffff', class:'conditional', reason:'ambiguous', condition:{ kind:'source-zero', operandIndex:0 } },
  }), /output-width-mismatch/);
});

test('undefined-result validation snapshots strict own enumerable data without invoking hostile behavior', () => {
  const valid = { widthBits:32, mask:'0xffffffff', class:'fully', reason:'strict-snapshot' };
  let getterCalls = 0;
  const accessor = { ...valid };
  Object.defineProperty(accessor, 'widthBits', { enumerable:true, get() { getterCalls++; return 32; } });
  assert.throws(() => createUndefinedResultDescriptor(accessor), /undefined-result.*data-property/);
  assert.equal(getterCalls, 0);

  const inherited = Object.assign(Object.create({ inherited:true }), valid);
  assert.throws(() => createUndefinedResultDescriptor(inherited), /undefined-result.*prototype/);

  const nonEnumerableExtra = { ...valid };
  Object.defineProperty(nonEnumerableExtra, 'hidden', { enumerable:false, value:true });
  assert.throws(() => createUndefinedResultDescriptor(nonEnumerableExtra), /unexpected-undefined-result-field/);
  assert.throws(() => createUndefinedResultDescriptor(Object.assign([], valid)), /undefined-result-required/);
  const cyclic = { ...valid };
  cyclic.condition = cyclic;
  assert.throws(() => createUndefinedResultDescriptor(cyclic), /condition-not-allowed|unexpected-undefined-result-condition-field/);

  for (const [name, hostile] of [
    ['prototype', new Proxy({ ...valid }, { getPrototypeOf() { throw new Error('hostile'); } })],
    ['keys', new Proxy({ ...valid }, { ownKeys() { throw new Error('hostile'); } })],
    ['descriptor', new Proxy({ ...valid }, { getOwnPropertyDescriptor() { throw new Error('hostile'); } })],
  ]) {
    assert.throws(() => createUndefinedResultDescriptor(hostile), /undefined-result.*snapshot/, name);
  }

  const target = { ...valid };
  const descriptorReads = new Map();
  const snapshotOnly = new Proxy(target, {
    get() { throw new Error('ordinary property reads are forbidden'); },
    getOwnPropertyDescriptor(object, key) {
      descriptorReads.set(key, (descriptorReads.get(key) ?? 0) + 1);
      const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
      if (key === 'widthBits') object.widthBits = 1;
      return descriptor;
    },
  });
  assert.equal(createUndefinedResultDescriptor(snapshotOnly).widthBits, 32);
  assert.deepEqual([...descriptorReads.values()], [1, 1, 1, 1], 'each untrusted field is captured exactly once');

  const { proxy:revoked, revoke } = Proxy.revocable({ ...valid }, {});
  revoke();
  assert.throws(() => createUndefinedResultDescriptor(revoked), /undefined-result-snapshot-failed/);
});

test('an own null or undefined undefinedResult field is malformed, never absent', () => {
  const base = {
    kind:'value', opcode:'add', inputs:[createBitVectorValue(8, 1n)],
    outputs:[createTemporaryValue('explicit-malformed', createBitVectorValue(8))],
  };
  assert.throws(() => createMachineOperation({ ...base, undefinedResult:null }), /undefined-result-required/);
  assert.throws(() => createMachineOperation({ ...base, undefinedResult:undefined }), /undefined-result-required/);
  assert.doesNotThrow(() => createMachineOperation(base));
});
