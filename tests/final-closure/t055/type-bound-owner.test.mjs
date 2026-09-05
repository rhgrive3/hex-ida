import assert from 'node:assert/strict';
import test from 'node:test';

import { TypeConstraintGraph } from '../../../js/analysis/types/graph.js';

const LIMIT_KEYS = [
  'maxConstraintsPerLayer',
  'maxComparisonsPerLayer',
  'maxContradictionsPerLayer',
  'maxIterationsPerComponent',
  'maxComponents',
  'maxNodes',
  'maxEdges',
];

test('T055 owner gate keeps every graph limit primitive and safe-positive', () => {
  const accepted = 7;
  const rejected = [
    '7',
    new Number(accepted),
    7n,
    true,
    {},
    [],
    NaN,
    Infinity,
    -Infinity,
    1.5,
    0,
    -1,
    Number.MAX_SAFE_INTEGER + 1,
  ];

  for (const key of LIMIT_KEYS) {
    const graph = new TypeConstraintGraph({ snapshotId: `t055-owner:${key}`, limits: { [key]: accepted } });
    assert.equal(graph.limits[key], accepted, `${key} must preserve the primitive safe integer`);
    for (const value of rejected) {
      assert.throws(
        () => new TypeConstraintGraph({ snapshotId: `t055-owner:${key}`, limits: { [key]: value } }),
        TypeError,
        `${key} must reject non-coercive limit ${String(value)}`,
      );
    }
  }
});
