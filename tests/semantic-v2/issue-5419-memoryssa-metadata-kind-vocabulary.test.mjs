import assert from 'node:assert/strict';
import { fixture } from '../phase7/helpers/fixtures.mjs';
import { validateMemorySsa } from '../../js/semantics/memoryssa/validate.js';

// #5419: accessMetadata.entityKind is a closed use|definition vocabulary. The
// canonical downstream forwarding path rejects anything else, so the validator
// must fail closed on unknown (or missing) kinds instead of admitting them.

const source = fixture('issue-4547-fixture');
source.block('entry', []);
const address = source.entryValue('address');
const value = source.constant('value', 1);
source.store('store', address, value);
source.load('load', address);
const built = source.build();

assert.doesNotThrow(
  () => validateMemorySsa(built.memorySsa, { cfg: built.cfg }),
  'canonical built MemorySSA remains valid',
);

const sample = built.memorySsa.accessMetadata[0];
const oppositeEntityId = sample.entityKind === 'use'
  ? built.memorySsa.definitions[0].id
  : built.memorySsa.uses[0].id;

// Unknown kind on a known entity/region pair, no duplicate (id, regionId).
const forged = structuredClone(built.memorySsa);
forged.accessMetadata.push({ ...sample, memorySsaEntityId: oppositeEntityId, entityKind: 'bogus' });
assert.throws(
  () => validateMemorySsa(forged, { cfg: built.cfg }),
  (error) => error instanceof TypeError && error.message === 'memory-ssa-validate-access-metadata-kind-mismatch',
);

// Missing kind is outside the closed vocabulary as well.
const missing = structuredClone(built.memorySsa);
const withoutKind = { ...sample, memorySsaEntityId: oppositeEntityId };
delete withoutKind.entityKind;
missing.accessMetadata.push(withoutKind);
assert.throws(
  () => validateMemorySsa(missing, { cfg: built.cfg }),
  (error) => error instanceof TypeError && error.message === 'memory-ssa-validate-access-metadata-kind-mismatch',
);

// The same strict vocabulary applies to non-built artifacts that carry
// accessMetadata.
const nonBuilt = structuredClone(built.memorySsa);
delete nonBuilt.buildVersion;
nonBuilt.accessMetadata.push({ ...sample, memorySsaEntityId: oppositeEntityId, entityKind: 'bogus' });
assert.throws(
  () => validateMemorySsa(nonBuilt, { cfg: built.cfg }),
  (error) => error instanceof TypeError && error.message === 'memory-ssa-validate-access-metadata-kind-mismatch',
);

console.log('issue-5419 access metadata entityKind closed vocabulary: ok');
