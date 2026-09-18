import assert from 'node:assert/strict';
import { createMemorySsaContract } from '../../js/semantics/memoryssa/contract.js';
import { validateMemorySsa } from '../../js/semantics/memoryssa/validate.js';

const origin = { instructionIds: ['issue-4544-fixture'] };
const base = createMemorySsaContract({
  functionId: 'function-4544',
  regions: [
    { id: 'region-A', kind: 'stack-fixed', functionId: 'function-4544', offset: 0, widthBits: 64 },
    { id: 'region-B', kind: 'stack-fixed', functionId: 'function-4544', offset: 8, widthBits: 64 },
  ],
  definitions: [
    { id: 'entry-A', kind: 'entry', regionId: 'region-A', blockId: 'b0', origin },
    { id: 'entry-B', kind: 'entry', regionId: 'region-B', blockId: 'b0', origin },
  ],
  uses: [],
});

function state() {
  return {
    blockId: 'b0',
    entry: [
      { regionId: 'region-A', definitionId: 'entry-A' },
      { regionId: 'region-B', definitionId: 'entry-B' },
    ],
    exit: [
      { regionId: 'region-A', definitionId: 'entry-A' },
      { regionId: 'region-B', definitionId: 'entry-B' },
    ],
  };
}

assert.doesNotThrow(
  () => validateMemorySsa({ ...base, blockStates: [state()] }),
  'a block state whose definitions belong to their declared regions remains valid',
);

for (const side of ['entry', 'exit']) {
  const invalid = state();
  invalid[side] = [
    { regionId: 'region-A', definitionId: 'entry-B' },
    { regionId: 'region-B', definitionId: 'entry-A' },
  ];
  assert.throws(
    () => validateMemorySsa({ ...base, blockStates: [invalid] }),
    /memory-ssa-validate-block-state-region-mismatch/,
    `${side} block-state definitions must remain bound to their region`,
  );
}

const oneSided = state();
oneSided.entry[0] = { regionId: 'region-A', definitionId: 'entry-B' };
assert.throws(
  () => validateMemorySsa({ ...base, blockStates: [oneSided] }),
  /memory-ssa-validate-block-state-region-mismatch/,
  'one cross-region entry item is sufficient to reject the artifact',
);

console.log('issue-4544 MemorySSA block-state region binding regression: ok');
