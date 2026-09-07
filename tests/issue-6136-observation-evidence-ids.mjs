// Regression for #6136: compactObservations()/fitObservation() treated
// observation evidenceIds as an array whenever it was truthy and called
// `.slice()` on it, so a tool/provider observation carrying
// `evidenceIds:{}` or `true` crashed model-context construction with a raw
// TypeError. Malformed id lists are dropped instead of trusted.
import assert from 'node:assert/strict';
import { ContextBroker } from '../js/ai/context/broker.js';

const broker = new ContextBroker({}, { maxBytes: 128 * 1024 });

const baseRequest = { mode: 'agent', style: 'analyst', scope: 'function' };
const baseSession = { messages: [], investigationMemory: {} };

function buildWith(observations) {
  return broker.buildModelContext({
    request: baseRequest,
    session: baseSession,
    observations,
  });
}

{
  // The issue's example: an object instead of an id array.
  const built = buildWith([{ tool: 'get_function', summary: 'result', evidenceIds: { forged: true } }]);
  assert.ok(built, 'an object evidenceIds must not break context construction');
  assert.deepEqual(built.context?.recentObservations?.[0]?.evidenceIds ?? [], [],
    'a malformed evidence list must be dropped');
}

{
  // Other truthy non-arrays stay safe too.
  const built = buildWith([
    { tool: 't1', summary: 's1', evidenceIds: true },
    { tool: 't2', summary: 's2', evidenceIds: 'ev-1' },
    { tool: 't3', summary: 's3', evidenceIds: 7 },
  ]);
  assert.ok(built, 'non-array evidenceIds must not break context construction');
  for (const observation of built.context?.recentObservations ?? []) {
    assert.ok(Array.isArray(observation.evidenceIds), 'published observations carry array evidenceIds');
  }
}

{
  // Well-formed arrays keep flowing through, including the oversize path.
  const oversized = { tool: 'big', summary: 'x'.repeat(6000), evidenceIds: ['ev-1', 'ev-2', 3, null, ''] };
  const built = buildWith([oversized]);
  const observation = built.context?.recentObservations?.find((item) => item.tool === 'big');
  assert.ok(observation, 'the observation survives normalization');
  assert.deepEqual(observation.evidenceIds, ['ev-1', 'ev-2'], 'string ids are kept, non-strings dropped');
}
