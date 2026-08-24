import assert from 'node:assert/strict';

import { validateMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import {
  X86_LONG64_SYSTEM_DENOMINATOR_ID,
  X86_LONG64_SYSTEM_FAMILY_ROWS,
  X86_LONG64_SYSTEM_SHARED_DEPENDENCIES,
  validateX86Long64SystemDenominator,
  x86Long64SystemEncodingCases,
} from '../../tools/validation/machine-effects/x86-long64-system-denominator.mjs';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import {
  X86_SYSTEM_ENVIRONMENT_OUTPUT_FAMILIES,
  X86_SYSTEM_FENCE_FAMILIES,
  X86_SYSTEM_NEGATIVE_FIXTURES,
  X86_SYSTEM_PREFIX_QUOTIENT_FIXTURES,
  X86_SYSTEM_REQUIRED_FAULT_FAMILIES,
} from './helpers/x86-long64-system-fixtures.mjs';

const ops = (bundle, kind) => bundle.operations.filter((op) => op.kind === kind);
const intrinsic = (bundle, id) => ops(bundle, 'intrinsic').find((op) => !id || op.intrinsicId === id);
const faultText = (bundle) => bundle.possibleFaults.map((fault) => `${fault.kind}:${fault.detail?.fault ?? fault.detail?.vector ?? ''}`).join('|');

const identity = validateX86Long64SystemDenominator();
assert.equal(identity.denominatorId, X86_LONG64_SYSTEM_DENOMINATOR_ID);
assert.equal(identity.profileId, 'x86_64:long-64');
assert.equal(identity.familyCount, 25);
assert.equal(identity.encodingCaseCount, 104);
assert.deepEqual(identity.discriminatorDimensions, ['opcode/family','privilege','environment','prefix','operand/state','implicit-state']);
assert.match(identity.quotientProof.prefix, /cross-vendor architecturally defined prefix class/i);
assert.match(identity.quotientProof.environment, /symbolic architectural/i);
assert.equal(identity.sharedDependencyRequired, true);
assert.ok(identity.oracleIds.some((id) => /intel-sdm/i.test(id)));
assert.ok(identity.oracleIds.some((id) => /amd64-apm/i.test(id)));
assert.ok(identity.oracleIds.some((id) => /capstone.*structured-decoder/i.test(id)));

for (const row of X86_LONG64_SYSTEM_FAMILY_ROWS) {
  for (const [name, values] of Object.entries({ opcode:row.opcode, prefix:row.prefixes, operand:row.operands, privilege:row.privilege, environment:row.environment, implicitState:row.implicitState })) {
    assert.ok(values.length > 0, `${row.family}:${name}`);
  }
}

const session = await createCapstoneX86Session();
const byFamily = new Map();
const byCase = new Map();
let caseCount = 0;
try {
  for (const candidate of x86Long64SystemEncodingCases()) {
    const decoded = session.decode(candidate.bytes, 0x400000n + BigInt(caseCount * 0x20));
    assert.equal(decoded.length, 1, `${candidate.id}:decoder-cardinality`);
    assert.equal(decoded[0].length, candidate.bytes.length, `${candidate.id}:full-length`);
    assert.equal(decoded[0].instructionFamily, candidate.family, `${candidate.id}:family`);

    const effects = liftX86MachineEffects(createX86DecodedInstruction({ ...decoded[0], instructionId:`x86-system:${candidate.id}` }));
    assert.ok(['exact','exact-with-intrinsic'].includes(effects?.completeness), `${candidate.id}:${effects?.unknownEffects?.reason}`);
    assert.equal(effects.metadata.family, 'system', candidate.id);
    assert.notEqual(effects.controlEffect.kind, 'unknown', candidate.id);
    assert.doesNotThrow(() => validateMachineEffectBundle(effects), candidate.id);
    for (const op of ops(effects, 'intrinsic')) {
      assert.equal(op.metadata.exactArchitecturalSummary, true, `${candidate.id}:${op.intrinsicId}`);
      assert.notEqual(op.effectSummary.determinism, 'unknown', candidate.id);
      assert.notEqual(op.effectSummary.memoryRead.scope, 'unknown', candidate.id);
      assert.notEqual(op.effectSummary.memoryWrite.scope, 'unknown', candidate.id);
    }
    byFamily.set(candidate.family, byFamily.get(candidate.family) ?? effects);
    byCase.set(candidate.id, effects);
    caseCount++;
  }

  for (const fixture of X86_SYSTEM_NEGATIVE_FIXTURES) {
    const decoded = session.decode(fixture.bytes, 0x700000n);
    if (fixture.expectedFamily == null) assert.equal(decoded.length, 0, fixture.id);
    else assert.equal(decoded[0]?.instructionFamily, fixture.expectedFamily, fixture.id);
  }

  for (const fixture of X86_SYSTEM_PREFIX_QUOTIENT_FIXTURES) {
    const decoded = session.decode(fixture.bytes, 0x708000n);
    assert.equal(decoded[0]?.instructionFamily, fixture.expectedFamily, fixture.id);
    assert.equal(decoded[0]?.length, fixture.bytes.length, fixture.id);
    const effects = liftX86MachineEffects(createX86DecodedInstruction({ ...decoded[0], instructionId:`x86-system-prefix:${fixture.id}` }));
    assert.ok(['exact','exact-with-intrinsic'].includes(effects?.completeness), fixture.id);
  }

  // Decoder acceptance is not the oracle: F0+F3 are same-group legacy prefixes,
  // undefined by AMD. Never promote this PAUSE-shaped byte stream to cross-vendor exact.
  const lockPauseRaw = session.decode(Uint8Array.of(0xf0,0xf3,0x90), 0x710000n);
  assert.equal(lockPauseRaw[0]?.instructionFamily, 'pause');
  const lockPause = liftX86MachineEffects(createX86DecodedInstruction({ ...lockPauseRaw[0], instructionId:'x86-system:lock-pause' }));
  assert.equal(lockPause.completeness, 'partial');
  assert.equal(lockPause.metadata.encodingValidated, false);

  const cpuidRaw = session.decode(Uint8Array.of(0x0f,0xa2), 0x720000n)[0];
  assert.throws(() => createX86DecodedInstruction({ ...cpuidRaw, instructionId:'x86-system:bad-mode', mode:'legacy-32' }), /mode-unsupported/);
} finally {
  session.close();
}

assert.equal(caseCount, identity.encodingCaseCount);
assert.equal(byFamily.size, 25);

// Fence semantics remain distinct rather than collapsing to a generic barrier.
const fenceRelations = new Set();
for (const family of X86_SYSTEM_FENCE_FAMILIES) {
  const effect = byFamily.get(family);
  const barrier = ops(effect, 'barrier')[0];
  assert.equal(effect.completeness, 'exact');
  assert.equal(barrier.metadata.fenceKind, family);
  fenceRelations.add(JSON.stringify(barrier.scope.memoryOrdering));
}
assert.equal(fenceRelations.size, 3);

// Environment-produced values stay symbolic; no host/VM value is guessed.
for (const family of X86_SYSTEM_ENVIRONMENT_OUTPUT_FAMILIES) {
  const op = intrinsic(byFamily.get(family), `x86.system.${family}`);
  assert.ok(op, family);
  assert.equal(op.metadata.noHostConstant, true, family);
  assert.ok(op.effectSummary.outputs.length > 0, family);
  assert.ok(op.effectSummary.outputs.every((value) => value.kind === 'temporary'), family);
}

for (const family of X86_SYSTEM_REQUIRED_FAULT_FAMILIES) {
  assert.ok(byFamily.get(family).possibleFaults.length > 0, `${family}:fault-surface`);
}
assert.match(faultText(byFamily.get('rdtsc')), /general-protection|#GP/i);
assert.match(faultText(byFamily.get('rdtscp')), /undefined-opcode|#UD/i);
assert.match(faultText(byFamily.get('syscall')), /undefined-opcode|#UD/i);
assert.match(faultText(byFamily.get('swapgs')), /general-protection|#GP/i);
assert.match(faultText(byFamily.get('swapgs')), /undefined-opcode|#UD/i);

// SYSRET compatibility target is ECX-derived; SYSRETQ retains RCX canonicality checks.
assert.ok(byFamily.get('sysret').operations.some((op) => op.kind === 'value' && op.metadata?.semantic === 'x86-sysret-compat-target-ecx'));
assert.equal(byFamily.get('sysret').possibleFaults.some((fault) => fault.condition?.kind === 'x86-noncanonical-sysret-target'), false);
assert.equal(byFamily.get('sysretq').possibleFaults.some((fault) => fault.condition?.kind === 'x86-noncanonical-sysret-target'), true);

// CLI/STI depend on CPL/IOPL/PVI/VIP, and STI carries interruptibility state.
for (const family of ['cli','sti']) {
  const op = intrinsic(byFamily.get(family), `x86.system.${family}`);
  assert.ok(op.metadata.stateDiscriminators.includes('CPL'));
  assert.ok(op.metadata.stateDiscriminators.includes('IOPL'));
  assert.equal(op.metadata.noFixedPrivilegeAssumption, true);
  assert.match(faultText(byFamily.get(family)), /general-protection|#GP/i);
}
const sti = intrinsic(byFamily.get('sti'), 'x86.system.sti');
assert.ok(sti.effectSummary.registersRead.includes('sys:x86.interruptibility-state'));
assert.ok(sti.effectSummary.registersWritten.includes('sys:x86.interruptibility-state'));

// Descriptor/table operations expose explicit and implicit memory effects.
for (const family of ['lgdt','lidt']) {
  const op = intrinsic(byCase.get(`${family}:none:m80-base`), `x86.system.${family}`);
  assert.equal(op.effectSummary.memoryRead.scope, 'accesses');
  assert.equal(op.effectSummary.memoryRead.accesses[0].widthBits, 80);
}
const lldt = intrinsic(byCase.get('lldt:none:r16-ax'), 'x86.system.lldt');
assert.equal(lldt.effectSummary.memoryRead.scope, 'all');
assert.equal(lldt.effectSummary.memoryWrite.scope, 'none');
const ltr = intrinsic(byCase.get('ltr:none:r16-ax'), 'x86.system.ltr');
assert.equal(ltr.effectSummary.memoryRead.scope, 'all');
assert.equal(ltr.effectSummary.memoryWrite.scope, 'all');
assert.match(ltr.metadata.descriptorBusyWrite, /locked-read-modify-write.*busy bit/i);

// Caller-supplied family strings cannot launder malformed bytes into exactness.
for (const family of ['cpuid','clc']) {
  const fake = createX86DecodedInstruction({
    instructionId:`x86-system:malformed-${family}`, instructionCode:1, instructionFamily:family,
    address:0x730000n, length:1, rawBytes:Uint8Array.of(0x90), mode:'long-64', detailAvailable:true,
    detailStatus:'complete', mnemonic:family, opStr:'',
    detail:{ operandCount:0, operands:[], prefixes:{ legacy:[], rex:null, vector:null }, implicitReads:[], implicitWrites:[], conditionCode:null },
  });
  const effect = liftX86MachineEffects(fake);
  assert.equal(effect.completeness, 'partial');
  assert.equal(effect.metadata.encodingValidated, false);
}

assert.deepEqual(
  X86_LONG64_SYSTEM_SHARED_DEPENDENCIES[0].requiredOwners,
  ['js/targets/architecture/x86_64/effects/index.js','js/targets/architecture/x86_64/effects/integer.js','js/targets/architecture/x86_64/registers-core.js'],
);

console.log(`x86 long-64 system denominator (${caseCount} encoding discriminators / ${identity.familyCount} families): PASS`);
