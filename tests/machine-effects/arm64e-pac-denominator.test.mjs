import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64eEffects } from '../../js/targets/architecture/arm64e/effects.js';
import {
  ARM64E_PAC_ENCODING_FAMILIES,
  ARM64E_PAC_DENOMINATOR_ID,
  arm64ePacEncodingCases,
  classifyArm64ePacEncoding,
  validateArm64ePacDenominator,
} from '../../tools/validation/machine-effects/arm64e-pac-denominator.mjs';
import { createCapstoneArm64Session } from './helpers/arm64-capstone-session.mjs';

function bytes32(word) { const value=Number(word)>>>0; return Uint8Array.of(value&255,(value>>>8)&255,(value>>>16)&255,value>>>24); }
const denominator = validateArm64ePacDenominator();
assert.equal(denominator.denominatorId,ARM64E_PAC_DENOMINATOR_ID);
assert.equal(denominator.encodingFamilyCount,38);
assert.equal(denominator.encodingCaseCount,45_515);

// PACGA encodes its modifier in Rm and interprets Rm==31 as SP. This is a
// valid discriminator boundary, not a reserved row to remove from the corpus.
const pacgaSpWord = 0x9adf3020; // pacga x0, x1, sp
assert.equal(classifyArm64ePacEncoding(pacgaSpWord)?.mnemonic,'pacga');
assert.equal([...arm64ePacEncodingCases()].some((item)=>item.word===pacgaSpWord),true);

const session = await createCapstoneArm64Session();
let count=0;
try {
  let batch=[];
  function verifyBatch(items) {
    const bytes=new Uint8Array(items.length*4);
    for(let index=0;index<items.length;index++) bytes.set(bytes32(items[index].word),index*4);
    const decoded=session.decode(bytes,0x100000n+BigInt(count*4));
    assert.equal(decoded.length,items.length,`Capstone rejected ${items[0].id}`);
    for(let index=0;index<items.length;index++) {
      const item=items[index]; const raw=decoded[index];
      assert.equal(raw.mnemonic,item.mnemonic,`${item.id}:${raw.opStr}`);
      const instructionId=`arm64e-pac-denominator:${item.id}`;
      const effects=liftArm64eEffects({ instructionId,address:raw.address,mnemonic:raw.mnemonic,opStr:raw.opStr,ops:parseOperands(raw.opStr),mode:'arm64e',origin:{instructionIds:[instructionId]} });
      assert.ok(effects,`${item.id}: escaped PAC ownership`);
      assert.equal(effects.completeness,'exact-with-intrinsic',`${item.id}:${effects.unknownEffects?.reason}`);
      assert.equal(effects.metadata.family,'arm64e-pointer-authentication');
      count++;
    }
  }
  for(const item of arm64ePacEncodingCases()) { batch.push(item); if(batch.length===1024){verifyBatch(batch);batch=[];} }
  if(batch.length) verifyBatch(batch);
} finally { session.close(); }
assert.equal(count,denominator.encodingCaseCount);

for(const word of [0x9aff3020,0xd71f0000,0xd503201f]) assert.equal(classifyArm64ePacEncoding(word),null,`reserved/adjacent encoding claimed:0x${word.toString(16)}`);
const malformed=liftArm64eEffects({instructionId:'arm64e-pac-negative:missing',mnemonic:'pacia',ops:[],mode:'arm64e'});
assert.equal(malformed.completeness,'partial');
assert.match(malformed.unknownEffects.reason,/destination register is unavailable/);
const zeroDestination=liftArm64eEffects({instructionId:'arm64e-pac:xzr',mnemonic:'pacia',ops:parseOperands('xzr, sp'),mode:'arm64e'});
assert.equal(zeroDestination.completeness,'exact-with-intrinsic');
assert.equal(zeroDestination.operations.some((operation)=>operation.kind==='register-write'&&operation.register?.id==='xzr'),false);
const spModifier=liftArm64eEffects({instructionId:'arm64e-pac:pacga-sp',mnemonic:'pacga',ops:parseOperands('x0, x1, sp'),mode:'arm64e'});
assert.equal(spModifier.completeness,'exact-with-intrinsic');
assert.equal(spModifier.operations.some((operation)=>operation.kind==='register-read'&&operation.register?.registerId==='sp'),true);

const llvmMc=['/usr/bin/llvm-mc-18','/usr/bin/llvm-mc'].find((candidate)=>fs.existsSync(candidate));
assert.ok(llvmMc);
const sampleWords=ARM64E_PAC_ENCODING_FAMILIES.map(({match})=>match);
const oracleInput=sampleWords.map((word)=>[...bytes32(word)].map((byte)=>`0x${byte.toString(16).padStart(2,'0')}`).join(' ')).join('\n');
const oracle=spawnSync(llvmMc,['--disassemble','--triple=aarch64','--mattr=+pauth'],{input:`${oracleInput}\n`,encoding:'utf8'});
assert.equal(oracle.status,0,oracle.stderr);
assert.doesNotMatch(oracle.stdout,/<unknown>/i);
for(const mnemonic of new Set(ARM64E_PAC_ENCODING_FAMILIES.map(({mnemonic})=>mnemonic))) assert.match(oracle.stdout,new RegExp(`\\b${mnemonic}\\b`),`LLVM omitted ${mnemonic}`);

const pacgaSpOracle=spawnSync(llvmMc,['--disassemble','--triple=aarch64','--mattr=+pauth'],{
  input:`${[...bytes32(pacgaSpWord)].map((byte)=>`0x${byte.toString(16).padStart(2,'0')}`).join(' ')}\n`,encoding:'utf8',
});
assert.equal(pacgaSpOracle.status,0,pacgaSpOracle.stderr);
assert.match(pacgaSpOracle.stdout,/\bpacga\s+x0,\s*x1,\s*sp\b/i);

console.log(`ARM64e PAC denominator (${count} finite discriminator cases): PASS`);
