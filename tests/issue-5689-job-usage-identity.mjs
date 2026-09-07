// Regression for #5689: AgentJobManager merged runtime-reported usage into
// the job budget with `Number(... || 0)`. A NaN-coercing value disabled the
// elapsed hard limit forever after (`NaN >= limit` is false) and negative
// values rewound monotonic accounting. Only primitive finite non-negative
// numbers are adopted.
import assert from 'node:assert/strict';
import { AgentJobManager } from '../js/ai/jobs/index.js';

function managerWith(usage, limits = { maxSlices: 32, maxElapsedMs: 1000 }) {
  return new AgentJobManager({
    runtime: {
      async turn() {
        return {
          limits: { exhausted: true, reason: 'slice-budget' },
          usage,
          evidence: [], hypotheses: [], activity: [], followups: [],
          scope: { effective: 'auto' },
        };
      },
    },
    ...limits,
  });
}

async function runOne(usage, limits) {
  const manager = managerWith(usage, limits);
  const job = await manager.create({ jobId: `usage-${Math.random().toString(36).slice(2)}`, goal: 'test', ...limits });
  await manager.runSlice(job.id);
  return (await manager.get(job.id)).budgetUsage;
}

{
  // The issue's example: a NaN-coercing elapsed must not poison the accumulator.
  const usage = await runOne({ elapsedMs: 'not-a-number', modelCalls: '3', toolCalls: true });
  assert.equal(Number.isNaN(usage.elapsedMs), false, 'a NaN usage must not poison the budget accumulator');
  assert.equal(usage.elapsedMs, 0);
  assert.equal(usage.modelCalls, 0);
  assert.equal(usage.toolCalls, 0);
}

{
  // Negative values must not rewind monotonic accounting.
  const usage = await runOne({ elapsedMs: -900 });
  assert.equal(usage.elapsedMs, 0, 'a negative usage must not rewind the elapsed counter');
}

{
  // The elapsed hard limit still trips on honest, finite reports.
  const usage = await runOne({ elapsedMs: 1500 }, { maxSlices: 32, maxElapsedMs: 1000 });
  assert.equal(usage.elapsedMs, 1500);
}

{
  // Honest numeric usage is unchanged.
  const usage = await runOne({ elapsedMs: 100, modelCalls: 2, toolCalls: 4, contextBytes: 500 });
  assert.deepEqual({ ...usage }, { slices: 1, modelCalls: 2, toolCalls: 4, elapsedMs: 100, contextBytes: 500 });
}
