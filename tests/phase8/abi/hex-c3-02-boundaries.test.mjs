import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';
import { recoverFunctionPrototype } from '../../../js/decompiler/types/prototype.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { classifyCallArguments } from '../../../js/ir-core.js';
import {
  AAPCS64_ABI, DARWIN_ARM64_ABI, SYSV_AMD64_ABI, MICROSOFT_X64_ABI,
  MICROSOFT_VECTORCALL_ABI, RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI,
  ABIPlugin, abiPluginRegistryDigest, abiPluginRegistryGeneration,
  registerABIPlugin, resolveABIPlugin, UNKNOWN_ABI,
} from '../../../js/targets/abi/index.js';
import { abiPhysicalIntervalsValid, normalizeAbiPieces } from '../../../js/targets/abi/evidence.js';
import { canonicalAggregateLayout } from '../../../js/targets/abi/aggregate-layout.js';

function value(id, reg) { return { id, reg, uses:[{}] }; }

function recover(adapter, registers = ['x0'], types = {}, opts = {}) {
  return recoverFunctionPrototype(
    { args:new Map(registers.map((reg, index) => [reg, value(index + 1, reg)])), instructions:[] },
    { values:new Map(), ...types },
    { ...opts, abiAdapter:adapter },
  );
}

function classifierStateAdapter(state) {
  const base = semanticAbiAdapter(AAPCS64_ABI, { architecture:'arm64', platform:'linux' });
  const flag = state.startsWith('flag:') ? state.slice('flag:'.length) : null;
  const annotate = (result) => result
    ? flag ? { ...result, [flag]:true } : { ...result, status:state, completeness:state }
    : result;
  return {
    ...base,
    classifyArguments(input) {
      const result = base.classifyArguments(input);
      return annotate(result);
    },
    classifyFunctionReturn(input) {
      const result = base.classifyFunctionReturn(input);
      return annotate(result);
    },
  };
}

test('C3-02 canonical adapter carries one ABI identity through classification', () => {
  const adapter = semanticAbiAdapter(AAPCS64_ABI, {
    architecture:'arm64', platform:'linux', binaryId:'binary-c3-02',
    sliceId:'slice-c3-02', functionId:'fn-c3-02',
  });
  const pair = { type:'struct Pair', aggregate:true, bits:128,
    members:[{ type:'uint64', bits:64, byteOffset:0 }, { type:'uint64', bits:64, byteOffset:8 }] };
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
    location:'unknown', possible:true, mustUse:false, exact:false, certainty:'unknown',
    reason:'anonymous-vararg-frontier-not-source-prototyped',
  });
});

