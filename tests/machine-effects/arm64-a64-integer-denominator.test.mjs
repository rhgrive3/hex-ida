import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { ARM64_INTEGER_EFFECT_MNEMONICS } from '../../js/targets/architecture/arm64/effects/integer.js';
import {
  ARM64_A64_INTEGER_DENOMINATOR_ID,
  ARM64_A64_INTEGER_ENCODING_FAMILIES,
  ARM64_A64_INTEGER_MNEMONIC_DENOMINATOR,
  arm64A64IntegerEncodingCases,
  classifyArm64A64IntegerEncoding,
  validateArm64A64IntegerDenominator,
} from '../../tools/validation/machine-effects/arm64-a64-integer-denominator.mjs';
import { createCapstoneArm64Session } from './helpers/arm64-capstone-session.mjs';

function bytes32(word) {
  const value = Number(word) >>> 0;
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
}

function decodedInstruction(raw, id) {
  return {
    instructionId:id,
    address:raw.address,
    mnemonic:raw.mnemonic,
    operands:raw.opStr,
    opStr:raw.opStr,
    ops:parseOperands(raw.opStr),
    mode:'a64',
    origin:{ instructionIds:[id] },
  };
}

const denominator = validateArm64A64IntegerDenominator();
assert.equal(denominator.denominatorId, ARM64_A64_INTEGER_DENOMINATOR_ID);
assert.equal(denominator.encodingFamilyCount, 39);
assert.equal(denominator.encodingCaseCount, 68_901);
assert.equal(denominator.mnemonicCount,83);
assert.deepEqual([...ARM64_A64_INTEGER_MNEMONIC_DENOMINATOR].sort(),[...ARM64_INTEGER_EFFECT_MNEMONICS].sort());

const session = await createCapstoneArm64Session();
let count = 0;
const capstoneMnemonics = new Set();
try {
  let batch = [];
  function verifyBatch(items) {
    const bytes = new Uint8Array(items.length * 4);
    for (let index = 0; index < items.length; index++) bytes.set(bytes32(items[index].word), index * 4);
    const decoded = session.decode(bytes, 0x200000n + BigInt(count * 4));
    assert.equal(decoded.length, items.length, `decoder rejected valid integer case at ${items[0].id}`);
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const raw = decoded[index];
      capstoneMnemonics.add(raw.mnemonic);
      assert.ok(ARM64_INTEGER_EFFECT_MNEMONICS.has(raw.mnemonic), `${item.id}:unowned-decoder-alias:${raw.mnemonic}:${raw.opStr}`);
      const id = `arm64-integer-denominator:${item.id}`;
      const effects = liftArm64MachineEffects(decodedInstruction(raw,id));
      assert.ok(effects, `valid decoder form escaped integer ownership: ${item.id}`);
      assert.equal(effects.completeness, 'exact', `${item.id}:${raw.mnemonic}:${raw.opStr}:${effects.unknownEffects?.reason}`);
      assert.equal(effects.metadata.family, 'integer', item.id);
      count++;
    }
  }

  for (const item of arm64A64IntegerEncodingCases()) {
    // CSSC ABS is in the Arm encoding tables and in the effect registry, but
    // deployed Capstone 5 predates CSSC. Its exact direct-provider path and LLVM
    // encoding are checked below; it must not be presented as Capstone support.
    if (item.familyId === 'abs-cssc') continue;
    batch.push(item);
    if (batch.length === 1024) { verifyBatch(batch); batch = []; }
  }
  if (batch.length) verifyBatch(batch);

  for (const required of [
    'add','adds','sub','subs','neg','negs','adc','adcs','sbc','sbcs','ngc','ngcs',
    'and','ands','orr','eor','bic','bics','orn','eon','mvn','mov',
    'mul','mneg','smull','umull','smnegl','umnegl','smulh','umulh','sdiv','udiv',
    'movz','movn','movk','adr','adrp','bfc','bfi','bfxil','ubfx','sbfx','extr',
    'rbit','rev','rev16','rev32','clz','csel','csinc','csinv','csneg','cset','csetm',
  ]) assert.ok(capstoneMnemonics.has(required), `Capstone integer alias not reached: ${required}`);

  for (const word of [
    0x8bc20020, // add shifted register: reserved shift=3
    0x8b225420, // add extended register: reserved imm3=5
    0x927ffc20, // logical immediate: all-ones element is reserved
    0x52c00020, // 32-bit move-wide: hw=2 is reserved
    0x53400020, // 32-bit bitfield: N must be zero
    0x13c28020, // 32-bit EXTR: lsb=32 is reserved
    0x5ac00c20, // REV opcode reserved in 32-bit form
    0x5ac01420, // adjacent CLS encoding is not owned by this registry
    0x5ac02420, // adjacent CSSC CTZ encoding is not owned by this registry
  ]) assert.equal(classifyArm64A64IntegerEncoding(word), null, `reserved/adjacent encoding claimed: 0x${word.toString(16)}`);

  for (const [mnemonic, operands] of [
    ['smnegl','x0, w1'],
    ['movz','x0, #1, lsl #12'],
    ['ubfm','w0, w1, #32, #0'],
    ['csel','x0, x1, x2'],
  ]) {
    const effects = liftArm64MachineEffects({ instructionId:`arm64-integer-negative:${mnemonic}`, mnemonic, ops:parseOperands(operands), mode:'a64' });
    assert.equal(effects.completeness, 'partial', `${mnemonic} malformed input must fail closed`);
  }

  const preserve = liftArm64MachineEffects({
    instructionId:'arm64-integer-mov-xzr-preserve', mnemonic:'movz', mode:'a64', ops:parseOperands('xzr, #1'),
  });
  assert.equal(preserve.completeness, 'exact');
  assert.equal(preserve.operations.length, 1);
  assert.equal(preserve.operations[0]?.kind, 'register-write');
  assert.equal(preserve.operations[0]?.register?.registerId, 'pstate.btype');
  assert.equal(preserve.operations[0]?.register?.widthBits, 2);
  assert.equal(preserve.operations[0]?.value?.kind, 'bitvector');
  assert.equal(preserve.operations[0]?.value?.widthBits, 2);
  assert.equal(preserve.operations[0]?.value?.value, '0');
  assert.notEqual(preserve.statePreservation?.proven, true);

  for (const [mnemonic, operands] of [
    ['lslv','x0, x1, x2'],['lsrv','x0, x1, x2'],['asrv','x0, x1, x2'],['rorv','x0, x1, x2'],
    ['ubfm','x0, x1, #1, #2'],['sbfm','x0, x1, #1, #2'],['bfm','x0, x1, #1, #2'],
    ['uxtw','x0, w1'],['abs','x0, x1'],
  ]) {
    const effects = liftArm64MachineEffects({ instructionId:`arm64-integer-direct-alias:${mnemonic}`, mnemonic, ops:parseOperands(operands), mode:'a64' });
    assert.equal(effects.completeness, 'exact', `${mnemonic}:${effects.unknownEffects?.reason}`);
    assert.equal(effects.metadata.family, 'integer');
  }

  assert.deepEqual(session.decode(bytes32(0x5ac02020)), [], 'deployed Capstone must not be falsely credited with CSSC ABS');
  assert.deepEqual(session.decode(bytes32(0xdac02020)), [], 'deployed Capstone must not be falsely credited with CSSC ABS');
} finally {
  session.close();
}
assert.equal(count, denominator.encodingCaseCount - 2);

