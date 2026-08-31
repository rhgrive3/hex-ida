import assert from 'node:assert/strict';
import { createLanguageMetadataIdentity } from '../../js/metadata/provider.js';

const source = {
  entityIds: ['type:one'],
  nested: { values: ['keep-owned'] },
};

const identity = createLanguageMetadataIdentity({
  verdict: 'matched-partial',
  providerId: 'test-provider',
  providerVersion: '1.0.0',
  ecosystem: 'test',
  binaryIdentity: 'build-1',
  coverage: source,
});

assert.notStrictEqual(identity.coverage, source);
assert.notStrictEqual(identity.coverage.entityIds, source.entityIds);
assert.notStrictEqual(identity.coverage.nested, source.nested);
assert.notStrictEqual(identity.coverage.nested.values, source.nested.values);
assert.deepEqual(identity.coverage, source);

assert.equal(Object.isFrozen(identity.coverage), true);
assert.equal(Object.isFrozen(identity.coverage.entityIds), true);
assert.equal(Object.isFrozen(identity.coverage.nested), true);
assert.equal(Object.isFrozen(identity.coverage.nested.values), true);

assert.equal(Object.isFrozen(source), false);
assert.equal(Object.isFrozen(source.entityIds), false);
assert.equal(Object.isFrozen(source.nested), false);
assert.equal(Object.isFrozen(source.nested.values), false);

source.entityIds.push('type:two');
source.nested.values.push('still-mutable');
assert.deepEqual(identity.coverage.entityIds, ['type:one']);
assert.deepEqual(identity.coverage.nested.values, ['keep-owned']);

console.log('phase7 metadata coverage ownership regression (#3146): PASS');
