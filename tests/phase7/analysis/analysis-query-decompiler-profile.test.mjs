import test from 'node:test';
import assert from 'node:assert/strict';
import { decompilerOptionsFromQuery } from '../../../js/analysis/query/app-adapter.js';
import { applyDecompilerProfile } from '../../../js/decompiler/profiles.js';

test('analysis query forwards only decompiler execution profile options', () => {
  const controller = new AbortController();
  const forwarded = decompilerOptionsFromQuery({
    profile: 'fast',
    decompilerTimeBudgetMs: 41,
    phase8TimeBudgetMs: 17,
    phase8WorkBudget: 1234,
    renderProvenanceBudget: { maxTransformRecords: 12 },
    renderProvenanceBindingBudget: { maxConsumers: 34 },
    signal: controller.signal,
    onProgress() {},
    priority: 'interactive',
  });

  assert.deepEqual(forwarded, {
    profile: 'fast',
    decompilerTimeBudgetMs: 41,
    phase8TimeBudgetMs: 17,
    phase8WorkBudget: 1234,
    renderProvenanceBudget: { maxTransformRecords: 12 },
    renderProvenanceBindingBudget: { maxConsumers: 34 },
  });
  assert.equal('signal' in forwarded, false);
  assert.equal('onProgress' in forwarded, false);
  assert.equal('priority' in forwarded, false);
});

test('analysis query fast profile resolves to the production fast budgets', () => {
  const forwarded = decompilerOptionsFromQuery({ profile: 'fast' });
  const resolved = applyDecompilerProfile(forwarded);
  assert.equal(resolved.decompilerTimeBudgetMs, 30);
  assert.equal(resolved.phase8TimeBudgetMs, 30);
  assert.equal(resolved.phase8WorkBudget, 10000);
  assert.deepEqual(resolved.renderProvenanceBudget, { maxTransformRecords: 128 });
  assert.deepEqual(resolved.renderProvenanceBindingBudget, { maxConsumers: 256 });
});

test('explicit query budgets still override profile defaults', () => {
  const resolved = applyDecompilerProfile(decompilerOptionsFromQuery({
    profile: 'fast',
    phase8TimeBudgetMs: 9,
    phase8WorkBudget: 777,
  }));
  assert.equal(resolved.decompilerTimeBudgetMs, 30);
  assert.equal(resolved.phase8TimeBudgetMs, 9);
  assert.equal(resolved.phase8WorkBudget, 777);
});
