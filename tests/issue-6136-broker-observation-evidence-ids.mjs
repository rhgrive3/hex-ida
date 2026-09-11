import assert from 'node:assert/strict';
import test from 'node:test';

import { ContextBroker } from '../js/ai/context/broker.js';

function brokerWith(observations) {
  const broker = new ContextBroker({}, { maxBytes: 128 * 1024 });
  return broker.buildModelContext({
    request: { mode: 'agent', style: 'analyst', scope: 'function' },
    session: { messages: [], investigationMemory: {} },
    observations,
    effectiveScope: 'function',
  });
}

test('#6136 non-array evidenceIds must not crash model context generation', () => {
  for (const malformed of [{ forged: true }, true, 42, 'evidence-1', null]) {
    let context = null;
    assert.doesNotThrow(
      () => {
        context = brokerWith([{ tool: 'get_function', summary: 'result', evidenceIds: malformed, data: { ok: true } }]);
      },
      `evidenceIds ${JSON.stringify(malformed)} must not throw`,
    );
    const observation = context.context.recentObservations?.[0];
    assert.ok(observation);
    assert.equal(
      observation.evidenceIds === undefined || Array.isArray(observation.evidenceIds),
      true,
      'projected observation must carry an array or no evidenceIds',
    );
    if (Array.isArray(observation.evidenceIds)) assert.equal(observation.evidenceIds.length, 0);
  }
});

test('#6136 array evidenceIds keep their capped projection', () => {
  const context = brokerWith([{
    tool: 'get_function',
    summary: 'result',
    evidenceIds: ['evidence-1', 'evidence-2'],
    data: { ok: true },
  }]);
  assert.deepEqual(context.context.recentObservations[0].evidenceIds, ['evidence-1', 'evidence-2']);
});

test('#6136 oversize observation shrink path tolerates non-array evidenceIds', () => {
  const context = brokerWith([{
    tool: 'get_function',
    summary: 'x'.repeat(300000),
    evidenceIds: { forged: true },
    data: { ok: true },
  }]);
  const observation = context.context.recentObservations?.[0];
  assert.ok(observation);
  assert.equal(
    observation.evidenceIds === undefined || Array.isArray(observation.evidenceIds),
    true,
  );
});
