import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeEscape } from '../../../js/analysis/summary/escape.js';
import { createPointsToSet, createPointsToTarget, exactRange } from '../../../js/analysis/pointsto/lattice.js';
import { fixture } from '../helpers/fixtures.mjs';

// #5324: A2 mints canonical points-to targets with `rootKind:'allocation'`
// (function-return provenance of kind `allocation`), but `classifyRootOrigin()`
// had no branch for that kind, so the canonical allocation root classified as
// `unknown` and could never earn a non-escape proof — unless the caller
// re-declared the same identity through the `allocationRootKeys` side channel.

const allocationTarget = createPointsToTarget({
  addressSpace: 'memory',
  rootKind: 'allocation',
  rootEntityId: 'alloc_site_1',
  offsetRange: exactRange(0n),
  address: null,
});

function buildWithObservation() {
  const f = fixture('function_alloc_observe');
  f.block('entry', []);
  const p = f.stateRead('p', 'state:x0');
  f.load('v', p, { widthBits: 32 });
  f.ret('r');
  return f.build();
}

function run(options = {}) {
  const built = buildWithObservation();
  const pointsToRun = {
    pointsTo: new Map([[pOf(built), createPointsToSet({ targets: [allocationTarget] })]]),
    status: { snapshotId: 's', analyzerId: 'phase7.pointsto.a2-local', analyzerVersion: '1.2.0', completeness: 'complete', stopReason: null },
  };
  return analyzeEscape(built.ir, built.cfg, built.ssa, pointsToRun, options);
}

const pOf = (built) => 'p';

test('#5324 a canonical allocation root classifies as local-allocation', () => {
  const result = run();
  assert.equal(result.rootOrigins.get(allocationTarget.rootKey), 'local-allocation');
});

test('#5324 an unescaped canonical allocation root earns its non-escape proof without a side channel', () => {
  const result = run();
  assert.equal(result.nonEscapingRoots.has(allocationTarget.rootKey), true);
});

test('#5324 the side channel stays consistent with the canonical kind', () => {
  const withKeys = run({ allocationRootKeys: new Set([allocationTarget.rootKey]) });
  assert.equal(withKeys.nonEscapingRoots.has(allocationTarget.rootKey), true);
});
