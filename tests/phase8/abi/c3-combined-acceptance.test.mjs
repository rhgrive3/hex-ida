import assert from 'node:assert/strict';
import test from 'node:test';
import { semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';
import { recoverFunctionPrototype } from '../../../js/decompiler/types/prototype.js';
import { abiPhysicalIntervalsValid, canonicalAbiEvidence } from '../../../js/targets/abi/evidence.js';
import {
  AAPCS64_ABI, DARWIN_ARM64_ABI, SYSV_AMD64_ABI, MICROSOFT_X64_ABI,
  MICROSOFT_VECTORCALL_ABI, RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI, UNKNOWN_ABI,
} from '../../../js/targets/abi/index.js';

const SNAPSHOT = 'user-c3-abi-acceptance';
// These are fixed fixture expectations, not another ABI classifier. Each entry
// declares the five shapes below: small, integer pair, HFA, HVA, large/sret.
const PROFILES = [
  { id:'aapcs64', abi:AAPCS64_ABI, architecture:'arm64', platform:'linux',
    args:[['x0'], ['x0','x1'], ['v0','v1'], ['v0','v1'], ['x0']],
    returns:[['x0'], ['x0','x1'], ['v0','v1'], ['v0','v1'], 'x8'] },
  { id:'darwin', abi:DARWIN_ARM64_ABI, architecture:'arm64', platform:'darwin',
    args:[['x0'], ['x0','x1'], ['v0','v1'], ['v0','v1'], ['x0']],
    returns:[['x0'], ['x0','x1'], ['v0','v1'], ['v0','v1'], 'x8'] },
  { id:'darwin-arm64e', abi:DARWIN_ARM64_ABI, architecture:'arm64e', platform:'darwin',
    args:[['x0'], ['x0','x1'], ['v0','v1'], ['v0','v1'], ['x0']],
    returns:[['x0'], ['x0','x1'], ['v0','v1'], ['v0','v1'], 'x8'] },
  { id:'sysv', abi:SYSV_AMD64_ABI, architecture:'x86_64', platform:'linux',
    args:[['rdi'], ['rdi','rsi'], ['xmm0','xmm1'], [], []],
    returns:[['rax'], ['rax','rdx'], ['xmm0','xmm1'], 'rdi', 'rdi'] },
  { id:'microsoft-x64', abi:MICROSOFT_X64_ABI, architecture:'x86_64', platform:'windows',
    args:[['rcx'], ['rcx'], ['rcx'], ['rcx'], ['rcx']],
    returns:[['rax'], 'rcx', 'rcx', 'rcx', 'rcx'] },
  { id:'vectorcall', abi:MICROSOFT_VECTORCALL_ABI, architecture:'x86_64', platform:'windows', callingConvention:'vectorcall',
    args:[['rcx'], ['rcx'], ['xmm0','xmm1'], ['xmm0','xmm1'], ['rcx']],
    returns:[['rax'], 'rcx', ['xmm0','xmm1'], ['xmm0','xmm1'], 'rcx'] },
  { id:'lp64', abi:RISCV_LP64_ABI, architecture:'riscv64', platform:'linux',
    args:[['x10'], ['x10','x11'], ['x10','x11'], ['x10'], ['x10']],
    returns:[['x10'], ['x10','x11'], ['x10','x11'], 'x10', 'x10'] },
  { id:'lp64f', abi:RISCV_LP64F_ABI, architecture:'riscv64', platform:'linux',
    args:[['x10'], ['x10','x11'], ['x10','x11'], ['x10'], ['x10']],
    returns:[['x10'], ['x10','x11'], ['x10','x11'], 'x10', 'x10'] },
  { id:'lp64d', abi:RISCV_LP64D_ABI, architecture:'riscv64', platform:'linux',
    args:[['x10'], ['x10','x11'], ['f10','f11'], ['x10'], ['x10']],
    returns:[['x10'], ['x10','x11'], ['f10','f11'], 'x10', 'x10'] },
];
const members = (count, type, bits) => Array.from({ length:count }, (_unused, index) => ({
  type, bits, bytes:bits / 8, byteOffset:index * bits / 8,
}));
const SHAPES = [
  { name:'small', type:'struct Small', aggregate:true, bits:64, alignmentBytes:8,
    members:members(1, 'uint64', 64), trivialForCalls:true },
  { name:'pair', type:'struct Pair', aggregate:true, bits:128, alignmentBytes:8,
    members:members(2, 'uint64', 64), trivialForCalls:true },
  { name:'hfa', type:'struct HFA', aggregate:true, hfa:true, bits:128, alignmentBytes:8,
    members:members(2, 'double', 64), trivialForCalls:true },
  { name:'hva', type:'struct HVA', aggregate:true, hva:true, bits:256, alignmentBytes:16,
    members:members(2, 'vector', 128), trivialForCalls:true },
  { name:'large', type:'struct Large', aggregate:true, bits:256, alignmentBytes:8,
    members:members(4, 'uint64', 64), trivialForCalls:true },
];
function adapterFor(profile) {
  return semanticAbiAdapter(profile.abi, { architecture:profile.architecture, platform:profile.platform,
    callingConvention:profile.callingConvention, abiId:profile.abi.id, snapshotId:SNAPSHOT });
}
function parameterFor(profile, index) {
  const parameter = structuredClone(SHAPES[index]);
  if (profile.abi === SYSV_AMD64_ABI) {
    parameter.eightbyteClasses = index === 0 ? ['INTEGER'] : index === 1 ? ['INTEGER','INTEGER']
      : index === 2 ? ['SSE','SSE'] : ['MEMORY'];
  }
  return parameter;
}
function recover(adapter, { regs = [], ret = null, ...options } = {}) {
  return recoverFunctionPrototype({ args:new Map(regs.map((reg, index) => [reg, { id:index + 1, reg, uses:[{}] }])), instructions:[] },
    { values:new Map(), ...(ret ? { ret } : {}) }, { abiAdapter:adapter, ...options });
}
const registers = entry => entry?.regs ?? (entry?.reg ? [entry.reg] : []);
const physicalBases = regs => regs.map(reg => ({ xmm0:'ymm0', xmm1:'ymm1' }[reg] ?? reg));
const returnRequest = parameter => ({ functionPrototype:{ ...parameter, returnType:parameter.type, returnsValue:true } });

for (const profile of PROFILES) for (const [index, shape] of SHAPES.entries()) {
  test(`C3-02 profile aggregate ${profile.id}/${shape.name}`, () => {
    const adapter = adapterFor(profile), parameter = parameterFor(profile, index);
    const before = structuredClone(parameter);
    const functionPrototype = { parameters:[parameter] };
    const classified = adapter.classifyArguments({ functionPrototype });
    assert.equal(classified.partial, false);
    assert.equal(abiPhysicalIntervalsValid(classified), true, 'producer must provide complete physical proof');
    assert.equal(classified.arguments.length, 1);
    const argument = classified.arguments[0], expectedArgs = profile.args[index];
    assert.deepEqual(registers(argument), expectedArgs);
    if (!expectedArgs.length) {
      assert.equal(argument.location, 'stack');
      assert.equal(argument.bits, parameter.bits);
    }
    // Argument and return recovery are independent queries: an sret parameter
    // is not silently treated as an ordinary parameter at the same register.
    const caller = recover(adapter, { regs:expectedArgs, functionPrototype });
    assert.equal(caller.conventionKnown, true);
    if (expectedArgs.length) {
      assert.equal(caller.arguments.length, 1, 'aggregate lanes stay one logical argument');
      assert.deepEqual(registers(caller.arguments[0]), physicalBases(expectedArgs));
    }
    const returnParameter = { ...parameter, ...(profile.abi === SYSV_AMD64_ABI && index >= 3 ? { indirectResult:true } : {}) };
    const expectedReturn = profile.returns[index];
    const returned = adapter.classifyFunctionReturn(returnRequest(returnParameter));
    const locations = adapter.returnLocations(returnRequest(returnParameter));
    const callee = recover(adapter, { ret:returnParameter });
    assert.notEqual(returned.partial, true);
    assert.equal(abiPhysicalIntervalsValid(returned), true);
    assert.equal(canonicalAbiEvidence(returned), true, 'return proof must retain the canonical profile envelope');
    if (typeof expectedReturn === 'string') {
      assert.equal(returned.indirect, true);
      assert.equal(returned.hiddenResultPointer.input, expectedReturn);
      assert.equal(callee.returnLocationKnown, true);
      assert.deepEqual(callee.returnLocations, [{ kind:'indirect', reg:expectedReturn, role:'result-address' }]);
    } else {
      assert.deepEqual(registers(returned), expectedReturn);
      assert.deepEqual(locations.map(location => location.reg), expectedReturn);
      assert.deepEqual(callee.returnLocations.map(location => location.reg), physicalBases(expectedReturn));
      assert.equal(callee.returnLocationKnown, true);
      const pieceBits = parameter.bits / expectedReturn.length;
      assert.deepEqual(callee.returnLocations.map(location => location.bits), expectedReturn.map(() => pieceBits));
      assert.deepEqual(callee.returnLocations.map(location => location.byteOffset), expectedReturn.map((_reg, piece) => piece * pieceBits / 8));
    }
    assert.deepEqual(parameter, before, 'canonical classifiers must not rewrite type/layout evidence');
    assert.deepEqual(recover(adapter, { ret:returnParameter }), callee, 'replay is stable');
  });
}

const INVALIDATIONS = [
  ['stale', { snapshotId:'old-snapshot' }], ['cancelled', { signal:AbortSignal.abort() }],
  ['budget', { budgetExhausted:true }], ['truncated', { truncated:true }],
  ['caller-callee-conflict', { callerCalleeConflict:true }],
  ['ambiguous-thunk', { thunkAmbiguous:true }], ['ambiguous-tail-call', { tailCallAmbiguous:true }],
];
for (const profile of PROFILES) for (const [mode, options] of INVALIDATIONS) {
  test(`C3-02 profile publication ${profile.id}/${mode}`, () => {
    const adapter = adapterFor(profile);
    const result = recover(adapter, { regs:profile.args[0], ret:{ type:'uint64', bits:64 },
      functionPrototype:{ parameters:[{ type:'uint64', bits:64 }] }, ...options });
    assert.equal(result.conventionKnown, false);
    assert.equal(result.returnLocationKnown, false);
    assert.deepEqual(result.arguments, []);
    assert.deepEqual(result.returnLocations, []);
    assert.equal(result.abiIdentity, null);
  });
}

for (const profile of PROFILES) for (const flag of ['variadic', 'varargs']) {
  test(`C3-02 profile variadic ${profile.id}/${flag}`, () => {
    const adapter = adapterFor(profile);
    const functionPrototype = { [flag]:true, fixedParameterCount:1, parameters:[{ type:'uint64', bits:64 }] };
    const canonical = adapter.classifyArguments({ functionPrototype });
    const recovered = recover(adapter, { regs:profile.args[0], functionPrototype });
    assert.equal(canonical.partial, true);
    if (profile.abi === MICROSOFT_VECTORCALL_ABI) {
      assert.equal(canonical.unsupported, true);
      assert.equal(canonical.reason, 'microsoft-vectorcall-variadic-unsupported');
      assert.deepEqual(canonical.arguments, []);
      assert.deepEqual(recovered.arguments, []);
      assert.equal(recovered.conventionKnown, false);
    } else {
      assert.deepEqual(registers(canonical.arguments[0]), profile.args[0]);
      // SysV's fixed scalar entries omit the booleans; its explicit tail
      // entries carry possible=true/mustUse=false. Both canonical schemas
      // must preserve the fixed prefix and never promote the anonymous tail.
      assert.notEqual(canonical.arguments[0].possible, true);
      assert.notEqual(canonical.arguments[0].mustUse, false);
      for (const source of canonical.srcs.filter(item => item.purpose === 'variadic-register-candidate')) {
        assert.equal(source.possible, true); assert.equal(source.mustUse, false);
      }
      assert.equal(canonical.stackArgsUnknown, true);
      assert.equal(recovered.arguments.length, 1);
      assert.equal(recovered.anonymousArgumentFrontier.exact, false);
      assert.equal(recovered.anonymousArgumentFrontier.mustUse, false);
      assert.equal(recovered.anonymousArgumentFrontier.certainty, 'unknown');
      assert.notEqual(recovered.completeness, 'complete');
    }
  });
}

for (const profile of PROFILES.filter(profile => profile.abi === DARWIN_ARM64_ABI)) {
  test(`C3-02 Darwin indirect-copy physical proof ${profile.id}/register-stack-variadic`, () => {
    const adapter = adapterFor(profile), aggregate = parameterFor(profile, 4);
    for (const mode of ['register', 'exhausted-registers', 'anonymous-stack']) {
      const prefix = mode === 'exhausted-registers' ? Array.from({ length:8 }, () => ({ type:'uint64', bits:64 })) : [];
      const functionPrototype = { parameters:[...prefix, aggregate],
        ...(mode === 'anonymous-stack' ? { variadic:true, fixedParameterCount:0 } : {}) };
      const classified = adapter.classifyArguments({ functionPrototype });
      const entry = classified.arguments.at(-1);
      assert.equal(abiPhysicalIntervalsValid(classified), true);
      assert.equal(entry.pointer, true);
      assert.equal(entry.bits, 64, 'the physical argument is a pointer, not 256 aggregate bits');
      assert.equal(entry.pointeeBits, 256);
      assert.equal(entry.pieces.length, 1);
      assert.equal(entry.pieces[0].bits, 64);
      assert.equal(entry.pieces[0].byteOffset, 0);
      if (mode === 'register') assert.equal(entry.pieces[0].reg, 'x0');
      else { assert.equal(entry.location, 'stack'); assert.equal(entry.pieces[0].stackOffset, 0); }
      // A missing/corrupted physical proof remains rejected by the shared owner.
      for (const mutate of [item => { delete item.pieces; }, item => { item.pieces[0].bits = 256; }]) {
        const invalid = structuredClone(classified);
        mutate(invalid.arguments.at(-1));
        assert.equal(abiPhysicalIntervalsValid(invalid), false);
      }
    }
  });
}

test('C3-02 explicit-layout and explicit-sret boundaries do not fabricate missing proof', () => {
  const darwin = PROFILES[1], parameter = parameterFor(darwin, 1);
  delete parameter.alignmentBytes;
  const incomplete = adapterFor(darwin).classifyArguments({ functionPrototype:{ parameters:[parameter] } });
  assert.equal(incomplete.partial, true);
  assert.equal(incomplete.arguments[0].location, 'unknown');
  assert.equal(incomplete.arguments[0].mustUse, false);
  const sysv = PROFILES[3], memoryReturn = parameterFor(sysv, 4);
  const unproven = adapterFor(sysv).classifyFunctionReturn(returnRequest(memoryReturn));
  assert.equal(unproven.partial, true, 'MEMORY class is not an invented explicit hidden-pointer declaration');
  assert.deepEqual(adapterFor(sysv).returnLocations(returnRequest(memoryReturn)), []);
  for (const profile of PROFILES) {
    const invalid = parameterFor(profile, 1);
    invalid.members[1].byteOffset = 0;
    const classified = adapterFor(profile).classifyArguments({ functionPrototype:{ parameters:[invalid] } });
    assert.equal(classified.partial, true, `${profile.id}: contradictory overlapping struct layout`);
    assert.equal(classified.arguments.some(entry => entry.mustUse === true && entry.possible === false), false);
  }
});

test('C3-02 LP64F/LP64D proven two-float aggregate uses the canonical hard-float bank', () => {
  const parameter = { type:'struct FloatPair', aggregate:true, bits:64, alignmentBytes:4, members:members(2, 'float', 32) };
  for (const profile of PROFILES.filter(item => [RISCV_LP64F_ABI, RISCV_LP64D_ABI].includes(item.abi))) {
    const adapter = adapterFor(profile);
    assert.deepEqual(registers(adapter.classifyArguments({ functionPrototype:{ parameters:[parameter] } }).arguments[0]), ['f10','f11']);
    const returned = recover(adapter, { ret:parameter });
    assert.equal(returned.returnLocationKnown, true);
    assert.deepEqual(returned.returnLocations.map(location => [location.reg, location.bits, location.byteOffset]), [['f10',32,0], ['f11',32,4]]);
  }
});

test('C3-02 unknown profile publishes no aggregate or variadic placement', () => {
  const adapter = semanticAbiAdapter(UNKNOWN_ABI);
  for (const shape of SHAPES) for (const variadic of [false, true]) {
    const functionPrototype = { parameters:[shape], variadic };
    const result = recover(adapter, { regs:['x0','rcx','x10'], ret:shape, functionPrototype });
    assert.equal(result.conventionKnown, false);
    assert.equal(result.returnLocationKnown, false);
    assert.deepEqual(result.arguments, []);
    assert.deepEqual(result.returnLocations, []);
  }
});

for (const elementBits of [32, 64, 128]) for (const prefixSlots of [0, 1]) {
  test(`C3-02 AAPCS64 homogeneous stack proof ${elementBits}-bit/prefix-${prefixSlots}`, () => {
    const homogeneous = { type:elementBits === 128 ? 'HVA' : 'HFA', aggregate:true,
      ...(elementBits === 128 ? { hva:true } : { hfa:true }), elementBits,
      bits:elementBits * 2, bytes:elementBits / 4,
      members:members(2, elementBits === 128 ? 'vector' : elementBits === 64 ? 'double' : 'float', elementBits) };
    const parameters = [...Array.from({ length:8 + prefixSlots }, () => ({ type:'uint64', bits:64 })),
      ...Array.from({ length:8 }, () => ({ type:'double', bits:64 })), homogeneous, { type:'uint64', bits:64 }];
    const classified = adapterFor(PROFILES[0]).classifyArguments({ functionPrototype:{ parameters } });
    const entry = classified.arguments.at(-2), tail = classified.arguments.at(-1);
    const start = prefixSlots * (elementBits === 128 ? 16 : 8), bytes = elementBits / 8;
    assert.equal(abiPhysicalIntervalsValid(classified), true);
    assert.notEqual(classified.malformedEvidence, true);
    assert.equal(entry.offset, start);
    assert.equal(entry.bytes, bytes * 2);
    assert.deepEqual(entry.pieces.map(piece => [piece.stackOffset, piece.byteOffset, piece.bytes]),
      [[start, 0, bytes], [start + bytes, bytes, bytes]]);
    assert.equal(tail.offset, start + bytes * 2);
    // Reject contradictory per-member alignment and shifted physical envelopes.
    for (const mutate of [
      item => { item.pieces[1].stackAlignment = 64; },
      item => { item.pieces[0].stackOffset += 1; },
    ]) {
      const invalid = structuredClone(entry);
      mutate(invalid);
      assert.equal(abiPhysicalIntervalsValid({ arguments:[invalid] }), false);
    }
  });
}

// The ABI owner is arm64, while the target profile is arm64e. Registry-approved
// target/profile mapping must retain both identities, not rewrite either one.
test('C3-02 arm64e return envelope preserves registry mapping and rejects forged proof', () => {
  const profile = PROFILES.find(item => item.id === 'darwin-arm64e');
  for (const platform of ['darwin', 'ios-simulator', 'ipados-simulator', 'visionos-simulator', 'maccatalyst']) {
    const adapter = adapterFor({ ...profile, platform });
    const request = returnRequest(parameterFor(profile, 1));
    const returned = adapter.classifyFunctionReturn(request);
    assert.equal(adapter.supported, true, platform);
    assert.equal(returned.abiIdentity.architectureId, 'arm64');
    assert.equal(returned.abiIdentity.targetArchitecture, 'arm64e');
    assert.equal(canonicalAbiEvidence(returned), true, platform);
    assert.deepEqual(adapter.returnLocations(request).map(location => location.reg), ['x0', 'x1']);
    for (const mutate of [
      value => { value.abiIdentity.targetArchitecture = 'arm64'; },
      value => { value.abiIdentity.architectureId = 'riscv64'; },
      value => { value.provenance.architectureId = 'riscv64'; },
      value => { value.invalidation.architectureId = 'riscv64'; },
      value => { value.abiIdentity.architectureProfile.architectureId = 'arm64'; },
      value => { value.registryDigest = 'foreign-registry'; },
      value => { value.invalidation.snapshotId = 'stale'; },
      value => { value.provenance.platformId = 'linux'; },
      value => { value.pieces[1].byteOffset = 0; },
      value => { value.partial = true; },
    ]) {
      const invalid = structuredClone(returned); mutate(invalid);
      assert.deepEqual(adapter.returnLocations({ classified:invalid }), []);
    }
    const indirect = adapter.classifyFunctionReturn(returnRequest(parameterFor(profile, 4)));
    assert.deepEqual(adapter.returnLocations({ classified:indirect }), [{ kind:'indirect', reg:'x8', role:'result-address' }]);
    for (const mutate of [
      value => { value.hiddenResultPointer.input = 'x0'; },
      value => { value.hiddenResultPointer.pointerBits = 32; },
      value => { value.hiddenResultPointer.invalidation.snapshotId = 'stale'; },
    ]) {
      const invalid = structuredClone(indirect); mutate(invalid);
      assert.deepEqual(adapter.returnLocations({ classified:invalid }), []);
    }
  }
  for (const platform of [null, 'linux', 'windows', 'unknown']) {
    const adapter = adapterFor({ ...profile, platform });
    assert.equal(adapter.supported, false);
    assert.deepEqual(adapter.returnLocations(returnRequest(parameterFor(profile, 0))), []);
  }
});

// The return rule reuses the first-named-argument classification. This checks
// nested layouts and known integer fallback, not just the five headline rows.
for (const id of ['lp64f', 'lp64d']) {
  test(`C3-02 ${id} return shares bounded flattening and refuses unproven nested layout`, () => {
    const profile = PROFILES.find(item => item.id === id), adapter = adapterFor(profile);
    for (const [parameter, expected] of [
      [{ type:'struct NestedFloat', aggregate:true, bits:64, members:[
        { type:'struct Inner', aggregate:true, bits:32, bytes:4, byteOffset:0,
          members:[{ type:'float', bits:32, bytes:4, byteOffset:0 }] },
        { type:'float', bits:32, bytes:4, byteOffset:4 },
      ] }, ['f10', 'f11']],
      [{ type:'struct NestedInteger', aggregate:true, bits:64, members:[
        { type:'struct Inner', aggregate:true, bits:32, bytes:4, byteOffset:0,
          members:[{ type:'int32', bits:32, bytes:4, byteOffset:0 }] },
        { type:'int32', bits:32, bytes:4, byteOffset:4 },
      ] }, ['x10']],
      [{ type:'struct Union', aggregate:true, bits:64,
        members:[{ type:'double', bits:64, bytes:8, byteOffset:0 }] }, id === 'lp64d' ? ['f10'] : ['x10']],
      [{ type:'union OneDouble', aggregate:true, bits:64,
        members:[{ type:'double', bits:64, bytes:8, byteOffset:0 }] }, ['x10']],
    ]) {
      const request = returnRequest(parameter);
      const argument = adapter.classifyArguments({ functionPrototype:{ parameters:[parameter] } });
      const returned = adapter.classifyFunctionReturn(request);
      assert.equal(argument.partial, false);
      assert.deepEqual(registers(argument.arguments[0]), expected);
      assert.notEqual(returned.partial, true);
      assert.equal(abiPhysicalIntervalsValid(returned), true);
      assert.deepEqual(adapter.returnLocations(request).map(location => location.reg), expected);
      const prototype = recover(adapter, { ret:parameter });
      assert.equal(prototype.returnLocationKnown, true);
      assert.deepEqual(prototype.returnLocations.map(location => location.reg), expected);
    }
    const unproven = { type:'struct UnknownNested', aggregate:true, bits:64, members:[
      { type:'struct Inner', aggregate:true, bits:32, bytes:4, byteOffset:0 },
      { type:'float', bits:32, bytes:4, byteOffset:4 },
    ] };
    const returned = adapter.classifyFunctionReturn(returnRequest(unproven));
    assert.equal(returned.partial, true);
    assert.deepEqual(adapter.returnLocations(returnRequest(unproven)), []);
  });
}
