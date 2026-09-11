import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPointsToSet,
  createPointsToTarget,
  exactRange,
  pointsToDigest,
} from '../../../js/analysis/pointsto/lattice.js';

function base(overrides = {}) {
  return {
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootEntityId: 'root-1',
    offsetRange: exactRange(0n),
    widthBits: 64,
    evidenceIds: ['ev1'],
    ...overrides,
  };
}

function assertMetadataRejects(input, code) {
  assert.throws(
    () => createPointsToTarget(base(input)),
    (error) => error instanceof TypeError && error.message === code,
  );
}

test('#5022 canonical primitive width/evidence metadata stays stable', () => {
  const target = createPointsToTarget(base({ evidenceIds: ['ev2', 'ev1', 'ev1'] }));
  assert.equal(target.widthBits, 64);
  assert.deepEqual(target.evidenceIds, ['ev1', 'ev2']);

  const replay = createPointsToTarget(target);
  assert.equal(pointsToDigest(createPointsToSet({ targets: [target] })),
    pointsToDigest(createPointsToSet({ targets: [replay] })));
});

test('#5022 structured/string/boolean widths cannot become canonical machine widths', () => {
  for (const widthBits of [['64'], '64', true, { valueOf: () => 64 }]) {
    assertMetadataRejects({ widthBits }, 'phase7-pointsto-target-invalid-width-bits');
  }
});

test('#5022 non-positive, fractional and non-finite widths fail closed', () => {
  for (const widthBits of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assertMetadataRejects({ widthBits }, 'phase7-pointsto-target-invalid-width-bits');
  }
});

test('#5022 evidence IDs must already be non-empty primitive strings', () => {
  for (const evidenceIds of [[['ev1']], [1], [{}], [true], ['']]) {
    assertMetadataRejects({ evidenceIds }, 'phase7-pointsto-target-invalid-evidence-ids');
  }
});

test('#5022 explicit evidence metadata must be an array', () => {
  for (const evidenceIds of ['ev1', { 0: 'ev1', length: 1 }, new Set(['ev1'])]) {
    assertMetadataRejects({ evidenceIds }, 'phase7-pointsto-target-invalid-evidence-ids');
  }
});

test('#5022 sparse/accessor evidence arrays fail without invoking caller coercion', () => {
  const sparse = new Array(1);
  assertMetadataRejects({ evidenceIds: sparse }, 'phase7-pointsto-target-invalid-evidence-ids');

  let getterRuns = 0;
  const accessor = [];
  Object.defineProperty(accessor, '0', {
    configurable: true,
    enumerable: true,
    get() { getterRuns += 1; return 'ev1'; },
  });
  accessor.length = 1;
  assertMetadataRejects({ evidenceIds: accessor }, 'phase7-pointsto-target-invalid-evidence-ids');
  assert.equal(getterRuns, 0);

  let coercionRuns = 0;
  assertMetadataRejects({
    evidenceIds: [{ toString() { coercionRuns += 1; return 'ev1'; } }],
  }, 'phase7-pointsto-target-invalid-evidence-ids');
  assert.equal(coercionRuns, 0);

  let iteratorRuns = 0;
  const customIterator = ['ev1'];
  customIterator[Symbol.iterator] = () => {
    iteratorRuns += 1;
    throw new Error('caller iterator must not run');
  };
  assert.deepEqual(createPointsToTarget(base({ evidenceIds: customIterator })).evidenceIds, ['ev1']);
  assert.equal(iteratorRuns, 0);
});

test('#5022 points-to set reconstruction cannot launder malformed spill/reload metadata', () => {
  const valid = createPointsToTarget(base());
  const malformed = {
    ...valid,
    widthBits: ['64'],
    evidenceIds: [['ev1']],
  };
  assert.throws(
    () => createPointsToSet({ targets: [malformed] }),
    (error) => error instanceof TypeError && error.message === 'phase7-pointsto-target-invalid-width-bits',
  );
});
