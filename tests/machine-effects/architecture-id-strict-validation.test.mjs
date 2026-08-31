import assert from 'node:assert/strict';

import {
  canonicalArchitectureId,
  architecturePluginV2,
} from '../../js/targets/architecture/index.js';

assert.equal(canonicalArchitectureId(' ARM64 '), 'arm64');
assert.equal(canonicalArchitectureId('aArCh64'), 'aarch64');

for (const malformed of [
  ['arm64'],
  { toString() { return 'arm64'; } },
  true,
  64,
  0,
]) {
  assert.notEqual(canonicalArchitectureId(malformed), 'arm64');
  assert.notEqual(architecturePluginV2(malformed)?.id, 'arm64');
}

assert.equal(architecturePluginV2(' ARM64 ')?.id, 'arm64');
console.log('architecture id strict validation regression PASS');
