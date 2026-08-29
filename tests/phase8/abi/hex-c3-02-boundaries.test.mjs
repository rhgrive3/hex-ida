import assert from 'node:assert/strict';
import test from 'node:test';

import { semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';
import { recoverFunctionPrototype } from '../../../js/decompiler/types/prototype.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { classifyCallArguments } from '../../../js/ir-core.js';
import {
  AAPCS64_ABI, DARWIN_ARM64_ABI, SYSV_AMD64_ABI, MICROSOFT_X64_ABI, RISCV_LP64_ABI,
  resolveABIPlugin,
} from '../../../js/targets/abi/index.js';

function value(id, reg) { return { id, reg, uses:[{}] }; }

function recover(adapter, registers = ['x0'], types = {}, opts = {}) {
  return recoverFunctionPrototype(
    { args:new Map(registers.map((reg, index) => [reg, value(index + 1, reg)])), instructions:[] },
    { values:new Map(), ...types },
    { ...opts, abiAdapter:adapter },
  );
}

test('C3-02 canonical adapter carries one ABI identity through classification', () => {
  const adapter = semanticAbiAdapter(AAPCS64_ABI, {
    architecture:'arm64', platform:'linux', binaryId:'binary-c3-02',
    sliceId:'slice-c3-02', functionId:'fn-c3-02',
  });
  const pair = { type:'struct Pair', aggregate:true, bits:128 };
  const classified = adapter.classifyArguments({ functionPrototype:{ parameters:[pair] } });
  assert.equal(adapter.semanticIdentity, 'aapcs64@2');
  assert.equal(adapter.identity.semanticIdentity, 'aapcs64@2');
  assert.equal(adapter.invalidation.binaryId, 'binary-c3-02');
  assert.equal(adapter.provenance.source, 'canonical-abi-registry');
  assert.deepEqual(classified.arguments[0].regs, ['x0','x1']);

  const prototype = recover(adapter, ['x0', 'x1'], {}, {
    functionPrototype:{ parameters:[pair] },
  });
  assert.equal(prototype.abiSemanticIdentity, adapter.semanticIdentity);
  assert.equal(prototype.abiIdentity.invalidation.binaryId, 'binary-c3-02');
  assert.equal(prototype.provenance, 'canonical-abi-registry');
  assert.deepEqual(prototype.arguments[0].regs, classified.arguments[0].regs);
});

test('C3-02 known variadic prototypes publish only a fixed prefix and unknown frontier', () => {
  const prototype = recover(semanticAbiAdapter(AAPCS64_ABI), ['x0'], {}, { variadic:true });
  assert.equal(prototype.conventionKnown, true);
  assert.equal(prototype.completeness, 'partial');
  assert.equal(prototype.variadic, true);
  assert.deepEqual(prototype.anonymousArgumentFrontier, {
    location:'unknown', possible:true, mustUse:false,
    reason:'anonymous-vararg-frontier-not-source-prototyped',
  });
});

test('C3-02 invalidated evidence never publishes exact prototype facts', () => {
  const cases = [
    ['cancelled', { cancelled:true }],
    ['deadline', { deadlineExceeded:true }],
    ['truncated', { truncated:true }],
    ['budget', { budgetExhausted:true }],
    ['indirect-call', { indirectCall:true }],
    ['caller-callee-conflict', { callerCalleeConflict:true }],
    ['malformed', { malformedEvidence:true }],
    ['classifier-failed', { classifierFailed:true }],
  ];
  for (const [name, opts] of cases) {
    const prototype = recover(semanticAbiAdapter(AAPCS64_ABI), ['x0', 'x1'], {}, opts);
    assert.equal(prototype.conventionKnown, false, `${name} must not retain supported identity`);
    assert.deepEqual(prototype.arguments, [], `${name} must not publish arguments`);
    assert.deepEqual(prototype.returnLocations, [], `${name} must not publish returns`);
    assert.notEqual(prototype.completeness, 'complete', `${name} must remain conservative`);
  }
});

test('C3-02 unknown adapter completeness is rejected even with a current identity', () => {
  const adapter = {
    id:'aapcs64', semanticVersion:'2', semanticIdentity:'aapcs64@2',
    architectureId:'arm64', completeness:'unknown',
  };
  const prototype = recover(adapter, ['x0']);
  assert.equal(prototype.conventionKnown, false);
  assert.equal(prototype.completeness, 'unknown');
  assert.deepEqual(prototype.arguments, []);
});

test('C3-02 unknown source prototype does not promote entry registers to parameters', () => {
  const prototype = recover(semanticAbiAdapter(AAPCS64_ABI), ['x0'], {}, { functionPrototype:{} });
  assert.equal(prototype.conventionKnown, true);
  assert.equal(prototype.completeness, 'partial');
  assert.deepEqual(prototype.arguments, []);
});

test('C3-02 unprototyped live registers remain separate uncertain candidates', () => {
  const prototype = recover(semanticAbiAdapter(AAPCS64_ABI), ['x0', 'x1']);
  assert.equal(prototype.arguments.length, 2);
  assert.equal(prototype.arguments.some((argument) => argument.aggregate === true), false);
  assert.equal(prototype.arguments.every((argument) => argument.possible === true && argument.mustUse === false), true);
});

test('C3-02 unrelated unprototyped live registers are never invented as one aggregate', () => {
  const prototype = recover(semanticAbiAdapter(AAPCS64_ABI), ['x0', 'x3']);
  assert.deepEqual(prototype.arguments.map((argument) => argument.reg), ['x0', 'x3']);
  assert.equal(prototype.arguments.some((argument) => argument.aggregate === true || Array.isArray(argument.regs)), false);
  assert.equal(prototype.arguments.every((argument) => argument.possible === true && argument.mustUse === false), true);
});

test('C3-02 explicit scalar parameters are not merged by a synthetic aggregate probe', () => {
  const prototype = recover(semanticAbiAdapter(AAPCS64_ABI), ['x0', 'x1'], {}, {
    functionPrototype:{ parameters:[{ type:'int64', bits:64 }, { type:'int64', bits:64 }] },
  });
  assert.equal(prototype.arguments.length, 2);
  assert.equal(prototype.arguments.some((argument) => argument.aggregate === true), false);
});

test('C3-02 deterministic replay keeps identity, pieces, and conservative state stable', () => {
  const adapter = semanticAbiAdapter(SYSV_AMD64_ABI, {
    architecture:'x86_64', platform:'linux', binaryId:'binary-c3-02', sliceId:'sysv',
  });
  const types = { ret:{ type:'struct Pair', aggregate:true, bits:128, eightbyteClasses:['INTEGER','INTEGER'] } };
  const first = recover(adapter, ['rdi', 'rsi'], types);
  const second = recover(adapter, ['rdi', 'rsi'], types);
  assert.deepEqual(second, first);
  assert.equal(first.abiSemanticIdentity, 'sysv-amd64@2');
  assert.deepEqual(first.returnLocations.map(({ reg, pieceIndex }) => ({ reg, pieceIndex })), [
    { reg:'rax', pieceIndex:0 }, { reg:'rdx', pieceIndex:1 },
  ]);
});

test('C3-02 profile and caller/callee contradictions fail closed', () => {
  const mismatched = {
    id:'microsoft-x64', semanticVersion:'3', semanticIdentity:'microsoft-x64@3', architectureId:'arm64',
  };
  const profileMismatch = recover(mismatched, ['rcx']);
  assert.equal(profileMismatch.conventionKnown, false);
  assert.deepEqual(profileMismatch.arguments, []);

  const conflict = recover(semanticAbiAdapter(MICROSOFT_X64_ABI), ['rcx'], {}, { callerCalleeAgreement:false });
  assert.equal(conflict.conventionKnown, false);
  assert.equal(conflict.completeness, 'conflict');
  assert.deepEqual(conflict.arguments, []);
});

test('C3-02 arm64e retains the requested Apple profile and rejects a mismatched ABI', () => {
  const apple = semanticAbiAdapter(DARWIN_ARM64_ABI, {
    architecture:'arm64e', platform:'darwin',
    architectureProfile:{ architectureId:'arm64e', semanticIdentity:'darwin-arm64@1' },
  });
  const applePrototype = recover(apple, ['x0']);
  assert.equal(applePrototype.conventionKnown, true);
  assert.equal(applePrototype.abiIdentity.targetArchitecture, 'arm64e');

  const wrong = recover(semanticAbiAdapter(AAPCS64_ABI, { architecture:'arm64e', platform:'darwin' }), ['x0']);
  assert.equal(wrong.conventionKnown, false);
  assert.deepEqual(wrong.arguments, []);

  const noPlatform = recover(semanticAbiAdapter(DARWIN_ARM64_ABI, { architecture:'arm64e' }), ['x0']);
  assert.equal(noPlatform.conventionKnown, false);
  assert.deepEqual(noPlatform.arguments, []);
});

test('C3-02 architecture-only arm64e cannot resolve an ABI profile', () => {
  assert.equal(resolveABIPlugin({ architecture:'arm64e' }).id, 'unknown');
  assert.equal(resolveABIPlugin({ architecture:'arm64e', platform:'linux' }).id, 'unknown');
  assert.equal(resolveABIPlugin({ architecture:'arm64e', platform:'darwin' }).id, 'darwin-arm64');
});

test('C3-02 legacy compatibility classifier routes through the selected canonical ABI', () => {
  const riscv = classifyCallArguments(
    { callPrototype:{ args:[{ type:'int64', bits:64 }] } },
    { architecture:'riscv64', platform:'linux', abiId:'lp64' },
  );
  assert.equal(riscv.arguments[0].reg, 'x10');
  assert.notEqual(riscv.arguments[0].reg, 'x0');

  const sysv = classifyCallArguments(
    { callPrototype:{ args:[{ type:'int64', bits:64 }] } },
    { architecture:'x86_64', platform:'linux', abiId:'sysv-amd64' },
  );
  assert.equal(sysv.arguments[0].reg, 'rdi');
});

test('C3-02 invalidates an adapter reused for a different binary snapshot', () => {
  const adapter = semanticAbiAdapter(AAPCS64_ABI, { binaryId:'binary-old' });
  const prototype = recover(adapter, ['x0'], {}, { binaryId:'binary-new' });
  assert.equal(prototype.conventionKnown, false);
  assert.equal(prototype.abiIdentity, null);
  assert.deepEqual(prototype.arguments, []);
});

test('C3-02 malformed canonical provenance cannot publish a supported prototype', () => {
  const canonical = semanticAbiAdapter(AAPCS64_ABI);
  const malformed = {
    ...canonical,
    provenance:{ ...canonical.provenance, source:'manual-decompiler-abi' },
  };
  const prototype = recover(malformed, ['x0']);
  assert.equal(prototype.conventionKnown, false);
  assert.deepEqual(prototype.arguments, []);
});

test('C3-02 nested snapshot and schema identity mismatches invalidate ABI evidence', () => {
  const adapter = semanticAbiAdapter(AAPCS64_ABI, {
    binaryId:'binary-c3-02', snapshotId:'snapshot-old', schemaVersion:'abi-v1',
  });
  const snapshotMismatch = recover(adapter, ['x0'], {}, {
    snapshotId:'snapshot-new', schemaVersion:'abi-v1',
  });
  assert.equal(snapshotMismatch.conventionKnown, false);
  assert.deepEqual(snapshotMismatch.arguments, []);
  const schemaMismatch = recover(adapter, ['x0'], {}, {
    snapshotId:'snapshot-old', schemaVersion:'abi-v2',
  });
  assert.equal(schemaMismatch.conventionKnown, false);
  assert.deepEqual(schemaMismatch.arguments, []);
});

test('C3-02 every nested identity record is validated before publication', () => {
  const canonical = semanticAbiAdapter(AAPCS64_ABI, {
    architecture:'arm64', platform:'linux', binaryId:'binary-c3-02', sliceId:'slice-c3-02',
    functionId:'function-c3-02', snapshotId:'snapshot-c3-02', schemaVersion:'abi-v1',
    analyzerId:'analyzer-c3-02', analyzerVersion:'1.0.0',
  });
  const tampered = [
    {
      ...canonical,
      identity:{ ...canonical.identity,
        architectureProfile:{ ...canonical.identity.architectureProfile, semanticIdentity:'tampered-profile' } },
    },
    {
      ...canonical,
      provenance:{ ...canonical.provenance,
        architectureProfile:{ ...canonical.provenance.architectureProfile, platform:'tampered-platform' } },
    },
    {
      ...canonical,
      invalidation:{ ...canonical.invalidation,
        architectureProfile:{ ...canonical.invalidation.architectureProfile, abiId:'tampered-abi' } },
    },
    { ...canonical, identity:{ ...canonical.identity, snapshotId:'tampered-snapshot' } },
    { ...canonical, invalidation:{ ...canonical.invalidation, analyzerVersion:'tampered-analyzer' } },
  ];
  for (const adapter of tampered) {
    const prototype = recover(adapter, ['x0']);
    assert.equal(prototype.conventionKnown, false);
    assert.deepEqual(prototype.arguments, []);
    assert.deepEqual(prototype.returnLocations, []);
  }
});

test('C3-02 aggregate returns keep full canonical locations and reject scalar collapse', () => {
  const adapter = semanticAbiAdapter(AAPCS64_ABI);
  const functionPrototype = { returnType:'struct Pair', aggregate:true, bits:128, returnsValue:true };
  assert.deepEqual(adapter.returnLocations({ functionPrototype }).map(({ reg, pieceIndex }) => ({ reg, pieceIndex })), [
    { reg:'x0', pieceIndex:0 }, { reg:'x1', pieceIndex:1 },
  ]);
  assert.equal(adapter.returnRegister({ returnType:'struct Pair', functionPrototype }), null);
  const partial = semanticAbiAdapter(AAPCS64_ABI, { callPrototype:{
    parameters:[{ type:'int64', bits:64 }], variadic:true,
    returnType:'struct Pair', aggregate:true, bits:128, returnsValue:true,
  } }).classifyCall({ call:{} });
  assert.equal(partial.partial, true);
  assert.equal(partial.returnReg, null);
  assert.deepEqual(partial.returnLocations, []);
  assert.equal(partial.arguments.every((argument) => argument.possible === true && argument.mustUse === false), true);
});

test('C3-02 preserves a canonical split register/stack aggregate as one parameter', () => {
  const adapter = semanticAbiAdapter(RISCV_LP64_ABI);
  const parameters = [
    ...Array.from({ length:7 }, () => ({ type:'int64', bits:64 })),
    { type:'struct Pair', aggregate:true, bits:128 },
  ];
  const args = [
    ['x2', value(99, 'x2')],
    ...Array.from({ length:8 }, (_unused, index) => [`x${index + 10}`, value(index, `x${index + 10}`)]),
  ];
  const instructions = [{
    op:'load',
    loc:{ kind:'stack', baseReg:'x2', frameEpoch:99, disp:0n, key:'c3-02:split' },
    memUse:{ kind:'entry' }, dst:{ id:200, bits:64 },
  }];
  const prototype = recoverFunctionPrototype(
    { args:new Map(args), instructions },
    { values:new Map() },
    { abiAdapter:adapter, functionPrototype:{ parameters } },
  );
  const aggregate = prototype.arguments.at(-1);
  assert.equal(aggregate.aggregate, true);
  assert.equal(aggregate.location, 'register-stack');
  assert.deepEqual(aggregate.regs, ['x17']);
  assert.deepEqual(aggregate.pieces.map(({ reg, stackOffset }) => ({ reg, stackOffset })), [
    { reg:'x17', stackOffset:undefined }, { reg:null, stackOffset:0 },
  ]);
  assert.deepEqual(prototype.argumentBanks.stack, []);
});

test('C3-02 Semantic IR call publication retains canonical ABI identity and aggregate pieces', () => {
  const adapter = semanticAbiAdapter(AAPCS64_ABI, {
    architecture:'arm64', platform:'linux', binaryId:'binary-c3-02', sliceId:'slice-c3-02',
    functionId:'fn-c3-02',
    callPrototype:{ parameters:[{ type:'struct Pair', aggregate:true, bits:128 }],
      returnType:'struct Pair', aggregate:true, bits:128, returnsValue:true },
  });
  const origin = (id) => ({ instructionIds:[id], virtualRanges:[{ start:0x1000n, end:0x1004n }] });
  const arg = {
    id:'arg', kind:'entry', machineType:{ kind:'bitvector', widthBits:64 },
    sourceEntityId:'fn-c3-02', variableKey:'state:x0', origin:origin('arg'),
  };
  const result = {
    id:'result', kind:'definition', definitionNodeId:'call',
    machineType:{ kind:'bitvector', widthBits:64 }, sourceEntityId:'call',
    variableKey:'state:result', origin:origin('call'),
  };
  const ir = {
    schemaVersion:2, contractVersion:'2.0.0', functionId:'fn-c3-02', entryBlockId:'b0',
    blocks:[{ id:'b0', nodeIds:['call'], origin:origin('block') }],
    values:[arg, result], completeness:'complete', unknowns:[], origin:origin('function'),
    nodes:[{
      id:'call', kind:'call', blockId:'b0', inputs:['arg'], outputs:['result'],
      call:{ targetValueIds:[], targetEntityIds:['callee'], arguments:['arg'], returns:['result'],
        stateReads:[], stateWrites:[], memoryRead:{ scope:'none' }, memoryWrite:{ scope:'none' },
        controlEffects:[{ kind:'call' }], determinism:'deterministic', noreturn:false,
        mayThrow:false, summarySource:'known-callee', completeness:'complete', unknownEffects:null,
      }, origin:origin('call'),
    }],
  };
  const projected = projectSemanticIrV2ToLegacyV1(ir, { abiAdapter:adapter });
  const call = projected.instructions.find((instruction) => instruction.semanticNodeId === 'call');
  assert.ok(call);
  assert.equal(call.extra.abiSemanticIdentity, 'aapcs64@2');
  assert.equal(call.extra.abiInvalidation.binaryId, 'binary-c3-02');
  assert.deepEqual(call.callArguments[0].regs, ['x0', 'x1']);
  assert.deepEqual(call.extra.returnLocations.map(({ reg, pieceIndex }) => ({ reg, pieceIndex })), [
    { reg:'x0', pieceIndex:0 }, { reg:'x1', pieceIndex:1 },
  ]);

  const partialProjected = projectSemanticIrV2ToLegacyV1(ir, {
    abiAdapter:{
      classifyCall() {
        return {
          callArguments:[], partial:true, completeness:'partial', returnReg:'x0', returnBits:64,
          returnLocations:[{ kind:'register', reg:'x0' }], returnPieces:[{ reg:'x0' }],
        };
      },
    },
  });
  const partialCall = partialProjected.instructions.find((instruction) => instruction.semanticNodeId === 'call');
  assert.equal(partialCall.returnReg ?? null, null);
  assert.equal(partialCall.returnBits ?? null, null);
  assert.deepEqual(partialCall.extra.returnLocations, []);
  assert.equal(partialCall.extra.returnPieces, null);

  const aggregateProjected = projectSemanticIrV2ToLegacyV1(ir, {
    abiAdapter:{
      classifyCall() {
        return {
          callArguments:[], completeness:'complete', returnReg:'x0', returnBits:128,
          returnAggregate:true,
          returnLocations:[
            { kind:'register', reg:'x0', aggregate:true, pieceIndex:0 },
            { kind:'register', reg:'x1', aggregate:true, pieceIndex:1 },
          ],
          returnPieces:[{ reg:'x0' }, { reg:'x1' }],
        };
      },
    },
  });
  const aggregateCall = aggregateProjected.instructions.find((instruction) => instruction.semanticNodeId === 'call');
  assert.equal(aggregateCall.returnReg ?? null, null);
  assert.deepEqual(aggregateCall.extra.returnLocations.map(({ reg, pieceIndex }) => ({ reg, pieceIndex })), [
    { reg:'x0', pieceIndex:0 }, { reg:'x1', pieceIndex:1 },
  ]);

  const oneLaneAggregateProjected = projectSemanticIrV2ToLegacyV1(ir, {
    abiAdapter:{
      classifyCall() {
        return {
          callArguments:[], completeness:'complete', returnReg:'x0', returnBits:64,
          returnAggregate:true,
          returnLocations:[{ kind:'register', reg:'x0', aggregate:false, pieceIndex:0 }],
          returnPieces:[{ reg:'x0' }],
        };
      },
    },
  });
  const oneLaneAggregateCall = oneLaneAggregateProjected.instructions.find((instruction) => instruction.semanticNodeId === 'call');
  assert.equal(oneLaneAggregateCall.returnReg ?? null, null);
  assert.deepEqual(oneLaneAggregateCall.extra.returnLocations.map(({ reg, pieceIndex }) => ({ reg, pieceIndex })), [
    { reg:'x0', pieceIndex:0 },
  ]);
});