test('C3-02 invalidated evidence never publishes exact prototype facts', () => {
  const cases = [
    ['cancelled', { cancelled:true }],
    ['deadline', { deadlineExceeded:true }],
    ['truncated', { truncated:true }],
    ['budget', { budgetExhausted:true }],
    ['budget-limited', { budgetLimited:true }],
    ['incomplete', { completeness:'incomplete' }],
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

test('C3-02 every classifier terminal state rejects ABI publication', () => {
  const states = [
    'stale', 'partial', 'incomplete', 'unsupported', 'malformed', 'cancelled',
    'budget-exhausted', 'budget-limited', 'deadline', 'truncated',
    'flag:partial', 'flag:unsupported', 'flag:malformedEvidence', 'flag:cancelled',
    'flag:deadlineExceeded', 'flag:truncated', 'flag:budgetExhausted', 'flag:budgetLimited',
  ];
  for (const state of states) {
    const prototype = recover(
      classifierStateAdapter(state), ['x0'], { ret:{ type:'int64', bits:64 } },
      { functionPrototype:{ parameters:[{ type:'int64', bits:64 }] } },
    );
    assert.equal(prototype.conventionKnown, false, `${state} must reject the profile`);
    assert.equal(prototype.abiIdentity, null, `${state} must not publish identity`);
    assert.deepEqual(prototype.arguments, [], `${state} must not publish arguments`);
    assert.deepEqual(prototype.returnLocations, [], `${state} must not publish returns`);
  }
});

test('C3-02 adapter publication rejects every terminal classifier state', () => {
  const states = [
    'stale', 'partial', 'incomplete', 'unsupported', 'malformed', 'cancelled',
    'canceled', 'cancellation', 'budget', 'budget-exhausted', 'budget-limited',
    'resource-budget-limited', 'deadline', 'deadline-exceeded', 'deadline-expired',
    'truncated', 'timeout', 'timed-out',
  ];
  for (const state of states) {
    const adapter = semanticAbiAdapter(AAPCS64_ABI, {
      architecture:'arm64', platform:'linux', status:state,
    });
    const functionPrototype = { parameters:[{ type:'int64', bits:64 }],
      returnType:'int64', returnBits:64, returnsValue:true };
    assert.equal(adapter.classifyArguments({ functionPrototype }), null, `${state} arguments`);
    assert.equal(adapter.classifyFunctionReturn({ functionPrototype }), null, `${state} return`);
    assert.deepEqual(adapter.argumentLocations({ functionPrototype }), [], `${state} argument locations`);
    assert.deepEqual(adapter.returnLocations({ functionPrototype }), [], `${state} return locations`);
  }
});

test('C3-02 malformed aggregate pieces never fill missing or overlapping lanes', () => {
  const pair = { returnType:'struct Pair', aggregate:true, bits:128, returnsValue:true,
    members:[{ type:'uint64', bits:64, byteOffset:0 }, { type:'uint64', bits:64, byteOffset:8 }] };
  const canonical = semanticAbiAdapter(AAPCS64_ABI, { architecture:'arm64', platform:'linux' });
  const returned = canonical.classifyFunctionReturn({ functionPrototype:pair });
  const malformedPieces = [
    returned.pieces.map((piece) => ({ ...piece, bits:undefined })),
    returned.pieces.map((piece) => ({ ...piece, bytes:undefined })),
    returned.pieces.map((piece, index) => index ? { ...piece, byteOffset:16 } : piece),
    returned.pieces.map((piece, index) => index ? { ...piece, byteOffset:4 } : piece),
    returned.pieces.map((piece, index) => index ? { ...piece, pieceIndex:0 } : piece),
    returned.pieces.map((piece) => { const { byteOffset:unused, ...rest } = piece; return rest; }),
    returned.pieces.map((piece) => { const { order:unused, ...rest } = piece; return rest; }),
    returned.pieces.map((piece) => { const { abiClass:unused, ...rest } = piece; return rest; }),
    returned.pieces.map((piece, index) => index ? { ...piece, abiClass:'' } : piece),
    returned.pieces.map((piece, index) => index ? { ...piece, reg:null, stackOffset:null } : piece),
  ];
  for (const pieces of malformedPieces) {
    const adapter = {
      ...canonical,
      classifyFunctionReturn() { return { ...returned, pieces }; },
    };
    const prototype = recover(adapter, ['x0', 'x1'], { ret:pair });
    assert.deepEqual(prototype.returnLocations, [], 'malformed aggregate evidence must be unknown');
    assert.equal(prototype.returnLocationKnown, false);
  }
});

test('C3-02 aggregate register lists without canonical pieces are not exact', () => {
  const pair = { returnType:'struct Pair', aggregate:true, bits:128, returnsValue:true,
    members:[{ type:'uint64', bits:64, byteOffset:0 }, { type:'uint64', bits:64, byteOffset:8 }] };
  const canonical = semanticAbiAdapter(AAPCS64_ABI, { architecture:'arm64', platform:'linux' });
  const returned = canonical.classifyFunctionReturn({ functionPrototype:pair });
  const { pieces:unusedPieces, parts:unusedParts, ...withoutPieces } = returned;
  const adapter = {
    ...canonical,
    classifyFunctionReturn() { return withoutPieces; },
  };
  const prototype = recover(adapter, ['x0', 'x1'], { ret:pair });
  assert.deepEqual(prototype.returnLocations, []);
  assert.equal(prototype.returnLocationKnown, false);

  const parameter = { type:'struct Pair', aggregate:true, bits:128,
    members:[{ type:'uint64', bits:64, byteOffset:0 }, { type:'uint64', bits:64, byteOffset:8 }] };
  const classified = canonical.classifyArguments({ functionPrototype:{ parameters:[parameter] } });
  const { pieces:unusedArgumentPieces, parts:unusedArgumentParts, ...argumentWithoutPieces } = classified.arguments[0];
  const argumentAdapter = {
    ...canonical,
    classifyArguments() {
      return { ...classified, arguments:[argumentWithoutPieces] };
    },
  };
  const argumentPrototype = recover(argumentAdapter, ['x0', 'x1'], {}, {
    functionPrototype:{ parameters:[parameter] },
  });
  assert.deepEqual(argumentPrototype.arguments, []);
});

test('C3-02 malformed aggregate argument pieces never create a prototype parameter', () => {
  const parameter = { type:'struct Pair', aggregate:true, bits:128,
    members:[{ type:'uint64', bits:64, byteOffset:0 }, { type:'uint64', bits:64, byteOffset:8 }] };
  const canonical = semanticAbiAdapter(AAPCS64_ABI, { architecture:'arm64', platform:'linux' });
  const classified = canonical.classifyArguments({ functionPrototype:{ parameters:[parameter] } });
  const malformed = classified.arguments[0].pieces.map((piece, index) => index
    ? { ...piece, byteOffset:16 }
    : piece);
  const adapter = {
    ...canonical,
    classifyArguments() {
      return { ...classified, arguments:[{ ...classified.arguments[0], pieces:malformed }] };
    },
  };
  const prototype = recover(adapter, ['x0', 'x1'], {}, { functionPrototype:{ parameters:[parameter] } });
  assert.deepEqual(prototype.arguments, []);
});

test('C3-02 hidden sret requires complete pointer, location, and profile proof', () => {
  const big = { returnType:'struct Big', aggregate:true, bits:256, returnsValue:true,
    members:Array.from({ length:4 }, (_unused, index) => ({ type:'uint64', bits:64, byteOffset:index * 8 })) };
  const canonical = semanticAbiAdapter(AAPCS64_ABI, { architecture:'arm64', platform:'linux' });
  const returned = canonical.classifyFunctionReturn({ functionPrototype:big });
  const tampered = [
    { ...returned, hiddenResultPointer:{ ...returned.hiddenResultPointer, location:undefined } },
    { ...returned, hiddenResultPointer:{ ...returned.hiddenResultPointer, input:'x9' } },
    { ...returned, hiddenResultPointer:{ ...returned.hiddenResultPointer, profileIdentity:'wrong-profile' } },
    { ...returned, hiddenResultPointer:{ ...returned.hiddenResultPointer,
      provenance:{ ...returned.hiddenResultPointer.provenance, abiId:'wrong-abi' } } },
    { ...returned, hiddenResultPointer:{ ...returned.hiddenResultPointer,
      invalidation:{ ...returned.hiddenResultPointer.invalidation, snapshotId:'stale-snapshot' } } },
    { ...returned, resultLocation:'register' },
    { ...returned, invalidation:{ ...returned.invalidation, snapshotId:'stale-snapshot' } },
  ];
  for (const result of tampered) {
    const adapter = { ...canonical, classifyFunctionReturn() { return result; } };
    const prototype = recover(adapter, ['x8'], { ret:big });
    assert.deepEqual(prototype.returnLocations, []);
    assert.equal(prototype.indirectResult, false);
  }
});

test('C3-02 HFA/HVA without member layout stays partial for every supported profile', () => {
  const cases = [
    [AAPCS64_ABI, { type:'struct H', hfa:true, bits:128 }],
    [DARWIN_ARM64_ABI, { type:'struct H', hfa:true, bits:128 }],
    [MICROSOFT_VECTORCALL_ABI, { type:'struct H', hva:true, bits:256 }],
    [AAPCS64_ABI, { type:'struct H', hfa:true, members:4, bits:128 }],
    [DARWIN_ARM64_ABI, { type:'struct H', hfa:true, members:4, bits:128 }],
    [MICROSOFT_VECTORCALL_ABI, { type:'struct H', hva:true, members:4, bits:256 }],
  ];
  for (const [abi, parameter] of cases) {
    const result = abi.classifyArguments({ callPrototype:{ parameters:[parameter] } });
    assert.equal(result.partial, true);
    assert.equal(result.arguments[0].possible, true);
    assert.equal(Array.isArray(result.arguments[0].regs), false);
    const returned = abi.classifyFunctionReturn({
      functionPrototype:{ ...parameter, returnType:parameter.type, returnBits:parameter.bits, returnsValue:true },
    });
    assert.equal(returned.partial, true);
    assert.equal(returned.indirect, undefined);
  }
});

test('C3-02 whole-spilled AAPCS aggregate retains an explicit canonical stack piece', () => {
  const parameters = [
    ...Array.from({ length:7 }, () => ({ type:'uint64_t', bits:64 })),
    { type:'struct Pair', aggregate:true, bits:128,
      members:[{ type:'uint64', bits:64, byteOffset:0 }, { type:'uint64', bits:64, byteOffset:8 }] },
  ];
  const result = AAPCS64_ABI.classifyArguments({ callPrototype:{ parameters } });
  const aggregate = result.arguments.at(-1);
  assert.equal(aggregate.location, 'stack');
  assert.equal(aggregate.bytes, 16);
  assert.deepEqual(aggregate.pieces, [{
    pieceIndex:0, order:0, stackOffset:0, bits:128, bytes:16,
    byteOffset:0, abiClass:'aggregate',
  }]);
});

test('C3-02 v2 compatibility rejects identity-less ABI and legacy core keeps fallback presentation-only', () => {
  const core = fs.readFileSync(new URL('../../../js/decompiler/semantic-core.js', import.meta.url), 'utf8');
  assert.match(core, /v2->v1 compatibility projection is architecture-neutral/);
  assert.match(core, /if \(ctx\.ir\?\.compat\?\.projection === 'semantic-ir-v2-to-v1'\) return null/);
  assert.match(core, /Legacy AArch64 IR has no ABI envelope/);
  const compat = fs.readFileSync(new URL('../../../js/ir-core.js', import.meta.url), 'utf8');
  assert.match(compat, /Legacy v1 region-root presentation/);
  assert.match(compat, /abiAdapter\?\.id.*aapcs64/);
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
  const functionPrototype = { returnType:'struct Pair', aggregate:true, bits:128, returnsValue:true,
    members:[{ type:'uint64', bits:64, byteOffset:0 }, { type:'uint64', bits:64, byteOffset:8 }] };
  assert.deepEqual(adapter.returnLocations({ functionPrototype }).map(({ reg, pieceIndex }) => ({ reg, pieceIndex })), [
    { reg:'x0', pieceIndex:0 }, { reg:'x1', pieceIndex:1 },
  ]);
  assert.equal(adapter.returnRegister({ returnType:'struct Pair', functionPrototype }), null);
  const partial = semanticAbiAdapter(AAPCS64_ABI, { callPrototype:{
    parameters:[{ type:'int64', bits:64 }], variadic:true,
    returnType:'struct Pair', aggregate:true, bits:128, returnsValue:true,
    members:[{ type:'uint64', bits:64, byteOffset:0 }, { type:'uint64', bits:64, byteOffset:8 }],
  } }).classifyCall({ call:{} });
  assert.equal(partial.partial, true);
  assert.equal(partial.returnReg, null);
  assert.deepEqual(partial.returnLocations, []);
  const fixedPrefix = partial.arguments.find((argument) => argument.index === 0);
  const anonymousCandidate = partial.arguments.find((argument) => argument.index == null);
  assert.equal(fixedPrefix?.possible ?? null, false);
  assert.equal(fixedPrefix?.mustUse ?? null, true);
  assert.equal(anonymousCandidate?.possible ?? null, true);
  assert.equal(anonymousCandidate?.mustUse ?? null, false);
});

test('C3-02 SysV aggregate return lanes retain physical eightbyte width at tail boundaries', () => {
  const returnAggregate = {
    bits:96,
    bytes:16,
    members:[
      { type:'uint64', bits:64, bytes:8, byteOffset:0 },
      { type:'uint32', bits:32, bytes:4, byteOffset:8 },
    ],
    padding:[{ byteOffset:12, bytes:4 }],
    eightbyteClasses:['INTEGER','INTEGER'],
  };
  const adapter = semanticAbiAdapter(SYSV_AMD64_ABI, { architecture:'x86_64', platform:'linux' });
  const locations = adapter.returnLocations({ functionPrototype:{
    returnType:'struct TailPadded', aggregate:true, bits:96, returnsValue:true,
    returnAggregate,
  } });
  assert.deepEqual(locations.map(({ reg, bits, bytes, byteOffset }) => ({ reg, bits, bytes, byteOffset })), [
    { reg:'rax', bits:64, bytes:8, byteOffset:0 },
    { reg:'rdx', bits:32, bytes:8, byteOffset:8 },
  ]);

  const underfilled = adapter.returnLocations({ functionPrototype:{
    returnType:'struct InvalidTail', aggregate:true, bits:64, returnsValue:true,
    returnAggregate:{ ...returnAggregate, bits:64 },
  } });
  assert.deepEqual(underfilled, [], 'a two-lane class list must not invent a one-bit tail lane');
});

test('C3-02 aggregate arguments and returns require proven size/layout on AAPCS64, Darwin, and RISC-V', () => {
  const profiles = [AAPCS64_ABI, DARWIN_ARM64_ABI, RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI];
  for (const abi of profiles) {
    const parameter = { type:'struct UnknownAggregate', aggregate:true };
    const argumentsResult = abi.classifyArguments({ callPrototype:{ parameters:[parameter] } });
    assert.equal(argumentsResult?.partial, true, `${abi.id} aggregate argument must be partial`);
    assert.equal(argumentsResult?.arguments?.[0]?.location, 'unknown', `${abi.id} aggregate argument must be unknown`);
    assert.equal('reg' in (argumentsResult?.arguments?.[0] || {}), false, `${abi.id} must not invent a scalar register`);
    assert.equal('regs' in (argumentsResult?.arguments?.[0] || {}), false, `${abi.id} must not invent aggregate registers`);
    const vectorAggregate = abi.classifyArguments({ callPrototype:{ parameters:[{
      type:'struct VectorAggregate', aggregate:true, vector:true,
    }] } });
    assert.equal(vectorAggregate?.partial, true, `${abi.id} vector aggregate must remain unproven`);
    assert.equal(vectorAggregate?.arguments?.[0]?.location, 'unknown');

    const returnResult = abi.classifyFunctionReturn({
      functionPrototype:{ returnType:'struct UnknownAggregate', aggregate:true, returnsValue:true },
    });
    assert.equal(returnResult?.partial, true, `${abi.id} aggregate return must be partial`);
    assert.equal(returnResult?.reg ?? null, null, `${abi.id} aggregate return must not expose a scalar register`);
    assert.equal(returnResult?.regs?.length ?? 0, 0, `${abi.id} aggregate return must not expose register lanes`);
  }
});

test('C3-02 hard-float RISC-V aggregates require explicit member offsets before flattening', () => {
  const aggregate = {
    type:'struct Mixed', aggregate:true, bits:64,
    members:[{ type:'float', bits:32 }, { type:'int32', bits:32 }],
  };
  for (const abi of [RISCV_LP64F_ABI, RISCV_LP64D_ABI]) {
    const argumentsResult = abi.classifyArguments({ callPrototype:{ parameters:[aggregate] } });
    assert.equal(argumentsResult?.partial, true, `${abi.id} must not pack members without offsets`);
    assert.equal(argumentsResult?.arguments?.[0]?.location, 'unknown');
    const returnResult = abi.classifyFunctionReturn({
      functionPrototype:{ ...aggregate, returnType:'struct Mixed', returnsValue:true },
    });
    assert.equal(returnResult?.partial, true, `${abi.id} return must reject missing member offsets`);
    assert.equal(returnResult?.reg ?? null, null);
  }
});

test('C3-02 hidden sret consumers reject partial and budget-limited canonical results', () => {
  const base = semanticAbiAdapter(AAPCS64_ABI, { architecture:'arm64', platform:'linux' });
  const prototype = { returnType:'struct Large', aggregate:true, bits:256, returnsValue:true,
    members:Array.from({ length:4 }, (_unused, index) => ({ type:'uint64', bits:64, byteOffset:index * 8 })) };
  const complete = base.classifyFunctionReturn({ functionPrototype:prototype });
  assert.equal(complete?.indirect, true);
  for (const state of [{ partial:true }, { budgetLimited:true }, { status:'budget-limited' }]) {
    const adapter = {
      ...base,
      classifyFunctionReturn() { return { ...complete, ...state }; },
    };
    assert.deepEqual(adapter.returnLocations({ classified:{ ...complete, ...state } }), []);
    const recovered = recover(adapter, ['x8'], { ret:{ type:'struct Large', aggregate:true, bits:256,
      members:Array.from({ length:4 }, (_unused, index) => ({ type:'uint64', bits:64, byteOffset:index * 8 })) } });
    assert.equal(recovered.indirectResult, false);
    assert.equal(recovered.indirectResultRegister, null);
    assert.deepEqual(recovered.returnLocations, []);
  }
});

test('C3-02 explicit hidden-sret probes cannot bypass cancellation or budget invalidation', () => {
  const adapter = semanticAbiAdapter(AAPCS64_ABI, { architecture:'arm64', platform:'linux' });
  const large = { type:'struct Large', aggregate:true, bits:256, returnsValue:true,
    members:Array.from({ length:4 }, (_unused, index) => ({ type:'uint64', bits:64, byteOffset:index * 8 })) };
  for (const state of [{ cancelled:true }, { budgetExhausted:true }, { budgetLimited:true }]) {
    const recovered = recover(adapter, ['x8'], { ret:large }, { ...state, indirectResult:true });
    assert.equal(recovered.indirectResult, false, `${JSON.stringify(state)} must not publish hidden sret`);
    assert.equal(recovered.indirectResultRegister, null, `${JSON.stringify(state)} must not publish its register`);
    assert.deepEqual(recovered.returnLocations, [], `${JSON.stringify(state)} must remain conservative`);
    assert.equal(recovered.conventionKnown, false, `${JSON.stringify(state)} must invalidate the ABI context`);
  }
});

test('C3-02 known variadic prefix stays exact while anonymous frontier remains conservative', () => {
  const adapter = semanticAbiAdapter(AAPCS64_ABI, { architecture:'arm64', platform:'linux' });
  const functionPrototype = {
    parameters:[{ type:'int64', bits:64 }],
    variadic:true,
  };
  const recovered = recover(adapter, ['x0', 'x1'], {}, { functionPrototype });
  assert.equal(recovered.variadic, true);
  assert.equal(recovered.arguments.length, 1);
  assert.equal(recovered.arguments[0].reg, 'x0');
  assert.equal(recovered.arguments[0].possible ?? false, false);
  assert.equal(recovered.arguments[0].mustUse ?? true, true);
  assert.ok(recovered.anonymousArgumentFrontier);

  const classified = adapter.classifyCall({ call:{ callPrototype:functionPrototype } });
  const fixed = classified.arguments.find((argument) => argument.index === 0);
  const tail = classified.arguments.find((argument) => argument.index == null);
  assert.equal(fixed?.possible ?? null, false);
  assert.equal(fixed?.mustUse ?? null, true);
  assert.equal(tail?.possible ?? null, true);
  assert.equal(tail?.mustUse ?? null, false);
});

test('C3-02 Darwin arm64 requires an explicit platform/profile identity', () => {
  const architectureOnly = semanticAbiAdapter(DARWIN_ARM64_ABI, { architecture:'arm64' });
  assert.equal(architectureOnly.supported, false);
  assert.equal(recover(architectureOnly, ['x0']).conventionKnown, false);
  const explicitDarwin = semanticAbiAdapter(DARWIN_ARM64_ABI, { architecture:'arm64', platform:'darwin' });
  assert.equal(explicitDarwin.supported, true);
  assert.equal(recover(explicitDarwin, ['x0']).conventionKnown, true);
});

test('C3-02 preserves a canonical split register/stack aggregate as one parameter', () => {
  const adapter = semanticAbiAdapter(RISCV_LP64_ABI);
  const parameters = [
    ...Array.from({ length:7 }, () => ({ type:'int64', bits:64 })),
    { type:'struct Pair', aggregate:true, bits:128,
      members:[{ type:'uint64', bits:64, byteOffset:0 }, { type:'uint64', bits:64, byteOffset:8 }] },
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
    callPrototype:{ parameters:[{ type:'struct Pair', aggregate:true, bits:128,
      members:[{ type:'uint64', bits:64, byteOffset:0 }, { type:'uint64', bits:64, byteOffset:8 }] }],
      returnType:'struct Pair', aggregate:true, bits:128, returnsValue:true,
      members:[{ type:'uint64', bits:64, byteOffset:0 }, { type:'uint64', bits:64, byteOffset:8 }] },
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

  const canonicalCall = adapter.classifyCall({ call:{} });
  const canonicalArgument = canonicalCall.arguments.find((argument) => argument.index === 0);
  const malformedArgument = {
    ...canonicalArgument,
    pieces:canonicalArgument.pieces.map((piece, index) => index === 1
      ? { ...piece, byteOffset:piece.byteOffset + 1 }
      : piece),
  };
  const malformedArgumentProjected = projectSemanticIrV2ToLegacyV1(ir, {
    abiAdapter:{
      classifyCall() {
        return { ...canonicalCall, arguments:[malformedArgument] };
      },
    },
  });
  const malformedArgumentCall = malformedArgumentProjected.instructions.find((instruction) => instruction.semanticNodeId === 'call');
  assert.equal(malformedArgumentCall.callArguments ?? null, null, 'compatibility must reject aggregate byte gaps');

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
  assert.deepEqual(partialCall.extra.returnLocations ?? [], []);
  assert.equal(partialCall.extra.returnPieces ?? null, null);

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
  assert.deepEqual(aggregateCall.extra.returnLocations ?? [], []);
  assert.equal(aggregateCall.extra.returnPieces ?? null, null);

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
  assert.deepEqual(oneLaneAggregateCall.extra.returnLocations ?? [], []);
  assert.equal(oneLaneAggregateCall.extra.returnPieces ?? null, null);
});

test('C3-02 bits alone never proves a small aggregate on AAPCS64, Darwin, or RISC-V', () => {
  const profiles = [AAPCS64_ABI, DARWIN_ARM64_ABI, RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI];
  for (const abi of profiles) {
    const aggregate = { type:'struct BitsOnly', aggregate:true, bits:128 };
    const argumentsResult = abi.classifyArguments({ callPrototype:{ parameters:[aggregate] } });
    assert.equal(argumentsResult?.partial, true, `${abi.id} bits-only argument must remain partial`);
    assert.equal(argumentsResult?.arguments?.[0]?.location, 'unknown', `${abi.id} bits-only argument must be unknown`);
    const returnResult = abi.classifyFunctionReturn({
      functionPrototype:{ ...aggregate, returnType:'struct BitsOnly', returnsValue:true },
    });
    assert.equal(returnResult?.partial, true, `${abi.id} bits-only return must remain partial`);
    assert.equal(returnResult?.reg ?? null, null, `${abi.id} bits-only return must not expose a register`);
    assert.equal(returnResult?.regs?.length ?? 0, 0, `${abi.id} bits-only return must not expose lanes`);
  }
});

test('C3-02 aggregate normalization rejects duplicate, overlapping, and misaligned physical stack lanes', () => {
  const base = {
    aggregate:true, bits:128, bytes:16, alignment:8,
    pieceClasses:['aggregate-memory', 'aggregate-memory'],
  };
  const piece = (stackOffset, byteOffset) => ({
    pieceIndex:byteOffset / 8, order:byteOffset / 8, stackOffset,
    bits:64, bytes:8, byteOffset, abiClass:'aggregate-memory',
  });
  assert.equal(normalizeAbiPieces(base, [piece(0, 0), piece(0, 8)]), null);
  assert.equal(normalizeAbiPieces(base, [piece(0, 0), piece(4, 8)]), null);
});

test('C3-02 known variadic RISC-V profiles preserve the named prefix and anonymous frontier', () => {
  for (const abi of [RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI]) {
    const result = abi.classifyArguments({ callPrototype:{
      parameters:[{ type:'int64', bits:64 }], variadic:true,
    } });
    assert.equal(result?.partial, true, `${abi.id} variadic classification must be partial`);
    assert.equal(result?.completeness, 'partial', `${abi.id} variadic completeness must be partial`);
    const fixed = result?.arguments?.find((entry) => entry.index === 0);
    assert.equal(fixed?.reg, 'x10', `${abi.id} fixed prefix must retain a0`);
    assert.equal(fixed?.possible ?? null, false, `${abi.id} fixed prefix must be exact`);
    assert.equal(fixed?.mustUse ?? null, true, `${abi.id} fixed prefix must be required`);
    const frontier = result?.arguments?.find((entry) => entry.index == null);
    assert.equal(frontier?.possible ?? null, true, `${abi.id} must expose anonymous candidates`);
    assert.equal(frontier?.mustUse ?? null, false, `${abi.id} anonymous candidates must be conservative`);
  }
});

test('C3-02 architecture-only identity never selects an ABI default', () => {
  for (const architecture of ['arm64', 'x86_64', 'riscv64']) {
    const resolved = resolveABIPlugin({ architecture });
    assert.equal(resolved?.id, 'unknown', `${architecture} must require a profile or platform identity`);
  }
});

test('C3-02 unregistered plugin-like adapters cannot publish canonical ABI identity', () => {
  const spoof = {
    id:'aapcs64', semanticVersion:'2', semanticIdentity:'aapcs64@2', architectureId:'arm64',
    classifyArguments:() => ({ arguments:[], partial:false, completeness:'exact' }),
    classifyFunctionReturn:() => null,
  };
  assert.equal(resolveABIPlugin({ abiPlugin:spoof }), UNKNOWN_ABI,
    'resolver must reject an unregistered plugin object, even with copied identity');
  const adapter = semanticAbiAdapter(spoof, { architecture:'arm64', platform:'linux' });
  assert.equal(adapter.supported, false);
  assert.equal(adapter.provenance?.source, 'unregistered-abi-adapter');
  const prototype = recover(adapter, ['x0']);
  assert.equal(prototype.conventionKnown, false);
  assert.deepEqual(prototype.arguments, []);
  assert.deepEqual(prototype.returnLocations, []);
});

test('C3-02 forced-stack homogeneous aggregates use canonical physical element slots', () => {
  const hfa32 = {
    type:'HFA32x2', aggregate:true, hfa:true, elementBits:32, bits:64, bytes:8,
    members:[
      { type:'float', bits:32, bytes:4, byteOffset:0 },
      { type:'float', bits:32, bytes:4, byteOffset:4 },
    ],
  };
  const hfa64 = {
    type:'HFA64x2', aggregate:true, hfa:true, elementBits:64, bits:128, bytes:16,
    members:[
      { type:'double', bits:64, bytes:8, byteOffset:0 },
      { type:'double', bits:64, bytes:8, byteOffset:8 },
    ],
  };
  const hva128 = {
    type:'HVA128x2', aggregate:true, hva:true, elementBits:128, bits:256, bytes:32,
    members:[
      { type:'vector', bits:128, bytes:16, byteOffset:0 },
      { type:'vector', bits:128, bytes:16, byteOffset:16 },
    ],
  };
  for (const [name, aggregate, elementBytes] of [
    ['hfa32', hfa32, 4], ['hfa64', hfa64, 8], ['hva128', hva128, 16],
  ]) {
    const parameters = [
      ...Array.from({ length:8 }, () => ({ type:'int64', bits:64 })),
      ...Array.from({ length:8 }, () => ({ type:'double', bits:64 })),
      aggregate,
      { type:'int64', bits:64 },
    ];
    const classified = AAPCS64_ABI.classifyArguments({ callPrototype:{ parameters } });
    const entry = classified.arguments[16];
    const next = classified.arguments[17];
    assert.equal(entry.location, 'stack', `${name} must be forced to stack`);
    const physicalElementBytes = Math.max(8, elementBytes);
    assert.equal(entry.bytes, physicalElementBytes * aggregate.members.length, `${name} physical size`);
    assert.deepEqual(entry.pieces.map(({ pieceIndex, byteOffset, stackOffset, bytes }) => ({
      pieceIndex, byteOffset, stackOffset, bytes,
    })), aggregate.members.map((_member, piece) => ({
      pieceIndex:piece, byteOffset:piece * physicalElementBytes,
      stackOffset:piece * physicalElementBytes, bytes:physicalElementBytes,
    })), `${name} pieces must use element slots`);
    assert.equal(next.offset, entry.bytes, `${name} next stack argument must not overlap`);
  }
  assert.equal(normalizeAbiPieces({ aggregate:true, bits:64, bytes:16, pieceClasses:['hfa', 'hfa'] }, [
    { pieceIndex:0, order:0, stackOffset:0, bits:32, bytes:8, byteOffset:0, abiClass:'hfa' },
    { pieceIndex:1, order:1, stackOffset:4, bits:32, bytes:8, byteOffset:8, abiClass:'hfa' },
  ]), null, 'contradictory physical HFA placement must fail closed');

  // The same physical proof must survive the consumer-side prototype alias,
  // where each stack load is mapped back to one canonical aggregate parameter.
  const parameters = [
    ...Array.from({ length:8 }, () => ({ type:'int64', bits:64 })),
    ...Array.from({ length:8 }, () => ({ type:'double', bits:64 })),
    hfa32,
    { type:'int64', bits:64 },
  ];
  const instructions = [0, 8, 16].map((disp, index) => ({
    op:'load', loc:{ kind:'stack', baseReg:'sp', frameEpoch:99, disp:BigInt(disp), key:`c3-02:hfa:${index}` },
    memUse:{ kind:'entry' }, dst:{ id:300 + index, bits:64 },
  }));
  const registers = ['sp', ...Array.from({ length:8 }, (_unused, index) => `x${index}`),
    ...Array.from({ length:8 }, (_unused, index) => `v${index}`)];
  const prototype = recoverFunctionPrototype(
    { args:new Map(registers.map((reg, index) => [reg, reg === 'sp' ? value(99, reg) : value(index + 1, reg)])), instructions },
    { values:new Map() },
    { abiAdapter:semanticAbiAdapter(AAPCS64_ABI, { architecture:'arm64', platform:'linux' }),
      functionPrototype:{ parameters } },
  );
  const aggregate = prototype.arguments.find((argument) => argument.canonicalParameterIndex === 16);
  assert.ok(aggregate, 'prototype alias must retain the HFA parameter');
  assert.equal(aggregate.aggregate, true);
  assert.equal(aggregate.canonicalLocation, 'stack');
  assert.deepEqual(aggregate.pieces.map(({ pieceIndex, stackOffset, bytes }) => ({ pieceIndex, stackOffset, bytes })), [
    { pieceIndex:0, stackOffset:0, bytes:8 }, { pieceIndex:1, stackOffset:8, bytes:8 },
  ]);
  assert.equal(prototype.arguments.filter((argument) => argument.canonicalParameterIndex === 16).length, 1);
  assert.equal(prototype.arguments.find((argument) => argument.canonicalParameterIndex === 17)?.stackOffset, 16n);
});

test('C3-02 aggregate layouts require fully located deterministic padding coverage', () => {
  const base = {
    aggregate:true, bits:64, bytes:16,
    members:[
      { type:'uint32', bits:32, bytes:4, byteOffset:0 },
      { type:'uint32', bits:32, bytes:4, byteOffset:4 },
    ],
  };
  assert.equal(canonicalAggregateLayout({ ...base, padding:[{ bytes:8 }] }), null,
    'unlocated trailing padding is not exact physical evidence');
  assert.equal(canonicalAggregateLayout({ ...base, padding:[{ bytes:8 }, { bytes:8 }] }), null,
    'duplicate unlocated padding cannot be ignored');
  assert.equal(canonicalAggregateLayout({ ...base, padding:8 }), null,
    'scalar padding cannot be treated as an exact location');
  assert.deepEqual(canonicalAggregateLayout({ ...base, padding:[{ byteOffset:8, bytes:8 }] })?.padding[0],
    { offset:8, bytes:8, end:16 });
  assert.equal(canonicalAggregateLayout({ ...base, padding:[
    { byteOffset:8, bytes:8 }, { byteOffset:12, bytes:4 },
  ] }), null, 'overlapping located padding must fail');
});

test('C3-02 ABI piece normalization rejects string, unsafe, non-finite, and overflowing stack coordinates', () => {
  const base = { aggregate:true, bits:128, bytes:16, pieceClasses:['aggregate-memory', 'aggregate-memory'] };
  const piece = (stackOffset, byteOffset, overrides = {}) => ({
    pieceIndex:byteOffset / 8, order:byteOffset / 8, stackOffset,
    bits:64, bytes:8, byteOffset, abiClass:'aggregate-memory', ...overrides,
  });
  for (const offset of ['8', '9007199254740992', 9007199254740992, Infinity]) {
    assert.equal(normalizeAbiPieces(base, [piece(0, 0), piece(offset, 8)]), null,
      `unsafe stack offset ${String(offset)} must be rejected`);
  }
  assert.equal(normalizeAbiPieces(base, [piece(Number.MAX_SAFE_INTEGER, 0), piece(Number.MAX_SAFE_INTEGER, 8)]), null,
    'safe offset plus byte span overflow must be rejected');
  assert.equal(normalizeAbiPieces(base, [piece(0, 0, { bytes:'8' }), piece(8, 8)]), null,
    'string physical sizes must be rejected');
  assert.equal(normalizeAbiPieces(base, [piece(0, 0, { byteOffset:'0' }), piece(8, 8)]), null,
    'string logical offsets must be rejected');
});

test('C3-02 duplicate scalar stack evidence invalidates the complete argument result', () => {
  const plugin = AAPCS64_ABI;
  const base = semanticAbiAdapter(plugin, { architecture:'arm64', platform:'linux' });
  const functionPrototype = { parameters:[
    ...Array.from({ length:8 }, () => ({ type:'int64', bits:64 })),
    { type:'int64', bits:64 },
  ] };
  const canonical = base.classifyArguments({ functionPrototype });
  const duplicate = { ...canonical.arguments[8], index:9, offset:canonical.arguments[8].offset };
  const adapter = {
    ...base,
    classifyArguments() {
      return { ...canonical, arguments:[...canonical.arguments, duplicate], stackArguments:[...canonical.stackArguments, duplicate] };
    },
  };
  const instructions = [{
    op:'load', loc:{ kind:'stack', baseReg:'sp', frameEpoch:99, disp:0n, key:'c3-02:duplicate-stack' },
    memUse:{ kind:'entry' }, dst:{ id:401, bits:64 },
  }];
  const registers = ['sp', ...Array.from({ length:8 }, (_unused, index) => `x${index}`)];
  const prototype = recoverFunctionPrototype(
    { args:new Map(registers.map((reg, index) => [reg, value(index + 1, reg)])), instructions },
    { values:new Map() }, { abiAdapter:adapter, functionPrototype },
  );
  assert.equal(prototype.conventionKnown, false);
  assert.deepEqual(prototype.arguments, [], 'ambiguous duplicate stack interval must publish no argument');
  assert.deepEqual(prototype.returnLocations, []);
  assert.equal(abiPhysicalIntervalsValid({
    arguments:[], stackArguments:[],
    returnLocations:[
      { kind:'stack', stackOffset:0, bytes:8 },
      { kind:'stack', stackOffset:0, bytes:8 },
    ],
  }), false, 'ambiguous duplicate return interval must be rejected too');
});

test('C3-02 ABI replacement invalidates stack-layout caches by registered object', () => {
  const id = 'c3-02-cache-lifecycle';
  const make = (firstStackArgumentOffset) => new ABIPlugin({
    id, semanticVersion:'1', semanticIdentity:`${id}@1`, architectureId:'x86_64',
    platformPredicate:() => true,
    classifyArguments:() => {
      const argument = {
        index:0, location:'stack', offset:firstStackArgumentOffset, bytes:8,
        bits:64, abiClass:'integer', possible:false, mustUse:true,
      };
      return {
        srcs:[], arguments:[argument], stackArguments:[argument], stackArgsUnknown:false,
        stackArgsMayContainPointers:false, completeness:'exact', partial:false,
      };
    },
    classifyFunctionReturn:() => null,
    classifyEntryRegister:() => ({ kind:'incoming-register-state' }),
    stackRules:() => ({ firstStackArgumentOffset, argumentSlotBytes:8 }),
  });
  const first = registerABIPlugin(make(8));
  const firstAdapter = semanticAbiAdapter(first, { architecture:'x86_64', platform:'linux' });
  const recoverStack = (adapter, disp) => recoverFunctionPrototype(
    { args:new Map([['rsp', value(99, 'rsp')]]), instructions:[{
      op:'load', loc:{ kind:'stack', baseReg:'rsp', frameEpoch:99, disp:BigInt(disp), key:`c3-02:cache:${disp}` },
      memUse:{ kind:'entry' }, dst:{ id:501 + disp, bits:64 },
    }] }, { values:new Map() }, { abiAdapter:adapter, functionPrototype:{ parameters:[{ type:'int64', bits:64 }] } },
  );
  const before = recoverStack(firstAdapter, 8);
  assert.equal(before.arguments.length, 1);
  const firstDigest = abiPluginRegistryDigest(first);
  const firstGeneration = abiPluginRegistryGeneration(first);

  const replacement = registerABIPlugin(make(64), { replace:true });
  assert.notEqual(abiPluginRegistryDigest(replacement), firstDigest,
    'replacement classifier/rules must get a new registry digest');
  assert.ok(abiPluginRegistryGeneration(replacement) > firstGeneration,
    'replacement must advance the registry generation');
  const replacementAdapter = semanticAbiAdapter(replacement, { architecture:'x86_64', platform:'linux' });
  const after = recoverStack(replacementAdapter, 8);
  assert.equal(after.arguments.length, 0, 'replacement profile must not reuse old stack rules');
  const atReplacementOffset = recoverStack(replacementAdapter, 64);
  assert.equal(atReplacementOffset.arguments.length, 1);
});

test('C3-02 malformed padding never collapses to absent padding evidence', () => {
  const fullyCovered = {
    aggregate:true,
    bits:128,
    bytes:16,
    members:[
      { type:'uint64', bits:64, bytes:8, byteOffset:0 },
      { type:'uint64', bits:64, bytes:8, byteOffset:8 },
    ],
  };
  for (const padding of ['bad', {}, ['bad'], [{}], [{ bytes:'8', byteOffset:8 }]]) {
    assert.equal(canonicalAggregateLayout({ ...fullyCovered, padding }), null,
      `malformed padding ${JSON.stringify(padding)} must not establish exact layout`);
  }
});

test('C3-02 interval validation rejects duplicate object and unproven split evidence globally', () => {
  const scalar = {
    index:0,
    location:'stack',
    stackOffset:0,
    bytes:8,
    possible:false,
    mustUse:true,
  };
  assert.equal(abiPhysicalIntervalsValid({ arguments:[scalar, scalar] }), false,
    'the same scalar evidence object cannot be repeated in one argument list');

  const unprovenSplit = {
    index:0,
    location:'register-stack',
    reg:'x0',
    aggregate:false,
    pieces:[{ reg:'x0', pieceIndex:0, order:0, bits:64, bytes:8, byteOffset:0, abiClass:'integer' },
      { stackOffset:0, pieceIndex:1, order:1, bits:64, bytes:8, byteOffset:8, abiClass:'integer' }],
  };
  assert.equal(abiPhysicalIntervalsValid({
    arguments:[unprovenSplit],
    stackArguments:[unprovenSplit],
  }), false, 'register-stack duplication requires an explicit canonical aggregate split proof');
});

test('C3-02 AAPCS64 aggregate stack extent includes canonical padding', () => {
  const padded = {
    type:'struct Padded',
    aggregate:true,
    bits:64,
    bytes:16,
    members:[{ type:'uint64', bits:64, bytes:8, byteOffset:0 }],
    padding:[{ byteOffset:8, bytes:8 }],
  };
  const result = AAPCS64_ABI.classifyArguments({ callPrototype:{ parameters:[
    ...Array.from({ length:8 }, () => ({ type:'int64', bits:64 })),
    padded,
    { type:'int64', bits:64 },
  ] } });
  const aggregate = result.arguments[8];
  const next = result.arguments[9];
  assert.equal(aggregate.location, 'stack');
  assert.equal(aggregate.bytes, 16, 'physical aggregate size must include trailing padding');
  assert.deepEqual(aggregate.pieces.map(({ byteOffset, stackOffset, bits, bytes }) => ({ byteOffset, stackOffset, bits, bytes })), [
    { byteOffset:0, stackOffset:0, bits:64, bytes:16 },
  ]);
  assert.equal(next.offset, 16, 'the following stack argument must begin after the padded extent');
});

test('C3-02 Darwin forced-stack HVA uses exact 128-bit element extents', () => {
  const hva128 = {
    type:'struct HVA128',
    aggregate:true,
    hva:true,
    bits:256,
    bytes:32,
    elementBits:128,
    members:[
      { type:'vector', bits:128, bytes:16, byteOffset:0 },
      { type:'vector', bits:128, bytes:16, byteOffset:16 },
    ],
  };
  const result = DARWIN_ARM64_ABI.classifyArguments({ callPrototype:{ parameters:[
    ...Array.from({ length:8 }, () => ({ type:'int64', bits:64 })),
    ...Array.from({ length:8 }, () => ({ type:'double', bits:64 })),
    hva128,
    { type:'int64', bits:64 },
  ] } });
  const aggregate = result.arguments[16];
  const next = result.arguments[17];
  assert.equal(aggregate.location, 'stack');
  assert.equal(aggregate.bytes, 32);
  assert.deepEqual(aggregate.pieces.map(({ byteOffset, stackOffset, bits, bytes }) => ({ byteOffset, stackOffset, bits, bytes })), [
    { byteOffset:0, stackOffset:0, bits:128, bytes:16 },
    { byteOffset:16, stackOffset:16, bits:128, bytes:16 },
  ]);
  assert.equal(next.offset, 32, 'the following argument must not overlap the HVA');
});

test('C3-02 register-only malformed aggregates are rejected before exact publication', () => {
  const pair = {
    type:'struct Pair',
    aggregate:true,
    bits:128,
    members:[
      { type:'uint64', bits:64, bytes:8, byteOffset:0 },
      { type:'uint64', bits:64, bytes:8, byteOffset:8 },
    ],
  };
  const malformedPlugin = registerABIPlugin(new ABIPlugin({
    id:'c3-02-register-only-malformed',
    semanticVersion:'1',
    semanticIdentity:'c3-02-register-only-malformed@1',
    architectureId:'arm64',
    platformPredicate:() => true,
    classifyArguments(instruction) {
      const canonical = AAPCS64_ABI.classifyArguments(instruction);
      const [first] = canonical.arguments;
      const pieces = first.pieces.map((piece, index) => index === 1
        ? { ...piece, byteOffset:0 }
        : piece);
      return { ...canonical, arguments:[{ ...first, pieces }] };
    },
    classifyFunctionReturn:() => null,
  }));
  const adapter = semanticAbiAdapter(malformedPlugin, { architecture:'arm64', platform:'linux' });
  const functionPrototype = { parameters:[pair] };
  assert.deepEqual(adapter.argumentLocations({ functionPrototype }), [],
    'register-only aggregate layout must be validated before locations are published');
  const call = adapter.classifyCall({ call:{ callPrototype:functionPrototype } });
  assert.equal(call.partial, true);
  assert.equal(call.completeness, 'malformed');
  assert.equal(call.arguments, null, 'malformed aggregate arguments must not be published as exact');
});

test('C3-02 unknown SysV and RISC-V argument candidates are explicitly conservative', () => {
  for (const [abi, options] of [
    [SYSV_AMD64_ABI, { architecture:'x86_64', platform:'linux' }],
    [RISCV_LP64_ABI, { architecture:'riscv64', platform:'linux' }],
  ]) {
    const adapter = semanticAbiAdapter(abi, options);
    const locations = adapter.argumentLocations({});
    assert.ok(locations.length > 0, `${abi.id} should retain possible input candidates`);
    assert.equal(locations.every((entry) => entry.possible === true
      && entry.mustUse === false && entry.exact === false && entry.certainty === 'unknown'), true,
    `${abi.id} unknown candidates must never look exact`);
    const call = adapter.classifyCall({ call:{} });
    assert.ok(call.arguments?.length > 0, `${abi.id} unknown call should retain conservative candidates`);
    assert.equal(call.arguments.every((entry) => entry.possible === true
      && entry.mustUse === false && entry.exact === false && entry.certainty === 'unknown'), true,
    `${abi.id} classifyCall candidates must remain conservative`);
  }
});

test('C3-02 nested aggregate descriptors are the classifier source of truth', () => {
  const nested = {
    type:'struct NestedPair',
    aggregate:true,
    layout:{
      bits:128,
      bytes:16,
      members:[
        { type:'uint64', bits:64, bytes:8, byteOffset:0 },
        { type:'uint64', bits:64, bytes:8, byteOffset:8 },
      ],
    },
  };
  for (const [abi, options] of [
    [AAPCS64_ABI, { architecture:'arm64', platform:'linux' }],
    [DARWIN_ARM64_ABI, { architecture:'arm64', platform:'darwin' }],
  ]) {
    const result = abi.classifyArguments({ callPrototype:{ parameters:[nested] } });
    const aggregate = result.arguments[0];
    assert.equal(aggregate.bits, 128, `${abi.id} must consume nested logical width`);
    assert.equal(aggregate.bytes, 16, `${abi.id} must consume nested physical width`);
    assert.equal(aggregate.regs?.length, 2, `${abi.id} must retain both nested aggregate lanes`);
    assert.deepEqual(aggregate.pieces.map(({ byteOffset, bits, bytes }) => ({ byteOffset, bits, bytes })), [
      { byteOffset:0, bits:64, bytes:8 },
      { byteOffset:8, bits:64, bytes:8 },
    ]);
    const adapter = semanticAbiAdapter(abi, options);
    assert.equal(adapter.argumentLocations({ functionPrototype:{ parameters:[nested] } }).length, 2);
  }
});

test('C3-02 aggregate proof matrix rejects sibling malformed descriptors and preserves nested returns', () => {
  const members = [
    { type:'uint64', bits:64, bytes:8, byteOffset:0 },
    { type:'uint64', bits:64, bytes:8, byteOffset:8 },
  ];
  const base = { type:'struct MatrixPair', aggregate:true, bits:128, bytes:16, members };
  const profiles = [
    [AAPCS64_ABI, { architecture:'arm64', platform:'linux' }],
    [DARWIN_ARM64_ABI, { architecture:'arm64', platform:'darwin' }],
    [RISCV_LP64_ABI, { architecture:'riscv64', platform:'linux' }],
    [RISCV_LP64F_ABI, { architecture:'riscv64', platform:'linux' }],
    [RISCV_LP64D_ABI, { architecture:'riscv64', platform:'linux' }],
  ];
  const malformed = [
    { ...base, padding:'bad' },
    { ...base, padding:{} },
    { ...base, padding:[{ bytes:8 }] },
    { ...base, layout:{ bits:64, bytes:16, members } },
    { ...base, layout:{ bits:128, bytes:16, members:[members[0], { ...members[1], byteOffset:0 }] } },
    { ...base, members:[{ ...members[0], layout:{ bits:32, bytes:8, byteOffset:0 } }, members[1]] },
  ];
  for (const parameter of malformed) {
    assert.equal(canonicalAggregateLayout(parameter), null, 'malformed aggregate must stay unproven');
    for (const [abi, options] of profiles) {
      const adapter = semanticAbiAdapter(abi, options);
      assert.deepEqual(adapter.argumentLocations({ functionPrototype:{ parameters:[parameter] } }), [],
        `${abi.id} must not publish malformed aggregate arguments`);
      assert.deepEqual(adapter.returnLocations({ functionPrototype:{
        returnType:parameter.type, aggregate:true, returnsValue:true, ...parameter,
      } }), [], `${abi.id} must not publish malformed aggregate returns`);
    }
  }

  const nested = {
    type:'struct MatrixNested', aggregate:true,
    layout:{ bits:128, bytes:16, members },
  };
  for (const [abi, options] of profiles) {
    const adapter = semanticAbiAdapter(abi, options);
    const argumentLocations = adapter.argumentLocations({ functionPrototype:{ parameters:[nested] } });
    assert.equal(argumentLocations.length, 2, `${abi.id} nested argument lanes`);
    const returnMembers = abi === RISCV_LP64F_ABI || abi === RISCV_LP64D_ABI
      ? members.map((member) => ({ ...member, type:'double' })) : members;
    const returnLocations = adapter.returnLocations({ functionPrototype:{
      returnType:nested.type, aggregate:true, returnsValue:true,
      layout:{ ...nested.layout, members:returnMembers },
    } });
    if (abi === RISCV_LP64F_ABI) {
      assert.deepEqual(returnLocations, [], 'lp64f must reject double aggregate returns beyond FLEN32');
    } else {
      assert.equal(returnLocations.length, 2, `${abi.id} nested return lanes`);
      assert.deepEqual(returnLocations.map(({ bits, bytes, byteOffset }) => ({ bits, bytes, byteOffset })), [
        { bits:64, bytes:8, byteOffset:0 }, { bits:64, bytes:8, byteOffset:8 },
      ]);
    }
  }
});

test('C3-02 global interval matrix rejects scalar and malformed split duplicates', () => {
  const scalar = { index:0, location:'stack', offset:0, bytes:8, bits:64, possible:false, mustUse:true };
  assert.equal(abiPhysicalIntervalsValid({ arguments:[scalar], stackArguments:[scalar] }), false,
    'same scalar object cannot masquerade as a second stack projection');
  assert.equal(abiPhysicalIntervalsValid({ arguments:[scalar], stackArguments:[{ ...scalar }] }), false,
    'cloned scalar stack intervals cannot overlap globally');

  const full = {
    index:0, location:'register-stack', aggregate:true, bits:128, bytes:16,
    pieces:[
      { reg:'x0', pieceIndex:0, order:0, bits:64, bytes:8, byteOffset:0, abiClass:'aggregate' },
      { stackOffset:0, pieceIndex:1, order:1, bits:64, bytes:8, byteOffset:8, abiClass:'aggregate' },
    ],
  };
  const validProjection = { index:0, location:'stack', offset:0, bytes:8, bits:64,
    pieceIndex:1, order:1, byteOffset:8, abiClass:'aggregate' };
  assert.equal(abiPhysicalIntervalsValid({ arguments:[full], stackArguments:[validProjection] }), true,
    'only a canonical aggregate split may mirror its stack lane');
  const malformedProjection = { ...validProjection, byteOffset:0 };
  assert.equal(abiPhysicalIntervalsValid({ arguments:[full], stackArguments:[malformedProjection] }), false,
    'a split projection with contradictory logical coordinates is not proof');
  const overlappingFragment = {
    index:0, location:'stack-fragment', aggregate:true, bits:128, bytes:16,
    pieces:[
      { stackOffset:0, pieceIndex:0, order:0, bits:64, bytes:8, byteOffset:0, abiClass:'aggregate' },
      { stackOffset:4, pieceIndex:1, order:1, bits:64, bytes:8, byteOffset:8, abiClass:'aggregate' },
    ],
  };
  assert.equal(abiPhysicalIntervalsValid({ arguments:[overlappingFragment] }), false,
    'aggregate stack fragments cannot overlap physically');
});

test('C3-02 padded stack extents remain exact across integer aggregate profiles', () => {
  const padded = {
    type:'struct PaddedMatrix', aggregate:true, bits:64, bytes:16,
    members:[{ bits:64, bytes:8, byteOffset:0 }], padding:[{ bytes:8, byteOffset:8 }],
  };
  for (const [abi, options, prefix] of [
    [AAPCS64_ABI, { architecture:'arm64', platform:'linux' }, 8],
    [DARWIN_ARM64_ABI, { architecture:'arm64', platform:'darwin' }, 8],
    [RISCV_LP64_ABI, { architecture:'riscv64', platform:'linux' }, 8],
  ]) {
    const parameters = [...Array.from({ length:prefix }, () => ({ type:'int64', bits:64 })), padded,
      { type:'int64', bits:64 }];
    const result = abi.classifyArguments({ callPrototype:{ parameters } });
    const aggregate = result.arguments[prefix];
    const next = result.arguments[prefix + 1];
    assert.equal(aggregate.location, 'stack', `${abi.id} padded aggregate must use stack when GP lanes are full`);
    assert.equal(aggregate.bytes, 16, `${abi.id} padded aggregate extent`);
    assert.equal(aggregate.pieces[0].bytes, 16, `${abi.id} canonical padded piece extent`);
    assert.equal(next.offset, 16, `${abi.id} next stack argument must not overlap padding`);

    const direct = abi.classifyArguments({ callPrototype:{ parameters:[padded] } });
    assert.equal(direct.partial, true, `${abi.id} must fail closed for unrepresented register padding`);
  }
});

test('C3-02 unknown frontier state is explicit for every arm64 and integer profile', () => {
  for (const [abi, options] of [
    [AAPCS64_ABI, { architecture:'arm64', platform:'linux' }],
    [DARWIN_ARM64_ABI, { architecture:'arm64', platform:'darwin' }],
    [SYSV_AMD64_ABI, { architecture:'x86_64', platform:'linux' }],
    [RISCV_LP64_ABI, { architecture:'riscv64', platform:'linux' }],
    [RISCV_LP64F_ABI, { architecture:'riscv64', platform:'linux' }],
    [RISCV_LP64D_ABI, { architecture:'riscv64', platform:'linux' }],
  ]) {
    const adapter = semanticAbiAdapter(abi, options);
    const locations = adapter.argumentLocations({});
    assert.ok(locations.length > 0, `${abi.id} unknown frontier must retain candidates`);
    assert.equal(locations.every((entry) => entry.possible === true && entry.mustUse === false
      && entry.exact === false && entry.certainty === 'unknown'), true,
    `${abi.id} argument locations must be explicitly conservative`);
    const call = adapter.classifyCall({ call:{} });
    assert.ok(call.arguments?.length > 0, `${abi.id} unknown call must retain candidates`);
    assert.equal(call.arguments.every((entry) => entry.possible === true && entry.mustUse === false
      && entry.exact === false && entry.certainty === 'unknown'), true,
    `${abi.id} call arguments must be explicitly conservative`);
  }
});

test('C3-02 cumulative descriptor matrix rejects every malformed top/nested alias', () => {
  const members = [
    { type:'uint64', bits:64, bytes:8, byteOffset:0 },
    { type:'uint64', bits:64, bytes:8, byteOffset:8 },
  ];
  const base = {
    type:'struct DescriptorMatrix', aggregate:true, bits:128, bytes:16, members,
  };
  const malformed = [
    { ...base, padding:'bad' },
    { ...base, padding:{} },
    { ...base, padding:[{ bytes:8 }] },
    { ...base, padding:[{ bytes:8, byteOffset:8 }, { bytes:8, byteOffset:8 }] },
    { ...base, padding:[{ bytes:8, byteOffset:7 }] },
    { ...base, layout:null },
    { ...base, layout:{ bits:64, bytes:16, members } },
    { ...base, layout:{ bits:128, bytes:8, members } },
    { ...base, layout:{ bits:128, bytes:16, members:[members[0], { ...members[1], byteOffset:0 }] } },
    { ...base, layout:{ bits:128, bytes:16, members }, returnAggregate:{ bits:64, bytes:16, members } },
    { ...base, layout:{ bits:128, bytes:16, members }, returnAggregate:{ bits:128, bytes:16,
      members:[members[0], { ...members[1], byteOffset:0 }] } },
    { ...base, members:3, layout:{ bits:128, bytes:16, members } },
    { ...base, bits:128, returnBits:64, returnAggregate:{ bits:128, bytes:16, members } },
    { ...base, members:[{ ...members[0], bytes:'8' }, members[1]] },
    { ...base, members:[{ ...members[0], byteOffset:Infinity }, members[1]] },
    { ...base, members:[{ ...members[0], layout:'bad' }, members[1]] },
    { ...base, padding:[{ bytes:8, byteOffset:8, layout:'bad' }] },
    { ...base, returnAggregate:[] },
    { ...base, returnAggregate:'bad' },
  ];
  const profiles = [
    [AAPCS64_ABI, { architecture:'arm64', platform:'linux' }],
    [DARWIN_ARM64_ABI, { architecture:'arm64', platform:'darwin' }],
    [SYSV_AMD64_ABI, { architecture:'x86_64', platform:'linux' }],
    [MICROSOFT_X64_ABI, { architecture:'x86_64', platform:'windows' }],
    [MICROSOFT_VECTORCALL_ABI, { architecture:'x86_64', platform:'windows', callingConvention:'vectorcall' }],
    [RISCV_LP64_ABI, { architecture:'riscv64', platform:'linux' }],
    [RISCV_LP64F_ABI, { architecture:'riscv64', platform:'linux' }],
    [RISCV_LP64D_ABI, { architecture:'riscv64', platform:'linux' }],
  ];
  for (const parameter of malformed) {
    assert.equal(canonicalAggregateLayout(parameter), null,
      `malformed descriptor must not canonicalize: ${JSON.stringify(parameter)}`);
    for (const [abi, options] of profiles) {
      const adapter = semanticAbiAdapter(abi, options);
      const argumentPrototype = { parameters:[parameter] };
      assert.deepEqual(adapter.argumentLocations({ functionPrototype:argumentPrototype }), [],
        `${abi.id} malformed argument descriptor must not publish locations`);
      const returnPrototype = {
        returnType:parameter.type, aggregate:true, returnsValue:true, ...parameter,
      };
      assert.deepEqual(adapter.returnLocations({ functionPrototype:returnPrototype }), [],
        `${abi.id} malformed return descriptor must not publish locations`);
      const call = adapter.classifyCall({ call:{ callPrototype:argumentPrototype } });
      assert.notEqual(call.completeness, 'complete', `${abi.id} malformed call must not be complete`);
    }
  }
});

test('C3-02 nested return descriptors remain one canonical source across profiles', () => {
  const integerMembers = [
    { type:'uint64', bits:64, bytes:8, byteOffset:0 },
    { type:'uint64', bits:64, bytes:8, byteOffset:8 },
  ];
  const integerReturn = {
    returnType:'struct NestedReturn', returnsValue:true,
    returnAggregate:{ bits:128, bytes:16, members:integerMembers },
  };
  const integerCases = [
    [AAPCS64_ABI, { architecture:'arm64', platform:'linux' }, 'lanes'],
    [DARWIN_ARM64_ABI, { architecture:'arm64', platform:'darwin' }, 'lanes'],
    [SYSV_AMD64_ABI, { architecture:'x86_64', platform:'linux' }, 'lanes'],
    [MICROSOFT_X64_ABI, { architecture:'x86_64', platform:'windows' }, 'indirect'],
    [MICROSOFT_VECTORCALL_ABI, { architecture:'x86_64', platform:'windows', callingConvention:'vectorcall' }, 'unknown'],
    [RISCV_LP64_ABI, { architecture:'riscv64', platform:'linux' }, 'lanes'],
    [RISCV_LP64F_ABI, { architecture:'riscv64', platform:'linux' }, 'unknown'],
    [RISCV_LP64D_ABI, { architecture:'riscv64', platform:'linux' }, 'unknown'],
  ];
  for (const [abi, options, expected] of integerCases) {
    const adapter = semanticAbiAdapter(abi, options);
    const prototype = abi === SYSV_AMD64_ABI
      ? { ...integerReturn, returnAggregate:{ ...integerReturn.returnAggregate, eightbyteClasses:['INTEGER','INTEGER'] } }
      : abi === MICROSOFT_X64_ABI
        ? { ...integerReturn, trivialForCalls:true }
        : integerReturn;
    const locations = adapter.returnLocations({ functionPrototype:prototype });
    if (expected === 'lanes') {
      assert.equal(locations.length, 2, `${abi.id} nested return must retain both lanes`);
      assert.deepEqual(locations.map(({ bits, bytes, byteOffset }) => ({ bits, bytes, byteOffset })), [
        { bits:64, bytes:8, byteOffset:0 }, { bits:64, bytes:8, byteOffset:8 },
      ]);
    } else if (expected === 'indirect') {
      assert.deepEqual(locations, [{ kind:'indirect', reg:'rcx', role:'result-address' }],
        `${abi.id} must preserve its canonical indirect aggregate result`);
    } else {
      assert.deepEqual(locations, [], `${abi.id} must remain conservative without its profile proof`);
    }
  }

  const homogeneousMembers = [
    { type:'double', bits:64, bytes:8, byteOffset:0 },
    { type:'double', bits:64, bytes:8, byteOffset:8 },
  ];
  for (const [abi, options] of [
    [AAPCS64_ABI, { architecture:'arm64', platform:'linux' }],
    [DARWIN_ARM64_ABI, { architecture:'arm64', platform:'darwin' }],
  ]) {
    const locations = semanticAbiAdapter(abi, options).returnLocations({ functionPrototype:{
      returnType:'struct NestedHFA', returnsValue:true,
      returnAggregate:{ hfa:true, bits:128, bytes:16, members:homogeneousMembers },
    } });
    assert.equal(locations.length, 2, `${abi.id} nested HFA return lanes`);
    assert.deepEqual(locations.map(({ reg, bits, bytes, byteOffset }) => ({ reg, bits, bytes, byteOffset })), [
      { reg:'v0', bits:64, bytes:8, byteOffset:0 },
      { reg:'v1', bits:64, bytes:8, byteOffset:8 },
    ]);
  }
  const vectorLocations = semanticAbiAdapter(MICROSOFT_VECTORCALL_ABI, {
    architecture:'x86_64', platform:'windows', callingConvention:'vectorcall',
  }).returnLocations({ functionPrototype:{
    returnType:'struct NestedHVA', returnsValue:true,
    returnAggregate:{ hva:true, bits:256, bytes:32, members:[
      { type:'vector', bits:128, bytes:16, byteOffset:0 },
      { type:'vector', bits:128, bytes:16, byteOffset:16 },
    ] },
  } });
  assert.deepEqual(vectorLocations.map(({ reg, bits, bytes, byteOffset }) => ({ reg, bits, bytes, byteOffset })), [
    { reg:'xmm0', bits:128, bytes:16, byteOffset:0 },
    { reg:'xmm1', bits:128, bytes:16, byteOffset:16 },
  ]);
});

test('C3-02 nested ambiguity cannot be laundered by a classifier shortcut', () => {
  const members = [
    { type:'uint64', bits:64, bytes:8, byteOffset:0 },
    { type:'uint64', bits:64, bytes:8, byteOffset:8 },
  ];
  const cases = [
    { aggregate:true, bits:128, bytes:16, members,
      layout:{ bits:128, bytes:16, members:[members[0], { ...members[1], byteOffset:0 }] } },
    { aggregate:true, bits:128, bytes:16, members,
      layout:{ bits:128, bytes:16, members }, returnAggregate:{ bits:128, bytes:16, members:[members[0]] } },
    { aggregate:true, bits:0, bytes:16, members,
      layout:{ bits:128, bytes:16, members } },
    { aggregate:true, bits:128, bytes:16, members,
      layout:{ bits:128, bytes:16, members }, returnBits:64 },
  ];
  for (const parameter of cases) {
    assert.equal(canonicalAggregateLayout(parameter), null);
    for (const [abi, options] of [
      [AAPCS64_ABI, { architecture:'arm64', platform:'linux' }],
      [DARWIN_ARM64_ABI, { architecture:'arm64', platform:'darwin' }],
      [SYSV_AMD64_ABI, { architecture:'x86_64', platform:'linux' }],
      [MICROSOFT_X64_ABI, { architecture:'x86_64', platform:'windows' }],
      [MICROSOFT_VECTORCALL_ABI, { architecture:'x86_64', platform:'windows', callingConvention:'vectorcall' }],
      [RISCV_LP64_ABI, { architecture:'riscv64', platform:'linux' }],
    ]) {
      const adapter = semanticAbiAdapter(abi, options);
      assert.deepEqual(adapter.argumentLocations({ functionPrototype:{ parameters:[parameter] } }), [], abi.id);
      assert.deepEqual(adapter.returnLocations({ functionPrototype:{
        ...parameter, returnType:'struct Ambiguous', returnsValue:true,
      } }), [], `${abi.id} return ambiguity`);
    }
  }
});

test('C3-02 layout-only descriptors cannot fall through to scalar exactness', () => {
  const layoutOnly = {
    layout:{ bits:64, bytes:8, members:[{ type:'uint64', bits:64, bytes:8, byteOffset:0 }] },
  };
  const profiles = [
    [AAPCS64_ABI, { architecture:'arm64', platform:'linux' }],
    [DARWIN_ARM64_ABI, { architecture:'arm64', platform:'darwin' }],
    [SYSV_AMD64_ABI, { architecture:'x86_64', platform:'linux' }],
    [MICROSOFT_X64_ABI, { architecture:'x86_64', platform:'windows' }],
    [MICROSOFT_VECTORCALL_ABI, { architecture:'x86_64', platform:'windows', callingConvention:'vectorcall' }],
    [RISCV_LP64_ABI, { architecture:'riscv64', platform:'linux' }],
    [RISCV_LP64F_ABI, { architecture:'riscv64', platform:'linux' }],
    [RISCV_LP64D_ABI, { architecture:'riscv64', platform:'linux' }],
  ];
  for (const [abi, options] of profiles) {
    const adapter = semanticAbiAdapter(abi, options);
    const classified = abi.classifyArguments({ callPrototype:{ parameters:[layoutOnly] } });
    const entry = classified.arguments?.[0];
    assert.ok(entry?.aggregate === true || entry?.partial === true,
      `${abi.id} layout-only argument must remain aggregate/partial`);
    if (entry?.possible !== true && entry?.mustUse !== false) {
      assert.equal(entry.aggregate, true, `${abi.id} exact layout-only argument must be aggregate`);
      assert.ok(Array.isArray(entry.pieces) || Array.isArray(entry.parts),
        `${abi.id} exact layout-only argument must carry physical pieces`);
    }
    const locations = adapter.argumentLocations({ functionPrototype:{ parameters:[layoutOnly] } });
    assert.equal(locations.length === 0 || locations.every((location) => location.aggregate === true), true,
      `${abi.id} layout-only argument must not publish scalar exactness`);

    const returned = abi.classifyFunctionReturn({ functionPrototype:{ ...layoutOnly,
      returnType:'struct LayoutOnly', returnsValue:true } });
    assert.ok(returned?.aggregate === true || returned?.partial === true,
      `${abi.id} layout-only return must remain aggregate/partial`);
    const returnLocations = adapter.returnLocations({ functionPrototype:{ ...layoutOnly,
      returnType:'struct LayoutOnly', returnsValue:true } });
    assert.equal(returnLocations.length === 0 || returnLocations.every((location) => location.aggregate === true), true,
      `${abi.id} layout-only return must not publish scalar exactness`);
  }
});

test('C3-02 global physical interval matrix covers widths, alignment, registers, and stack', () => {
  for (const [index, bits] of [1, 8, 16, 32, 64, 128].entries()) {
    const bytes = Math.ceil(bits / 8);
    const scalar = {
      index, location:'register', reg:`width${bits}`, bits, bytes,
      possible:false, mustUse:true,
    };
    assert.equal(abiPhysicalIntervalsValid({ arguments:[scalar], stackArguments:[] }), true,
      `scalar width ${bits} must be a valid exact register fact`);
    assert.equal(abiPhysicalIntervalsValid({ arguments:[scalar, { ...scalar, index:index + 100 }] }), false,
      `duplicate register width ${bits} must be rejected globally`);
    const stack = {
      index, location:'stack', offset:0, bytes, bits,
      possible:false, mustUse:true,
    };
    assert.equal(abiPhysicalIntervalsValid({ arguments:[stack], stackArguments:[] }), true,
      `stack width ${bits} must be valid at offset zero`);
    if (bytes >= 8) assert.equal(abiPhysicalIntervalsValid({ arguments:[{ ...stack, offset:1 }], stackArguments:[] }), false,
      `stack width ${bits} must honor its natural alignment`);
  }
  const split = {
    index:0, location:'register-stack', aggregate:true, bits:128, bytes:16,
    pieces:[
      { pieceIndex:0, order:0, reg:'split-r0', bits:64, bytes:8, byteOffset:0, abiClass:'aggregate' },
      { pieceIndex:1, order:1, stackOffset:16, bits:64, bytes:8, byteOffset:8, abiClass:'aggregate' },
    ],
  };
  const projection = {
    index:0, location:'stack', offset:16, bytes:8, bits:64,
    pieceIndex:1, order:1, byteOffset:8, abiClass:'aggregate',
  };
  assert.equal(abiPhysicalIntervalsValid({ arguments:[split], stackArguments:[projection] }), true);
  assert.equal(abiPhysicalIntervalsValid({ arguments:[split], stackArguments:[{ ...projection, offset:8 }] }), false);
  assert.equal(abiPhysicalIntervalsValid({ arguments:[split], stackArguments:[{ ...projection, byteOffset:0 }] }), false);
  assert.equal(abiPhysicalIntervalsValid({ arguments:[split], stackArguments:[{ ...projection, bits:32 }] }), false);
});

test('C3-02 unknown public candidates are conservative across every supported profile', () => {
  const profiles = [
    [AAPCS64_ABI, { architecture:'arm64', platform:'linux' }],
    [DARWIN_ARM64_ABI, { architecture:'arm64', platform:'darwin' }],
    [SYSV_AMD64_ABI, { architecture:'x86_64', platform:'linux' }],
    [MICROSOFT_X64_ABI, { architecture:'x86_64', platform:'windows' }],
    [MICROSOFT_VECTORCALL_ABI, { architecture:'x86_64', platform:'windows', callingConvention:'vectorcall' }],
    [RISCV_LP64_ABI, { architecture:'riscv64', platform:'linux' }],
    [RISCV_LP64F_ABI, { architecture:'riscv64', platform:'linux' }],
    [RISCV_LP64D_ABI, { architecture:'riscv64', platform:'linux' }],
  ];
  for (const [abi, options] of profiles) {
    const adapter = semanticAbiAdapter(abi, options);
    const locations = adapter.argumentLocations({});
    assert.ok(locations.length > 0, `${abi.id} must expose possible candidates`);
    assert.equal(locations.every((entry) => entry.possible === true
      && entry.mustUse === false && entry.exact === false && entry.certainty === 'unknown'), true,
    `${abi.id} public argument candidates must be explicitly unknown`);
    const call = adapter.classifyCall({ call:{} });
    assert.ok(call.arguments?.length > 0, `${abi.id} call must retain candidates`);
    assert.equal(call.arguments.every((entry) => entry.possible === true
      && entry.mustUse === false && entry.exact === false && entry.certainty === 'unknown'), true,
    `${abi.id} classifyCall candidates must be explicitly unknown`);
    assert.equal(call.returnLocations.length, 0, `${abi.id} unknown call cannot publish return placement`);
    assert.equal(call.returnReg, null, `${abi.id} unknown call cannot publish scalar return register`);
  }
});

test('C3-02 a null callback resolution cannot authorize an exact call ABI', () => {
  for (const [abi, options] of [
    [AAPCS64_ABI, { architecture:'arm64', platform:'linux' }],
    [DARWIN_ARM64_ABI, { architecture:'arm64', platform:'darwin' }],
    [SYSV_AMD64_ABI, { architecture:'x86_64', platform:'linux' }],
    [MICROSOFT_X64_ABI, { architecture:'x86_64', platform:'windows' }],
    [MICROSOFT_VECTORCALL_ABI, { architecture:'x86_64', platform:'windows', callingConvention:'vectorcall' }],
    [RISCV_LP64_ABI, { architecture:'riscv64', platform:'linux' }],
  ]) {
    const adapter = semanticAbiAdapter(abi, { ...options, callPrototypeFor:() => null });
    const call = adapter.classifyCall({ call:{ target:0x1000 } });
    assert.ok(call.arguments?.length > 0, `${abi.id} null resolver must retain candidates`);
    assert.equal(call.arguments.every((entry) => entry.possible === true
      && entry.mustUse === false && entry.exact === false && entry.certainty === 'unknown'), true,
    `${abi.id} null resolver candidates must be conservative`);
    assert.deepEqual(call.returnLocations, [], `${abi.id} null resolver must not publish return placement`);
    assert.equal(call.returnReg, null, `${abi.id} null resolver must not publish return register`);
  }
});
