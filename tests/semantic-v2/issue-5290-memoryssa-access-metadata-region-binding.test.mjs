import assert from 'node:assert/strict';
import { fixture } from '../phase7/helpers/fixtures.mjs';
import { createMemorySsaContract } from '../../js/semantics/memoryssa/contract.js';
import { validateMemorySsa } from '../../js/semantics/memoryssa/validate.js';

const origin = { instructionIds: ['issue-5290-fixture'] };
const base = createMemorySsaContract({
  functionId: 'function-5290',
  regions: [
    { id: 'region-A', kind: 'stack-fixed', functionId: 'function-5290', offset: 0, widthBits: 64 },
    { id: 'region-B', kind: 'stack-fixed', functionId: 'function-5290', offset: 8, widthBits: 64 },
  ],
  definitions: [
    { id: 'def-A', kind: 'memory-def', regionId: 'region-A', blockId: 'b0', sourceEntityId: 'node-store-A', origin },
  ],
  uses: [
    { id: 'use-A', regionId: 'region-A', reachingDefinitionId: 'def-A', blockId: 'b0', sourceEntityId: 'node-load-A', origin },
  ],
});

function metadata(items) {
  return { ...base, accessMetadata: items };
}

assert.doesNotThrow(
  () => validateMemorySsa(metadata([
    { memorySsaEntityId: 'use-A', entityKind: 'use', regionId: 'region-A' },
    { memorySsaEntityId: 'def-A', entityKind: 'definition', regionId: 'region-A' },
  ])),
  'access metadata bound to the referenced entity own region remains valid',
);

assert.throws(
  () => validateMemorySsa(metadata([
    { memorySsaEntityId: 'use-A', entityKind: 'use', regionId: 'region-B' },
    { memorySsaEntityId: 'def-A', entityKind: 'definition', regionId: 'region-A' },
  ])),
  (error) => error instanceof TypeError && error.message === 'memory-ssa-validate-access-metadata-region-mismatch',
  'a use metadata entry must not claim a foreign region',
);

assert.throws(
  () => validateMemorySsa(metadata([
    { memorySsaEntityId: 'use-A', entityKind: 'use', regionId: 'region-A' },
    { memorySsaEntityId: 'def-A', entityKind: 'definition', regionId: 'region-B' },
  ])),
  (error) => error instanceof TypeError && error.message === 'memory-ssa-validate-access-metadata-region-mismatch',
  'a definition metadata entry must not claim a foreign region',
);

assert.throws(
  () => validateMemorySsa(metadata([{ memorySsaEntityId: 'use-A', entityKind: 'use', regionId: 'region-Z' }])),
  (error) => error instanceof TypeError && error.message === 'memory-ssa-validate-access-metadata-region-mismatch',
  'an unknown region keeps failing closed',
);

assert.throws(
  () => validateMemorySsa(metadata([{ memorySsaEntityId: 'ghost', entityKind: 'use', regionId: 'region-A' }])),
  (error) => error instanceof TypeError && error.message === 'memory-ssa-validate-dangling-access-metadata',
  'a dangling entity keeps failing closed',
);

assert.throws(
  () => validateMemorySsa(metadata([
    { memorySsaEntityId: 'def-A', entityKind: 'use', regionId: 'region-A' },
  ])),
  (error) => error instanceof TypeError && error.message === 'memory-ssa-validate-access-metadata-kind-mismatch',
  'an entity-kind mismatch keeps failing closed',
);

assert.throws(
  () => validateMemorySsa(metadata([
    { memorySsaEntityId: 'use-A', entityKind: 'use', regionId: 'region-A' },
    { memorySsaEntityId: 'use-A', entityKind: 'use', regionId: 'region-A' },
  ])),
  (error) => error instanceof TypeError && error.message === 'memory-ssa-validate-duplicate-access-metadata',
  'a duplicate metadata entry keeps failing closed',
);