// LLVM MC is independent of both bundled Capstone and MachineEffects. Sample
// every standard encoding row through the disassembler, then bind the newer
// CSSC row through LLVM's explicit architectural feature gate.
const llvmMc = ['/usr/bin/llvm-mc-18','/usr/bin/llvm-mc'].find((candidate) => fs.existsSync(candidate));
assert.ok(llvmMc, 'LLVM MC 18 AArch64 oracle is required');
const onePerFamily = new Map();
for (const item of arm64A64IntegerEncodingCases()) if (!onePerFamily.has(item.familyId)) onePerFamily.set(item.familyId,item.word);
const standardWords = [...onePerFamily].filter(([id]) => id !== 'abs-cssc').map(([,word]) => word);
const oracleInput = standardWords.map((word) => [...bytes32(word)].map((byte) => `0x${byte.toString(16).padStart(2,'0')}`).join(' ')).join('\n');
const oracle = spawnSync(llvmMc,['--disassemble','--triple=aarch64'],{input:`${oracleInput}\n`,encoding:'utf8'});
assert.equal(oracle.status,0,oracle.stderr);
assert.doesNotMatch(oracle.stdout,/<unknown>/i);
for (const mnemonic of ['add','adc','and','udiv','sdiv','madd','msub','smaddl','smsubl','umaddl','umsubl','smulh','umulh','mov','movk','adr','adrp','sbfx','bfxil','ubfx','extr','rbit','rev16','rev','clz','csel','csinc','csinv','csneg']) {
  assert.match(oracle.stdout,new RegExp(`\\b${mnemonic}\\b`),`LLVM oracle omitted ${mnemonic}`);
}

const aliases = spawnSync(llvmMc,['--triple=aarch64','--show-encoding'],{
  input:'neg x0, x1\nngc x0, x1\nmvn x0, x1\nlslv x0, x1, x2\nubfm x0, x1, #1, #2\nuxtw x0, w1\ncset x0, eq\nsmnegl x0, w1, w2\numnegl x0, w1, w2\n',
  encoding:'utf8',
});
assert.equal(aliases.status,0,aliases.stderr);
assert.equal([...aliases.stdout.matchAll(/encoding: \[/g)].length,9);

const cssc = spawnSync(llvmMc,['--triple=aarch64','--mattr=+cssc','--show-encoding'],{
  input:'abs w0, w1\nabs x0, x1\n', encoding:'utf8',
});
assert.equal(cssc.status,0,cssc.stderr);
assert.equal([...cssc.stdout.matchAll(/encoding: \[/g)].length,2);
assert.match(cssc.stdout,/\[0x20,0x20,0xc0,0x5a\]/);
assert.match(cssc.stdout,/\[0x20,0x20,0xc0,0xda\]/);

assert.equal(new Set(ARM64_A64_INTEGER_ENCODING_FAMILIES.map(({ id }) => id)).size,39);
console.log(`ARM64 A64 integer denominator (${count} Capstone forms + 2 LLVM CSSC forms): PASS`);
