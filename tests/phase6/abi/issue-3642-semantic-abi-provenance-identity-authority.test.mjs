import assert from 'node:assert/strict';
import { semanticAbiAdapter } from '../../../js/analysis/semantic-function-base.js';
import { resolveABIPlugin } from '../../../js/targets/abi/index.js';

const plugin = resolveABIPlugin({ architecture:'arm64', platform:'ios' });
assert.equal(plugin.supported, true, 'test requires the registered Darwin ARM64 ABI');

const canonicalOptions = {
  architectureId:'arm64',
  platformId:'ios',
  snapshotId:'snapshot-A',
  analyzerId:'analyzer-A',
  analyzerVersion:'1',
  binaryId:'binary-A',
  sliceId:'slice-A',
  functionId:'function-A',
};
const identityFields = [
  'snapshotId', 'analyzerId', 'analyzerVersion', 'binaryId', 'sliceId', 'functionId',
];
const mirrorSurfaces = ['identity', 'provenance', 'invalidation'];

const canonical = semanticAbiAdapter(plugin, canonicalOptions);
assert.equal(canonical.supported, true, 'canonical primitive identity strings must remain supported');
assert.equal(canonical.completeness, 'canonical');
for (const field of identityFields) {
  assert.equal(canonical[field], canonicalOptions[field]);
  for (const surface of mirrorSurfaces) {
    assert.equal(
      canonical[surface][field],
      canonicalOptions[field],
      `${surface}.${field} must preserve the canonical primitive string`,
    );
  }
}

{
  const absent = semanticAbiAdapter(plugin, { architectureId:'arm64', platformId:'ios' });
  assert.equal(absent.supported, true, 'omitted optional identity fields must remain valid');
  for (const field of identityFields) {
    assert.equal(absent[field], null);
    for (const surface of mirrorSurfaces) assert.equal(absent[surface][field], null);
  }
}

for (const field of identityFields) {
  const malformed = semanticAbiAdapter(plugin, {
    ...canonicalOptions,
    [field]:[canonicalOptions[field]],
  });
  assert.equal(malformed.supported, false, `${field} arrays must fail the adapter authority boundary`);
  assert.equal(malformed.completeness, 'unsupported');
  assert.equal(malformed[field], null, `${field} arrays must not stringify into the canonical identity`);
  for (const surface of mirrorSurfaces) {
    assert.equal(malformed[surface][field], null, `${surface}.${field} must share the strict identity contract`);
    assert.notEqual(malformed[surface][field], canonical[surface][field]);
  }
  assert.deepEqual(
    malformed.argumentLocations(),
    [],
    `${field} type violations must not publish canonical ABI argument locations`,
  );
}

for (const malformedValue of [
  { toString:() => 'binary-A' },
  new String('binary-A'),
  1,
  true,
  '',
]) {
  const malformed = semanticAbiAdapter(plugin, { ...canonicalOptions, binaryId:malformedValue });
  assert.equal(malformed.supported, false, 'structured/non-string/empty binary identity must fail closed');
  assert.equal(malformed.identity.binaryId, null);
  assert.equal(malformed.provenance.binaryId, null);
  assert.equal(malformed.invalidation.binaryId, null);
  assert.deepEqual(malformed.argumentLocations(), []);
}

{
  const alias = semanticAbiAdapter(plugin, {
    ...canonicalOptions,
    snapshotId:undefined,
    analysisSnapshotId:['snapshot-A'],
  });
  assert.equal(alias.supported, false, 'analysisSnapshotId alias must use the same strict identity contract');
  assert.equal(alias.identity.snapshotId, null);
}

{
  const alias = semanticAbiAdapter(plugin, {
    ...canonicalOptions,
    analyzerId:undefined,
    analysisAnalyzerId:['analyzer-A'],
    analyzerVersion:undefined,
    analysisAnalyzerVersion:['1'],
  });
  assert.equal(alias.supported, false, 'analysis analyzer aliases must use the same strict identity contract');
  assert.equal(alias.identity.analyzerId, null);
  assert.equal(alias.identity.analyzerVersion, null);
}

console.log('issue #3642 semantic ABI provenance identity authority regression: ok');
