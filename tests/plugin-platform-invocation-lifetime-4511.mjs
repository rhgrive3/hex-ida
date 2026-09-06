import assert from 'node:assert/strict';
import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function hostContext(counters) {
  const budget = {
    scope() { return this; },
    consume() { counters.budget++; },
  };
  return {
    pluginPolicy: { binaryRead: true },
    resourceBudget: budget,
    async read(_address, length) {
      counters.read++;
      return new Uint8Array(length);
    },
    reportProgress() {
      counters.progress++;
    },
  };
}

async function exerciseLateCapabilities({ abort = false } = {}) {
  const registry = new PlatformPluginRegistry({ timeoutMs: 10 });
  const gate = deferred();
  const started = deferred();
  const finished = deferred();
  const counters = { read: 0, progress: 0, budget: 0, rejected: 0 };

  registry.registerAnalyzer(abort ? 'late.abort' : 'late.timeout', {
    async analyze(context) {
      started.resolve();
      await gate.promise;
      try { await context.read(0x1000n, 1); } catch { counters.rejected++; }
      try { context.reportProgress({ phase: 'late' }); } catch { counters.rejected++; }
      try { context.resourceBudget.consume('operations', 1); } catch { counters.rejected++; }
      finished.resolve();
      return { done: true };
    },
  });

  const controller = abort ? new AbortController() : null;
  const invocation = registry.invoke(
    'analyzer',
    abort ? 'late.abort' : 'late.timeout',
    'analyze',
    hostContext(counters),
    abort ? { timeoutMs: 1000, signal: controller.signal } : { timeoutMs: 10 },
  );

  await started.promise;
  if (abort) controller.abort(new Error('external abort'));
  const result = await invocation;
  assert.equal(result.ok, false);
  if (abort) {
    assert.match(result.error, /external abort|aborted/i);
  } else {
    assert.equal(result.timeout, true);
  }

  gate.resolve();
  await finished.promise;

  assert.equal(counters.read, 0, 'settled invocation must not perform a later host read');
  assert.equal(counters.progress, 0, 'settled invocation must not report late progress');
  assert.equal(counters.budget, 0, 'settled invocation must not mutate the host resource budget');
  assert.equal(counters.rejected, 3, 'all host-facing capabilities must be revoked after settlement');
}

await exerciseLateCapabilities();
await exerciseLateCapabilities({ abort: true });

{
  const registry = new PlatformPluginRegistry({ timeoutMs: 1000 });
  const counters = { read: 0, progress: 0, budget: 0 };
  registry.registerAnalyzer('active.ok', {
    async analyze(context) {
      const bytes = await context.read(0x1000n, 2);
      context.reportProgress({ phase: 'active' });
      context.resourceBudget.consume('operations', 1);
      return bytes.byteLength;
    },
  });

  const result = await registry.invoke(
    'analyzer',
    'active.ok',
    'analyze',
    hostContext(counters),
    { timeoutMs: 1000 },
  );

  assert.equal(result.ok, true);
  assert.equal(result.value, 2);
  assert.deepEqual(counters, { read: 1, progress: 1, budget: 2 });
}
