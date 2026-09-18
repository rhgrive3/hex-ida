import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { validateMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { RANDOM_CASES,verifyRandomValues,evaluateRandomTransfer } from './helpers/random-oracle.mjs';
import { X86_LONG64_DECODER_WITNESSES } from '../../tools/validation/machine-effects/fixtures/x86-long64-decoder-witnesses.mjs';
import { forEachX86BrowserSession } from './helpers/x86-browser-effects.mjs';

const nativePath=process.env.HEX_X86_RANDOM_ORACLE;
const reportPath=process.env.HEX_X86_RANDOM_ORACLE_REPORT;
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const sha=value=>createHash('sha256').update(value).digest('hex');
const productHead=git('rev-parse','HEAD');
if(reportPath) {
  assert.ok(nativePath,'native binary required for report');
  assert.equal(git('status','--porcelain'),'', 'clean exact head required for report');
  assert.ok(!fs.existsSync(reportPath),'never overwrite evidence');
}
const nativeHex=['660fc7f0','0fc7f0','480fc7f0','66410fc7f0','410fc7f0','490fc7f0',
  '660fc7f8','0fc7f8','480fc7f8','66410fc7f8','410fc7f8','490fc7f8'];
let nativeIdentity,nativeRows,nativeOutput;
if(nativePath) {
  nativeOutput=execFileSync(nativePath,[],{encoding:'utf8',timeout:30_000,maxBuffer:2*1024*1024});
  [nativeIdentity,...nativeRows]=nativeOutput.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(nativeIdentity.schema,'x86-random-native/v1');
  assert.equal((nativeIdentity.leaf1Ecx>>>30)&1,1);
  assert.equal((nativeIdentity.leaf7Ebx>>>18)&1,1);
  assert.equal(nativeRows.length,12*128,'complete native observation matrix required');
  const ids=new Set();
  for(const row of nativeRows) {
    assert.ok(Number.isInteger(row.encoding) && row.encoding>=0 && row.encoding<12);
    assert.ok(Number.isInteger(row.iteration) && row.iteration>=0 && row.iteration<128);
    const key=`${row.encoding}:${row.iteration}`;
    assert.ok(!ids.has(key),'duplicate native case'); ids.add(key);
    for(const name of ['initial','before','rax','r8','after']) assert.match(row[name],/^0x[0-9a-f]{16}$/);
    assert.equal(BigInt(row.initial),row.iteration&1 ? 0xfedcba9876543210n : 0x0123456789abcdefn);
    const positions=[0n,2n,4n,6n,7n,11n];
    const wanted=positions.reduce((v,p,i)=>v|(BigInt((row.iteration>>i)&1)<<p),BigInt(row.iteration&1)<<10n);
    assert.equal(BigInt(row.before)&0xcd5n,wanted,'actual native input flags must match fixture');
  }
}
const proofs=[];
function instruction(row, patch={}) {
  return { instructionId:`random:${row.family}:${row.bytes.join('-')}`,instructionCode:1,
    instructionFamily:row.family,mnemonic:row.family,mode:'long-64',address:0x1000n,
    length:row.bytes.length,rawBytes:Uint8Array.from(row.bytes),detailStatus:'complete',
    detail:{operandCount:1,operands:[{type:'register',register:row.register,widthBits:row.bits,access:'write'}]},...patch };
}
let cases=0;
assert.equal(RANDOM_CASES.length,544);
for (const row of RANDOM_CASES) {
  const bundle=liftX86MachineEffects(instruction(row));
  validateMachineEffectBundle(bundle);
  cases+=verifyRandomValues(bundle,row);
}
for (const [,family,hex] of X86_LONG64_DECODER_WITNESSES.filter(([,name])=>['rdrand','rdseed'].includes(name))) {
  assert.ok(RANDOM_CASES.some(row=>row.family===family && Buffer.from(row.bytes).toString('hex')===hex));
}
for (const family of ['rdrand','rdseed']) {
  const base=RANDOM_CASES.find(row=>row.family===family && row.register==='eax' && row.bytes.length===3);
  for (const bytes of [[0x90],base.bytes.slice(0,-1),[...base.bytes,0x90],
    ...[0xf0,0xf2,0xf3,0x26,0x2e,0x36,0x3e,0x64,0x65,0x67].map(prefix=>[prefix,...base.bytes]),
    [0x66,0x66,...base.bytes],[0x40,0x48,...base.bytes],[0x40,0x66,...base.bytes],
    [0x0f,0xc7,base.bytes[2]&0x3f],[0x0f,0xc7,base.bytes[2]^8]]) {
    const bundle=liftX86MachineEffects(instruction({...base,bytes}));
    assert.equal(bundle.completeness,'partial',`${family}:${bytes}`);
    assert.equal(bundle.operations.length,0);
  }
  for (const register of ['ecx']) {
    const bundle=liftX86MachineEffects(instruction({...base,register}));
    assert.equal(bundle.completeness,'partial');
    assert.equal(bundle.operations.length,0);
  }
  for (const register of ['ax','rax','xmm0']) {
    assert.throws(()=>liftX86MachineEffects(instruction({...base,register})),/register-width-mismatch/);
  }
  const missing=liftX86MachineEffects(instruction(base,{detail:{operandCount:0,operands:[]}}));
  assert.equal(missing.completeness,'partial');
  assert.equal(missing.operations.length,0);
  for(const access of ['read','read-write','unknown']) {
    const contradictory=instruction(base);
    contradictory.detail.operands[0].access=access;
    const bundle=liftX86MachineEffects(contradictory);
    assert.equal(bundle.completeness,'partial');
    assert.equal(bundle.operations.length,0);
  }
}
// The oracle must catch incorrect CF/value coupling, missing zero extension,
// and a nonzero failed RDSEED, not merely recognize a completeness label.
for (const mutation of ['cf','width','failure']) {
  const row=RANDOM_CASES.find(r=>r.family==='rdseed' && r.register==='eax' && r.bytes.length===3);
  const bad=structuredClone(liftX86MachineEffects(instruction(row)));
  if(mutation==='cf') bad.operations.find(op=>op.kind==='flag-write' && op.flag.flagId==='RFLAGS.CF').value={kind:'bitvector',widthBits:1,value:'0'};
  if(mutation==='width') bad.operations.find(op=>op.kind==='value' && op.opcode==='zext').outputs[0].valueType.widthBits=16;
  if(mutation==='failure') bad.operations.find(op=>op.kind==='value' && op.opcode==='select').inputs[2].value='1';
  assert.throws(()=>verifyRandomValues(bad,row),assert.AssertionError);
}
await forEachX86BrowserSession(async ({decodeAndLift,engine,browserVersion})=>{
  const bundles=new Map();
  for (const row of RANDOM_CASES) {
    const [{decoded,effects}]=await decodeAndLift(row.bytes);
    assert.equal(decoded.instructionFamily,row.family);
    cases+=verifyRandomValues(effects,row);
    bundles.set(Buffer.from(row.bytes).toString('hex'),{row,bundle:effects});
  }
  if(nativeRows) {
    const outcomes={rdrand:{success:0,failure:0},rdseed:{success:0,failure:0}};
    for(const observation of nativeRows) {
      const {row,bundle}=bundles.get(nativeHex[observation.encoding]);
      const initial=BigInt(observation.initial),before=BigInt(observation.before),after=BigInt(observation.after);
      const ready=after&1n,value=BigInt(observation[row.physical]),mask=(1n<<BigInt(row.bits))-1n;
      assert.equal(BigInt(observation[row.physical==='rax' ? 'r8' : 'rax']),initial,'other native GPR preserved');
      if(!ready && (row.family==='rdseed' || nativeIdentity.vendor==='GenuineIntel')) assert.equal(value&mask,0n);
      // Condition on hardware's nondeterministic returned value/CF. RDSEED's
      // unavailable sample is deliberately nonzero to test the emitted select.
      const sample=row.family==='rdseed' && !ready ? mask : value&mask;
      assert.deepEqual(evaluateRandomTransfer(bundle,row.physical,initial,before,sample,ready),{register:value,flags:after});
      outcomes[row.family][ready ? 'success' : 'failure']++;
    }
    proofs.push({engine,browserVersion,cases:nativeRows.length,encodings:nativeHex.length,outcomes});
  }
});
if(reportPath) {
  assert.equal(git('rev-parse','HEAD'),productHead);
  assert.equal(git('status','--porcelain'),'');
  assert.deepEqual(proofs.map(p=>p.engine),['chromium','webkit']);
  const report={schema:'x86-random-browser-native-proof/v1',status:'PASS_NORMAL_PROJECTION_ONLY',productHead,
    verifierSha256:sha(fs.readFileSync(new URL(import.meta.url))),
    evaluatorSha256:sha(fs.readFileSync(new URL('./helpers/random-oracle.mjs',import.meta.url))),
    fixtureSha256:sha(fs.readFileSync(new URL('../../tools/validation/machine-effects/fixtures/random-oracle.c',import.meta.url))),
    binarySha256:sha(fs.readFileSync(nativePath)),observationSha256:sha(nativeOutput),nativeIdentity,proofs,
    unproven:['entropy quality or distribution','native outcomes with zero observed count','feature-disabled faults',
      'other CPU implementations','native encodings outside the 12 listed cases','physical iPad','complete MachineEffects denominator']};
  const temporary=`${reportPath}.${randomUUID()}.tmp`;
  const fd=fs.openSync(temporary,'wx');
  try{fs.writeFileSync(fd,JSON.stringify(report,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{fs.linkSync(temporary,reportPath);}finally{fs.unlinkSync(temporary);}
  const directory=fs.openSync(path.dirname(path.resolve(reportPath)),'r');
  try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
}
console.log(`RDRAND/RDSEED: PASS (${RANDOM_CASES.length} encodings, ${cases} projection cases; native comparisons ${proofs.reduce((n,p)=>n+p.cases,0)}; no entropy or native-fault proof)`);
