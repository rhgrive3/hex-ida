import assert from 'node:assert/strict';
import { withReceiverX86FlagDomainEvidence } from '../../js/targets/architecture/x86_64/runtime-provenance.js';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { dispatchX86MachineEffects, liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { closeTrustedX86Partial } from '../../js/targets/architecture/x86_64/effects/trusted-decoder-terminal.js';
import { isX87Instruction, isX87RflagsInstruction, X87_FAMILIES } from '../../js/targets/architecture/x86_64/effects/extended-state-helpers.js';

const capstone = await createCapstoneX86Session();
const hasRflags = (values) => values.some((value) => value === 'rflags' || value.startsWith('rflags.'));
const hasFpswFlags = (values) => values.some((value) => value.startsWith('fpsw.'));

function terminalizeTrustedUnit(decoded, instructionId) {
  // Public decoded rows intentionally cannot mint the private receiver-worker
  // provenance brand (#5082). Exercise the #6133 terminal contract directly
  // after dispatch, while production integration remains gated by that brand.
  const dispatched = dispatchX86MachineEffects(decoded, { instructionId });
  if (dispatched.result?.completeness !== 'partial') return dispatched.result;
  return closeTrustedX86Partial(decoded, dispatched.ownerId, dispatched.result);
}

try {
  for (const [raw, mnemonic] of [
    [[0xd9, 0xfa], 'fsqrt'], [[0xd9, 0xfe], 'fsin'], [[0xd9, 0xfb], 'fsincos'], [[0xd9, 0xfd], 'fscale'],
    [[0xdd, 0xd8], 'fstp'], [[0xd9, 0xe5], 'fxam'], [[0xd9, 0xc9], 'fxch'], [[0xd9, 0xf4], 'fxtract'],
  ]) {
    const decoded = withReceiverX86FlagDomainEvidence(createX86DecodedInstruction(capstone.decode(raw, 0x1000n)[0]));
    assert.equal(decoded.mnemonic, mnemonic);
    assert.ok(isX87Instruction(decoded, mnemonic));
    assert.equal(decoded.detail?.flagsKind, 'fpu-flags');
    const effects = terminalizeTrustedUnit(decoded, `issue-6133:${mnemonic}`);
    assert.equal(effects.completeness, 'exact-with-intrinsic');
    const summary = effects.operations[0].effectSummary;
    assert.ok(summary.registersRead.includes('x86.x87.environment'));
    assert.ok(summary.registersWritten.includes('x86.x87.environment'));
    assert.ok(!hasRflags(summary.registersRead), `${mnemonic} must not mint RFLAGS reads`);
    assert.ok(!hasRflags(summary.registersWritten), `${mnemonic} must not mint RFLAGS writes`);
    if (mnemonic === 'fsqrt') {
      for (const flag of ['c0', 'c1', 'c2', 'c3']) {
        assert.ok(summary.registersWritten.includes(`fpsw.${flag}`), `FSQRT must write fpsw.${flag}`);
      }
    }
  }

  // Capstone 5 spells the popping forms fcompi/fucompi. Both spellings must
  // stay in the x87 RFLAGS domain instead of being projected onto FPSW.C*.
  for (const [raw, family] of [
    [[0xdf, 0xe9], 'fucompi'], [[0xdf, 0xf1], 'fcompi'], [[0xdb, 0xe9], 'fucomi'], [[0xda, 0xd1], 'fcmovbe'],
  ]) {
    const decoded = withReceiverX86FlagDomainEvidence(createX86DecodedInstruction(capstone.decode(raw, 0x2000n)[0]));
    assert.equal(decoded.instructionFamily, family);
    assert.ok(X87_FAMILIES.has(family));
    assert.ok(isX87Instruction(decoded, family));
    assert.ok(isX87RflagsInstruction(decoded, family));
    assert.equal(decoded.detail?.flagsKind, 'eflags');
    const effects = terminalizeTrustedUnit(decoded, `issue-6133:${family}`);
    assert.equal(effects.completeness, 'exact-with-intrinsic');
    const summary = effects.operations[0].effectSummary;
    if (family === 'fcmovbe') {
      // FCMOV consumes the condition-code source; a write-only RFLAGS
      // summary would not prove that the terminal decoder retained the
      // condition dependency.
      assert.ok(hasRflags(summary.registersRead), 'fcmovbe must read RFLAGS');
      assert.ok(!hasFpswFlags(summary.registersRead), 'fcmovbe must not read FPSW');
      assert.ok(
        summary.registersRead.includes('x86.x87.environment'),
        'fcmovbe must read x86.x87.environment',
      );
    } else {
      const flags = [...summary.registersRead, ...summary.registersWritten];
      assert.ok(hasRflags(flags), `${family} must retain RFLAGS evidence`);
      assert.ok(!hasFpswFlags(flags), `${family} must not reinterpret EFLAGS as FPSW.C*`);
    }
    assert.ok(summary.registersWritten.includes('x86.x87.environment'));
  }

  const fcomi = withReceiverX86FlagDomainEvidence(createX86DecodedInstruction(capstone.decode([0xdb, 0xf1], 0x2100n)[0]));
  assert.equal(fcomi.mnemonic, 'fcomi');
  assert.ok(isX87Instruction(fcomi, 'fcomi'));
  assert.equal(fcomi.detail?.flagsKind, 'eflags');
  const fcomiEffects = terminalizeTrustedUnit(fcomi, 'issue-6133:fcomi');
  assert.equal(fcomiEffects.completeness, 'exact-with-intrinsic');
  const fcomiSummary = fcomiEffects.operations[0].effectSummary;
  assert.ok(fcomiSummary.registersRead.includes('x86.x87.environment'));
  assert.ok(fcomiSummary.registersWritten.includes('x86.x87.environment'));
  assert.ok(fcomiSummary.registersWritten.some((value) => value.startsWith('rflags.')));
  assert.ok(!fcomiSummary.registersWritten.some((value) => value.startsWith('fpsw.')));

  const add = createX86DecodedInstruction(capstone.decode([0x01, 0xd8], 0x3000n)[0]);
  assert.ok(!isX87Instruction(add, 'add'));
  const addEffects = liftX86MachineEffects(add, { instructionId: 'issue-6133:add' });
  assert.ok(addEffects.operations.filter((op) => op.kind === 'flag-write').some((op) => op.flag.flagId.startsWith('RFLAGS.')));

  const rdrand = withReceiverX86FlagDomainEvidence(createX86DecodedInstruction(capstone.decode([0x0f, 0xc7, 0xf0], 0x3010n)[0]));
  const randomEffects = terminalizeTrustedUnit(rdrand, 'issue-6133:rdrand');
  assert.equal(randomEffects.completeness, 'exact-with-intrinsic');
  const randomFlags = randomEffects.operations[0].effectSummary.registersWritten;
  assert.ok(hasRflags(randomFlags));
  assert.ok(!hasFpswFlags(randomFlags));

  // A forged or stale flagsKind must not override the architectural identity
  // inferred from the family and decoder groups. Both mismatch directions
  // remain partial so trusted terminalization stays fail-closed.
  const mismatchPartial = (family) => Object.freeze({
    instructionId:`issue-6133:mismatch:${family}`,
    architectureId:'x86_64',
    mode:'long-64',
    completeness:'partial',
    controlEffect:Object.freeze({ kind:'unknown', reason:'x86-effects-unproven' }),
    possibleFaults:Object.freeze([]),
  });
  const trustedMismatch = (family, flagsKind, groups, rawBytes) => Object.freeze({
    instructionFamily:family,
    length:rawBytes.length,
    rawBytes:Uint8Array.from(rawBytes),
    decoderSemanticVersion:'capstone-5-x86-structured-v2',
    detailAvailable:true,
    detailStatus:'complete',
    detail:Object.freeze({
      abiContractVersion:'capstone-5-wasm32-x86-detail/v1',
      operands:Object.freeze([]),
      groups:Object.freeze(groups.map((name) => Object.freeze({ name }))),
      eflags:0n,
      flagsKind,
    }),
  });
  const nonX87WithFpuFlags = closeTrustedX86Partial(
    trustedMismatch('add', 'fpu-flags', [], [0x01, 0xd8]),
    'integer',
    mismatchPartial('add'),
  );
  assert.equal(nonX87WithFpuFlags.completeness, 'partial');
  const x87WithEflags = closeTrustedX86Partial(
    trustedMismatch('fsqrt', 'eflags', ['fpu'], [0xd9, 0xfa]),
    'fp',
    mismatchPartial('fsqrt'),
  );
  assert.equal(x87WithEflags.completeness, 'partial');

  console.log('issue #6133 x87 trusted terminal flags tests: PASS');
} finally {
  capstone.close();
}
