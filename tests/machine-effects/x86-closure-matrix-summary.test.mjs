import assert from 'node:assert/strict';
import { evaluateX86Long64ClosureMatrix,validateX86Long64ClosureMatrix } from '../../tools/validation/machine-effects/x86-long64-closure-matrix.mjs';

// Verifier self-tests only. These deliberately synthetic summaries are not
// instruction semantics or evidence of actual decoder/receiver authority.
const witness={id:625,name:'rdrand',hex:'0fc7f0',instruction:{rawBytes:Uint8Array.of(15,199,240)}};
const evaluate=bundle=>evaluateX86Long64ClosureMatrix([witness],()=>bundle);
const base={completeness:'exact-with-intrinsic',metadata:{family:'system'},controlEffect:{kind:'fallthrough'},possibleFaults:[]};
evaluateX86Long64ClosureMatrix([witness],(...args)=>{
  assert.equal(args.length,1,'the verifier must not override production terminalization');
  assert.equal(args[0],witness.instruction);
  return base;
});
for(const family of ['flags','bit-manipulation','foundation']) {
  const result=evaluate({ownerId:'integer',result:{...base,metadata:{family}}});
  assert.equal(result.rows[0].ownerId,'integer','dispatcher ownership is not the diagnostic family label');
  assert.equal(result.rows[0].completeness,'exact-with-intrinsic');
}
const intrinsic={kind:'intrinsic',effectSummary:{
  registersRead:['sys:x86.random-generator-state','rax'],
  registersWritten:['rflags.cf','rax'],memoryRead:{scope:'none'},memoryWrite:{scope:'none'},
}};
const matrix=evaluate({...base,operations:[intrinsic,
  {kind:'register-read',register:{registerId:'rax'}},
  {kind:'register-write',register:{registerId:'rax'}},
  {kind:'flag-write',flag:{flagId:'RFLAGS.CF'}},
  {kind:'flag-read',flag:{flagId:'RFLAGS.ZF'}},
]});
assert.deepEqual(matrix.rows[0].registersRead,['rax','rflags.zf','sys:x86.random-generator-state']);
assert.deepEqual(matrix.rows[0].registersWritten,['rax','rflags.cf']);
assert.equal(matrix.rows[0].memoryReads,0);
assert.equal(matrix.rows[0].memoryWrites,0);
assert.throws(()=>validateX86Long64ClosureMatrix(matrix),/total-witness-count-drift/);

const memory=evaluate({...base,operations:[{...intrinsic,effectSummary:{...intrinsic.effectSummary,
  memoryRead:{scope:'accesses',accesses:[{space:'memory'},{space:'tls'}]},
  memoryWrite:{scope:'all',spaces:['memory']},
}},{kind:'memory-read'},{kind:'memory-write'}]});
assert.equal(memory.rows[0].memoryReads,3);
assert.equal(memory.rows[0].memoryWrites,2);
const unknown=evaluate({...base,operations:[{...intrinsic,effectSummary:{...intrinsic.effectSummary,
  memoryRead:{scope:'unknown'},memoryWrite:{scope:'unknown'},
}}]});
assert.equal(unknown.rows[0].memoryReads,1);
assert.equal(unknown.rows[0].memoryWrites,1);

for(const completeness of [undefined,null,'',true,'terminal','unknown']) {
  const result=evaluate({...base,completeness,operations:[]});
  assert.equal(result.exactTotal,0,'a known owner cannot substitute for completeness evidence');
  assert.equal(result.partialCount,1);
  assert.equal(result.blockingGapCount,1);
  assert.equal(result.closed,false);
  assert.equal(result.rows[0].partialReason,'invalid-or-missing-completeness');
}
for(const bundle of [null,{ownerId:'system',result:null},{...base,metadata:{family:'future'}}]) {
  const result=evaluate(bundle);
  assert.equal(result.unownedCount,1);
  assert.equal(result.closed,false);
}
console.log('x86 closure matrix summary and missing-evidence negatives: PASS');
