import assert from 'node:assert/strict';
import { analyzeDecodedSemanticFunction } from '../../js/analysis/semantic-function-base.js';

for (const architecture of [['arm64'],{toString(){return 'arm64';}},true,1]) {
  assert.throws(()=>analyzeDecodedSemanticFunction({architecture,instructions:[]}),/semantic-function-architecture-required/);
}
for (const [field,value,code] of [
  ['instructionEndianness',['little'],'semantic-function-invalid-instruction-endianness'],
  ['dataEndianness',{toString(){return 'little';}},'semantic-function-invalid-memory-endianness'],
]) {
  assert.throws(()=>analyzeDecodedSemanticFunction({architecture:'arm64',instructions:[],[field]:value}),new RegExp(code));
}
console.log('issues-2812-2864-semantic-protocol: PASS');
