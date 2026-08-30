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
  const pair = { returnType:'struct Pair', aggregate:true, bits:128, returnsValue:true };
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
  const pair = { returnType:'struct Pair', aggregate:true, bits:128, returnsValue:true };
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

  const parameter = { type:'struct Pair', aggregate:true, bits:128 };
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
  const parameter = { type:'struct Pair', aggregate:true, bits:128 };
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
  const big = { returnType:'struct Big', aggregate:true, bits:256, returnsValue:true };
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
    { type:'struct Pair', aggregate:true, bits:128 },
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
  const fixedPrefix = partial.arguments.find((argument) => argument.index === 0);
  const anonymousCandidate = partial.arguments.find((argument) => argument.index == null);
  assert.equal(fixedPrefix?.possible ?? null, false);
  assert.equal(fixedPrefix?.mustUse ?? null, true);
  assert.equal(anonymousCandidate?.possible ?? null, true);
  assert.equal(anonymousCandidate?.mustUse ?? null, false);
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
  const prototype = { returnType:'struct Large', aggregate:true, bits:256, returnsValue:true };
  const complete = base.classifyFunctionReturn({ functionPrototype:prototype });
  assert.equal(complete?.indirect, true);
  for (const state of [{ partial:true }, { budgetLimited:true }, { status:'budget-limited' }]) {
    const adapter = {
      ...base,
      classifyFunctionReturn() { return { ...complete, ...state }; },
    };
    assert.deepEqual(adapter.returnLocations({ classified:{ ...complete, ...state } }), []);
    const recovered = recover(adapter, ['x8'], { ret:{ type:'struct Large', aggregate:true, bits:256 } });
    assert.equal(recovered.indirectResult, false);
    assert.equal(recovered.indirectResultRegister, null);
    assert.deepEqual(recovered.returnLocations, []);
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
