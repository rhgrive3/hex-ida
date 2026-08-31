import assert from 'node:assert/strict';
import { recoverSchemas } from '../js/schema.js';

const strings=[{addr:1n,text:'a.csv'},{addr:2n,text:'b.json'}];
Object.defineProperty(strings,'complete',{value:true,configurable:true});
const program={complete:true,unsupported:false,functionsReferencing(addr){return [{addr:addr===1n?0x1000n:0x2000n}]},functionRange(addr){return {start:addr,end:addr+32n}}};
const partial=await recoverSchemas({strings,program,architecture:'arm64',limit:1,read:async()=>null});
assert.equal(partial.complete,false);
assert.match(partial.incompleteReason,/schema-recovery-limit/);
const zero=await recoverSchemas({strings,program,architecture:'arm64',limit:0,read:async()=>null});
assert.equal(zero.complete,false);
assert.match(zero.incompleteReason,/schema-recovery-limit/);
const full=await recoverSchemas({strings,program,architecture:'arm64',limit:300,read:async()=>null});
assert.equal(full.complete,true);
console.log('issue-2810-schema-limit-completeness: PASS');
