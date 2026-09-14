import assert from 'node:assert/strict';

import {
  loadManifest,
  validateAggregateFiles,
  validateFiles,
} from '../../../tools/validation/phase12/ownership.mjs';

const manifest = loadManifest();
const exact = 'js/ai/session-core/index.js';
const adjacent = 'js/ai/session-core/worker.js';

const lane = validateFiles([exact], 'p12-integration', manifest);
assert.equal(lane.ok, true, 'the session store implementation must be owned by the Phase 12 integration lane');

const aggregate = validateAggregateFiles([exact], manifest);
assert.equal(aggregate.ok, true, 'aggregate ownership must admit the exact session store implementation');

const laneNeighbor = validateFiles([adjacent], 'p12-integration', manifest);
assert.equal(laneNeighbor.ok, false, 'lane ownership must not broaden to adjacent session-core paths');
assert.deepEqual(
  laneNeighbor.violations.map(({ file, category }) => ({ file, category })),
  [{ file: adjacent, category: 'unowned' }],
);

const aggregateNeighbor = validateAggregateFiles([adjacent], manifest);
assert.equal(aggregateNeighbor.ok, false, 'aggregate ownership must reject adjacent session-core paths');
assert.deepEqual(
  aggregateNeighbor.violations.map(({ file, category }) => ({ file, category })),
  [{ file: adjacent, category: 'unowned' }],
);

console.log('phase12 AI session-core ownership regression: PASS');
