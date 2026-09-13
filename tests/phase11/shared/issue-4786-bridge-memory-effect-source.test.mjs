import assert from 'node:assert/strict';
import test from 'node:test';
import { buildManagedMethodSummary } from '../../../js/managed/shared/bridge.js';
import { EFFECT_SOURCES } from '../../../js/analysis/summary/contract-core.js';

test('issue #4786: buildManagedMethodSummary in bridge.js uses canonical effect source for load and store', () => {
  const fn = {
    methodId: 'test_m4786',
    semanticIr: {
      nodes: [
        { id: 'n1', kind: 'load', memory: { addressSpace: 'memory' } },
        { id: 'n2', kind: 'store', memory: { addressSpace: 'memory' } },
      ],
      values: [],
    },
    cfg: { blocks: [] },
  };

  const summary = buildManagedMethodSummary(fn);
  assert.ok(summary, 'summary must be built without throwing');
  assert.equal(summary.summary.memoryReadRegions.length, 1);
  assert.equal(summary.summary.memoryWriteRegions.length, 1);
  assert.ok(EFFECT_SOURCES.includes(summary.summary.memoryReadRegions[0].source));
  assert.ok(EFFECT_SOURCES.includes(summary.summary.memoryWriteRegions[0].source));
  assert.equal(summary.summary.memoryReadRegions[0].source, 'proven-summary');
  assert.equal(summary.summary.memoryWriteRegions[0].source, 'proven-summary');
});