const source = fixture('issue-5290-built-fixture');
source.block('entry', []);
const addressA = source.entryValue('address-A');
const addressB = source.entryValue('address-B');
const value = source.constant('value', 1);
source.store('store-A', addressA, value);
source.store('store-B', addressB, value);
source.load('load-A', addressA);
const built = source.build();

assert.ok(built.memorySsa.regions.length > 1, 'built fixture must expose more than one region');
assert.doesNotThrow(
  () => validateMemorySsa(built.memorySsa, { cfg: built.cfg }),
  'canonical built MemorySSA remains valid',
);

const useId = built.memorySsa.uses[0].id;
const foreignRegion = built.memorySsa.regions
  .map((region) => region.id)
  .find((id) => id !== built.memorySsa.uses[0].regionId);
const useMetadataIndex = built.memorySsa.accessMetadata
  .findIndex((item) => item.entityKind === 'use' && item.memorySsaEntityId === useId);
assert.ok(useMetadataIndex >= 0, 'built artifact must carry use access metadata');

function rebuilt(metadataEntries) {
  return {
    ...structuredClone(built.memorySsa),
    accessMetadata: metadataEntries,
  };
}

const onlyForeignUseMetadata = built.memorySsa.accessMetadata.filter((item) => item.entityKind !== 'use');
onlyForeignUseMetadata.push({
  ...structuredClone(built.memorySsa.accessMetadata[useMetadataIndex]),
  regionId: foreignRegion,
});
assert.throws(
  () => validateMemorySsa(rebuilt(onlyForeignUseMetadata), { cfg: built.cfg }),
  (error) => error instanceof TypeError && error.message === 'memory-ssa-validate-access-metadata-region-mismatch',
  'a wrong-region use metadata entry must not satisfy built coverage',
);

const foreignUseMetadataAppended = structuredClone(built.memorySsa.accessMetadata);
foreignUseMetadataAppended[useMetadataIndex] = {
  ...foreignUseMetadataAppended[useMetadataIndex],
  regionId: foreignRegion,
};
assert.throws(
  () => validateMemorySsa(rebuilt(foreignUseMetadataAppended), { cfg: built.cfg }),
  (error) => error instanceof TypeError && error.message === 'memory-ssa-validate-access-metadata-region-mismatch',
  'a forged use region in a built artifact must fail closed',
);

const definitionId = built.memorySsa.definitions
  .find((definition) => definition.kind !== 'entry' && definition.kind !== 'memory-phi').id;
const definitionEntry = built.memorySsa.accessMetadata
  .find((item) => item.entityKind === 'definition' && item.memorySsaEntityId === definitionId);
const foreignDefinitionMetadata = structuredClone(built.memorySsa.accessMetadata);
foreignDefinitionMetadata.push({
  ...definitionEntry,
  regionId: built.memorySsa.regions
    .map((region) => region.id)
    .find((id) => id !== definitionEntry.regionId),
});
assert.throws(
  () => validateMemorySsa(rebuilt(foreignDefinitionMetadata), { cfg: built.cfg }),
  (error) => error instanceof TypeError && error.message === 'memory-ssa-validate-access-metadata-region-mismatch',
  'a forged definition region in a built artifact must fail closed',
);

const nonBuiltForged = structuredClone(built.memorySsa);
delete nonBuiltForged.buildVersion;
nonBuiltForged.accessMetadata = nonBuiltForged.accessMetadata.map((item) => (
  item.memorySsaEntityId === useId && item.entityKind === 'use'
    ? { ...item, regionId: foreignRegion }
    : item
));
assert.throws(
  () => validateMemorySsa(nonBuiltForged, { cfg: built.cfg }),
  (error) => error instanceof TypeError && error.message === 'memory-ssa-validate-access-metadata-region-mismatch',
  'the region binding check must not depend on built coverage validation',
);

console.log('issue-5290 MemorySSA access-metadata region binding regression: ok');
