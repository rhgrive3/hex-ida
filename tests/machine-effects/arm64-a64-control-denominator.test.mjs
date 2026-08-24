import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import {
  ARM64_A64_CONTROL_ENCODING_FAMILIES,
  ARM64_A64_CONTROL_DENOMINATOR_ID,
  arm64A64ControlEncodingCases,
  classifyArm64A64ControlEncoding,
  validateArm64A64ControlDenominator,
} from '../../tools/validation/machine-effects/arm64-a64-control-denominator.mjs';
import { createCapstoneArm64Session } from './helpers/arm64-capstone-session.mjs';

function bytes32(word) {
  const value = Number(word) >>> 0;
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
}

const denominator = validateArm64A64ControlDenominator();
assert.equal(denominator.denominatorId, ARM64_A64_CONTROL_DENOMINATOR_ID);
assert.equal(denominator.encodingFamilyCount, 10);
assert.equal(denominator.encodingCaseCount, 21_306);

const session = await createCapstoneArm64Session();
let count = 0;
try {
  let batch = [];
  function verifyBatch(items) {
    const bytes = new Uint8Array(items.length * 4);
    for (let index = 0; index < items.length; index++) bytes.set(bytes32(items[index].word), index * 4);
    const decoded = session.decode(bytes, 0x100000n + BigInt(count * 4));
    assert.equal(decoded.length, items.length, `decoder rejected a valid control case at ${items[0].id}`);
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const raw = decoded[index];
      assert.equal(raw.size, 4, item.id);
      assert.equal(raw.mnemonic, item.operation, `${item.id}:${raw.opStr}`);
      const instructionId = `arm64-control-denominator:${item.id}`;
      const instruction = {
        instructionId,
        address:raw.address,
        mnemonic:raw.mnemonic,
        operands:raw.opStr,
        opStr:raw.opStr,
        ops:parseOperands(raw.opStr),
        mode:'a64',
        origin:{ instructionIds:[instructionId] },
      };
      const effects = liftArm64MachineEffects(instruction);
      assert.ok(effects, `valid decoder form escaped control ownership: ${item.id}`);
      assert.equal(effects.completeness, 'exact', `valid control form became partial: ${item.id}:${effects.unknownEffects?.reason}`);
      assert.equal(effects.metadata.family, 'control', item.id);
      count++;
    }
  }
  for (const item of arm64A64ControlEncodingCases()) {
    batch.push(item);
    if (batch.length === 1024) { verifyBatch(batch); batch = []; }
  }
  if (batch.length) verifyBatch(batch);

  // Nearby encodings must not be smuggled into this family. BC.cond belongs to
  // a distinct extension encoding, ERET is a system transition, and a damaged
  // fixed BR field is not one of the ten denominator rows.
  for (const word of [0x54000010,0xd69f03e0,0xd61f0001]) {
    assert.equal(classifyArm64A64ControlEncoding(word), null, `negative claimed as control: 0x${word.toString(16)}`);
  }

  const malformedTarget = liftArm64MachineEffects({ instructionId:'arm64-control-negative:b', mnemonic:'b', ops:[], mode:'a64' });
  assert.equal(malformedTarget.completeness, 'partial');
  const malformedBit = liftArm64MachineEffects({
    instructionId:'arm64-control-negative:tbz', address:0x1000n, mnemonic:'tbz', mode:'a64',
    ops:parseOperands('w0, #32, #0x2000'),
  });
  assert.equal(malformedBit.completeness, 'partial');
  const malformedRegister = liftArm64MachineEffects({ instructionId:'arm64-control-negative:br', mnemonic:'br', ops:[], mode:'a64' });
  assert.equal(malformedRegister.completeness, 'partial');
  assert.match(malformedRegister.unknownEffects.reason, /target-register-unmodelled/);

  for (const alias of ['b.cs','b.hs','b.cc','b.lo']) {
    const instructionId = `arm64-control-alias:${alias}`;
    const effects = liftArm64MachineEffects({
      instructionId, address:0x4000n, mnemonic:alias, mode:'a64',
      ops:parseOperands('#0x5000'), origin:{ instructionIds:[instructionId] },
    });
    assert.equal(effects.completeness, 'exact', `${alias} must share its canonical condition encoding path`);
  }
} finally {
  session.close();
}
assert.equal(count, denominator.encodingCaseCount);

// LLVM MC is independent of both the bundled Capstone decoder and the
// MachineEffects implementation. Sample every encoding family, aliases and
// boundary forms through its AArch64 disassembler.
const llvmMc = ['/usr/bin/llvm-mc-18','/usr/bin/llvm-mc'].find((candidate) => fs.existsSync(candidate));
assert.ok(llvmMc, 'LLVM MC 18 AArch64 oracle is required');
const oracleWords = [
  0x14000001,0x94000001,0x54000020,0x34000020,0xb5000021,
  0x36000022,0xb7080023,0xd61f0060,0xd63f0080,0xd65f03c0,
];
const oracleInput = oracleWords.map((word) => [...bytes32(word)].map((byte) => `0x${byte.toString(16).padStart(2,'0')}`).join(' ')).join('\n');
const oracle = spawnSync(llvmMc, ['--disassemble','--triple=aarch64'], { input:`${oracleInput}\n`, encoding:'utf8' });
assert.equal(oracle.status, 0, oracle.stderr);
for (const mnemonic of ['b','bl','b.eq','cbz','cbnz','tbz','tbnz','br','blr','ret']) {
  assert.match(oracle.stdout, new RegExp(`\\b${mnemonic.replace('.', '\\.') }\\b`), `LLVM oracle omitted ${mnemonic}`);
}
const aliases = spawnSync(llvmMc, ['--triple=aarch64','--show-encoding'], {
  input:'b.cs #4\nb.hs #4\nb.cc #4\nb.lo #4\nret\nret x30\n', encoding:'utf8',
});
assert.equal(aliases.status, 0, aliases.stderr);
const aliasEncodings = [...aliases.stdout.matchAll(/encoding: \[([^\]]+)\]/g)].map((match) => match[1]);
assert.equal(aliasEncodings.length, 6);
assert.equal(aliasEncodings[0], aliasEncodings[1], 'CS and HS aliases must bind the same encoding');
assert.equal(aliasEncodings[2], aliasEncodings[3], 'CC and LO aliases must bind the same encoding');
assert.equal(aliasEncodings[4], aliasEncodings[5], 'implicit and explicit X30 RET aliases must bind the same encoding');

assert.equal(new Set(ARM64_A64_CONTROL_ENCODING_FAMILIES.map(({ id }) => id)).size, 10);
console.log(`ARM64 A64 control denominator (${count} finite discriminator cases): PASS`);
