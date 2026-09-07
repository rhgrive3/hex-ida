import assert from 'node:assert/strict';
import { analyzeSemanticFunction } from '../../js/analysis/semantic-function.js';

for (const architecture of [['arm64'], { toString(){ return 'arm64'; } }, true, 1]) {
  assert.throws(() => analyzeSemanticFunction({ architecture }), /semantic-function-architecture-required/);
}
for (const [field, value, code] of [
  ['instructionEndianness', ['little'], 'semantic-function-invalid-instruction-endianness'],
  ['instructionEndianness', { toString(){ return 'little'; } }, 'semantic-function-invalid-instruction-endianness'],
  ['dataEndianness', ['little'], 'semantic-function-invalid-memory-endianness'],
  ['dataEndianness', true, 'semantic-function-invalid-memory-endianness'],
]) {
  assert.throws(() => analyzeSemanticFunction({ architecture:'arm64', [field]:value }), new RegExp(code));
}
assert.throws(() => analyzeSemanticFunction({ architecture:' ARM64 ' }), /semantic-function-supported-abi-required|semantic-function-decoded-instructions-required|semantic-function-decoder-semantic-version-required/);
console.log('issue-3134-semantic-function-selectors: PASS');
