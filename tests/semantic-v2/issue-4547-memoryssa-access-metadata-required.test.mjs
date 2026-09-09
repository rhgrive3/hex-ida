import assert from 'node:assert/strict';
import { fixture } from '../phase7/helpers/fixtures.mjs';
import { validateMemorySsa } from '../../js/semantics/memoryssa/validate.js';

const source = fixture('issue-4547-fixture');
source.block('entry', []);
const address = source.entryValue('address');
const value = source.constant('value', 1);
source.store('store', address, value);
source.load('load', address);
const built = source.build();

assert.equal(typeof built.memorySsa.buildVersion, 'string');
assert.ok(built.memorySsa.accessMetadata.length > 0);
assert.doesNotThrow(
  () => validateMemorySsa(built.memorySsa, { cfg: built.cfg }),
  'canonical built MemorySSA with access metadata remains valid',
);

const omitted = structuredClone(built.memorySsa);
delete omitted.accessMetadata;
assert.throws(
  () => validateMemorySsa(omitted, { cfg: built.cfg }),
  /memory-ssa-validate-access-metadata-required/,
  'omitting the built accessMetadata envelope must fail closed',
);

const empty = { ...built.memorySsa, accessMetadata: [] };
assert.throws(
  () => validateMemorySsa(empty, { cfg: built.cfg }),
  /memory-ssa-validate-use-access-metadata-missing/,
  'an empty built accessMetadata array must retain coverage validation',
);

const nonBuilt = structuredClone(built.memorySsa);
delete nonBuilt.buildVersion;
delete nonBuilt.accessMetadata;
assert.doesNotThrow(
  () => validateMemorySsa(nonBuilt, { cfg: built.cfg }),
  'external/non-built contracts retain optional metadata compatibility',
);

console.log('issue-4547 MemorySSA access metadata required regression: ok');
