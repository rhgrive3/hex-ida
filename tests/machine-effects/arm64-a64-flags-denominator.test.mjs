import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import {
  ARM64_A64_FLAGS_DENOMINATOR_ID,
  arm64A64FlagEncodingCases,
  classifyArm64A64FlagEncoding,
  validateArm64A64FlagsDenominator,
} from '../../tools/validation/machine-effects/arm64-a64-flags-denominator.mjs';
import { createCapstoneArm64Session } from './helpers/arm64-capstone-session.mjs';

function bytes32(word) { const value=Number(word)>>>0; return Uint8Array.of(value&255,(value>>>8)&255,(value>>>16)&255,value>>>24); }

const denominator = validateArm64A64FlagsDenominator();
assert.equal(denominator.denominatorId, ARM64_A64_FLAGS_DENOMINATOR_ID);
assert.equal(denominator.encodingFamilyCount, 12);

const session = await createCapstoneArm64Session();
let count = 0;
try {
  let batch = [];
  function verifyBatch(items) {
    const bytes = new Uint8Array(items.length * 4);
    for (let index=0; index<items.length; index++) bytes.set(bytes32(items[index].word), index*4);
    const decoded = session.decode(bytes, 0x200000n + BigInt(count*4));
    assert.equal(decoded.length, items.length, `valid flags batch rejected at ${items[0].id}`);
    for (let index=0; index<items.length; index++) {
      const item=items[index], raw=decoded[index];
      assert.equal(raw.mnemonic, item.operation, `${item.id}:${raw.mnemonic}:${raw.opStr}`);
      const instructionId=`arm64-flags-denominator:${item.id}`;
      const effects=liftArm64MachineEffects({
        instructionId, address:raw.address, mnemonic:raw.mnemonic, operands:raw.opStr, opStr:raw.opStr,
        ops:parseOperands(raw.opStr), mode:'a64', origin:{instructionIds:[instructionId]},
      });
      assert.ok(effects, `valid flags form escaped ownership: ${item.id}`);
      assert.equal(effects.completeness, 'exact', `${item.id}:${effects.unknownEffects?.reason}`);
      assert.equal(effects.metadata.family, 'flags', item.id);
      assert.deepEqual(effects.operations.filter((operation)=>operation.kind==='flag-write').map((operation)=>operation.flag.flagId).sort(), ['NZCV.C','NZCV.N','NZCV.V','NZCV.Z']);
      count++;
    }
  }
  for (const item of arm64A64FlagEncodingCases()) { batch.push(item); if (batch.length===1024) { verifyBatch(batch); batch=[]; } }
  if (batch.length) verifyBatch(batch);

  for (const word of [0x6bc1001f,0x6b01801f,0x6b21141f,0xf200fc1f,0x7a400010]) {
    assert.equal(classifyArm64A64FlagEncoding(word), null, `reserved/adjacent encoding claimed: 0x${word.toString(16)}`);
  }
  const malformed=liftArm64MachineEffects({instructionId:'arm64-flags-negative',mnemonic:'ccmp',ops:parseOperands('x0, x1, #16, eq'),mode:'a64'});
  assert.equal(malformed.completeness,'partial');
} finally { session.close(); }
assert.equal(count, denominator.encodingCaseCount);

const llvmMc=['/usr/bin/llvm-mc-18','/usr/bin/llvm-mc'].find((candidate)=>fs.existsSync(candidate));
assert.ok(llvmMc);
const oracle=spawnSync(llvmMc,['--triple=aarch64','--show-encoding'],{
  input:'cmp x0, x1\ncmp x0, x1, uxtx #4\ncmp x0, #4095, lsl #12\ncmn w0, w1\ntst x0, x1, ror #63\ntst x0, #0x8000000000000001\nccmp x0, x1, #15, nv\nccmn w0, #31, #0, eq\n',encoding:'utf8',
});
assert.equal(oracle.status,0,oracle.stderr);
for(const mnemonic of ['cmp','cmn','tst','ccmp','ccmn']) assert.match(oracle.stdout,new RegExp(`\\b${mnemonic}\\b`));
assert.equal([...oracle.stdout.matchAll(/encoding: \[/g)].length,8);

console.log(`ARM64 A64 flags denominator (${count} finite discriminator cases): PASS`);
