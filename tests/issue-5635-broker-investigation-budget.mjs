import assert from 'node:assert/strict';
import test from 'node:test';

import { ContextBroker } from '../js/ai/context/broker.js';

function brokerWithMemory(investigationMemory, budgetBytes = 64 * 1024) {
  const broker = new ContextBroker({}, { maxBytes: 128 * 1024 });
  return broker.buildModelContext({
    request: { mode: 'chat', style: 'analyst', scope: 'function' },
    session: {
      investigationMemory,
      pinnedEvidence: [],
      messages: [],
    },
    evidenceStore: { recentByStatus: () => [], pinned: () => [] },
    hypotheses: [],
    observations: [],
    budgetBytes,
  });
}

function heavyMemory(facts = 40, summaryLength = 2000) {
  return {
    goal: 'continue',
    anchor: null,
    confirmedFacts: Array.from({ length: facts }, (_, i) => ({
      id: `ev_${i}`,
      summary: 'x'.repeat(summaryLength),
      functionAddress: '0x1000',
    })),
    activeHypotheses: [],
    rejectedHypotheses: [],
    unresolvedQuestions: [],
    userConstraints: [],
    importantPriorActions: [],
  };
}

test('#5635 oversized confirmedFacts must degrade instead of failing the turn', () => {
  // 40 facts x 2000 chars ~= 80 KiB of investigation memory alone, over the
  // 64 KiB budget. Previously this ended in AIError('context_too_large').
  let outcome = null;
  assert.doesNotThrow(() => {
    outcome = brokerWithMemory(heavyMemory(40));
  }, 'ordinary investigation accumulation must stay within the semantic budget');
  assert.ok(outcome.bytes <= 64 * 1024);
  const investigation = outcome.context.investigation;
  assert.ok(investigation.confirmedFacts.length < 40, 'confirmedFacts must be trimmed down');
  // Newest facts are kept longest.
  assert.ok(investigation.confirmedFacts.some((fact) => fact.id === `ev_${40 - 1}`));
  assert.ok(!investigation.confirmedFacts.some((fact) => fact.id === 'ev_0'));
});

test('#5635 activeHypotheses bulk degrades after confirmedFacts', () => {
  const memory = heavyMemory(0);
  memory.activeHypotheses = Array.from({ length: 48 }, (_, i) => ({
    id: `hyp_${i}`,
    claim: 'y'.repeat(2000),
    status: 'open',
  }));
  const outcome = brokerWithMemory(memory);
  assert.ok(outcome.bytes <= 64 * 1024);
  const hypotheses = outcome.context.investigation.activeHypotheses;
  assert.ok(hypotheses.length < 48, 'activeHypotheses must be trimmed down');
  assert.ok(hypotheses.some((hyp) => hyp.id === `hyp_${48 - 1}`));
});

test('#5635 userConstraints survive while facts/hypotheses can absorb the cut', () => {
  const memory = heavyMemory(40);
  memory.userConstraints = [
    { id: 'uc_1', text: 'never patch the guard page' },
    { id: 'uc_2', text: 'prefer call-site analysis' },
  ];
  const outcome = brokerWithMemory(memory);
  assert.ok(outcome.bytes <= 64 * 1024);
  assert.equal(outcome.context.investigation.userConstraints.length, 2, 'safety constraints are kept last');
  assert.equal(outcome.context.investigation.goal, 'continue');
});

test('#5635 extreme budget still yields a bounded context or the explicit error', () => {
  const memory = heavyMemory(40);
  memory.activeHypotheses = Array.from({ length: 48 }, (_, i) => ({ id: `hyp_${i}`, claim: 'y'.repeat(2000) }));
  memory.userConstraints = Array.from({ length: 32 }, (_, i) => ({ id: `uc_${i}`, text: 'z'.repeat(2000) }));
  memory.goal = 'g'.repeat(5000);
  try {
    const outcome = brokerWithMemory(memory, 4096);
    assert.ok(outcome.bytes <= 4096, 'degraded context must respect the floor budget');
    assert.equal(outcome.context.investigation.confirmedFacts.length, 0);
    assert.equal(outcome.context.investigation.userConstraints.length, 0);
  } catch (error) {
    assert.equal(error.type, 'context_too_large');
  }
});

test('#5635 investigation memory under budget passes through untouched', () => {
  const memory = heavyMemory(2, 40);
  const outcome = brokerWithMemory(memory);
  assert.equal(outcome.context.investigation.confirmedFacts.length, 2);
  assert.equal(outcome.context.investigation.goal, 'continue');
});
