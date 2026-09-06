import assert from 'node:assert/strict';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { isX87Instruction, isX87RflagsInstruction, X87_FAMILIES } from '../../js/targets/architecture/x86_64/effects/extended-state-helpers.js';

const capstone = await createCapstoneX86Session();
const hasRflags = (values) => values.some((value) => value === 'rflags' || value.startsWith('rflags.'));
const hasFpswFlags = (values) => values.some((value) => value.startsWith('fpsw.'));

try {
  for (const [raw, mnemonic] of [
    [[0xd9, 0xfa], 'fsqrt'], [[0xd9, 0xfe], 'fsin'], [[0xd9, 0xfd], 'fscale'],
    [[0xdd, 0xd8], 'fstp'], [[0xd9, 0xe5], 'fxam'], [[0xd9, 0xc9], 'fxch'], [[0xd9, 0xf4], 'fxtract'],
  ]) {
    const decoded = createX86DecodedInstruction(capstone.decode(raw, 0x1000n)[0]);
    assert.equal(decoded.mnemonic, mnemonic);
    assert.ok(isX87Instruction(decoded, mnemonic));
    const effects = liftX86MachineEffects(decoded, { instructionId: `issue-6133:${mnemonic}` });
    assert.equal(effects.completeness, 'exact-with-intrinsic');
    const summary = effects.operations[0].effectSummary;
    assert.ok(summary.registersRead.includes('x86.x87.environment'));
    assert.ok(summary.registersWritten.includes('x86.x87.environment'));
    assert.ok(!hasRflags(summary.registersWritten), `${mnemonic} must not mint RFLAGS writes`);
  }

  // Capstone 5 spells the popping forms fcompi/fucompi. Both spellings must
  // stay in the x87 RFLAGS domain instead of being projected onto FPSW.C*.
  for (const [raw, family] of [
    [[0xdf, 0xe9], 'fucompi'], [[0xdf, 0xf1], 'fcompi'], [[0xdb, 0xe9], 'fucomi'], [[0xda, 0xd1], 'fcmovbe'],
  ]) {
    const decoded = createX86DecodedInstruction(capstone.decode(raw, 0x2000n)[0]);
    assert.equal(decoded.instructionFamily, family);
    assert.ok(X87_FAMILIES.has(family));
    assert.ok(isX87Instruction(decoded, family));
    assert.ok(isX87RflagsInstruction(decoded, family));
    const effects = liftX86MachineEffects(decoded, { instructionId: `issue-6133:${family}` });
    assert.equal(effects.completeness, 'exact-with-intrinsic');
    const summary = effects.operations[0].effectSummary;
    const flags = [...summary.registersRead, ...summary.registersWritten];
    assert.ok(hasRflags(flags), `${family} must retain RFLAGS evidence`);
    assert.ok(!hasFpswFlags(flags), `${family} must not reinterpret EFLAGS as FPSW.C*`);
    assert.ok(summary.registersWritten.includes('x86.x87.environment'));
  }

  const add = createX86DecodedInstruction(capstone.decode([0x01, 0xd8], 0x3000n)[0]);
  assert.ok(!isX87Instruction(add, 'add'));
  const addEffects = liftX86MachineEffects(add, { instructionId: 'issue-6133:add' });
  assert.ok(addEffects.operations.filter((op) => op.kind === 'flag-write').some((op) => op.flag.flagId.startsWith('RFLAGS.')));

  const rdrand = createX86DecodedInstruction(capstone.decode([0x0f, 0xc7, 0xf0], 0x3010n)[0]);
  const randomEffects = liftX86MachineEffects(rdrand, { instructionId: 'issue-6133:rdrand' });
  assert.equal(randomEffects.completeness, 'exact-with-intrinsic');
  const randomFlags = randomEffects.operations[0].effectSummary.registersWritten;
  assert.ok(hasRflags(randomFlags));
  assert.ok(!hasFpswFlags(randomFlags));

  console.log('issue #6133 x87 trusted terminal flags tests: PASS');
} finally {
  capstone.close();
}
