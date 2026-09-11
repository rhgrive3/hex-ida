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
  assert.equal(result.executionMayContinue, true, 'settlement must disclose that arbitrary plugin code may still be running');

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
  assert.equal(result.executionMayContinue, undefined, 'successful invocations must not report a late-execution boundary');
  assert.deepEqual(counters, { read: 1, progress: 1, budget: 2 });
}

{
  const registry = new PlatformPluginRegistry({ timeoutMs: 1000 });
  const started = deferred();
  const stopped = deferred();
  const controller = new AbortController();
  registry.registerAnalyzer('cooperative.abort', {
    async analyze(_context, options) {
      started.resolve(options.signal);
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        if (options.signal.aborted) reject(options.signal.reason);
      }).catch(() => stopped.resolve());
      return { reachedAfterAbort: false };
    },
  });

  const invocation = registry.invoke(
    'analyzer',
    'cooperative.abort',
    'analyze',
    {},
    { timeoutMs: 1000, signal: controller.signal },
  );
  const invocationSignal = await started.promise;
  assert.notEqual(invocationSignal, controller.signal, 'plugin must receive a per-invocation signal');
  assert.equal(invocationSignal.aborted, false);
  controller.abort(new Error('cooperative stop'));
  await stopped.promise;
  const result = await invocation;
  assert.equal(result.ok, false, 'external abort remains the invocation result even when the plugin cooperates');
  assert.match(result.error, /cooperative stop|aborted/i);
  assert.equal(result.executionMayContinue, true);
  assert.equal(invocationSignal.aborted, true);
}

{
  const registry = new PlatformPluginRegistry({ timeoutMs: 15 });
  const started = deferred();
  const stopped = deferred();
  registry.registerAnalyzer('cooperative.timeout', {
    async analyze(context) {
      started.resolve(context.signal);
      await new Promise((resolve, reject) => {
        context.signal.addEventListener('abort', () => {
          stopped.resolve(context.signal.reason);
          reject(context.signal.reason);
        }, { once: true });
      });
      return { unreachable: true };
    },
  });

  const invocation = registry.invoke('analyzer', 'cooperative.timeout', 'analyze', {});
  const invocationSignal = await started.promise;
  const reason = await stopped.promise;
  const result = await invocation;
  assert.equal(result.ok, false);
  assert.equal(result.timeout, true);
  assert.equal(result.executionMayContinue, true);
  assert.equal(invocationSignal.aborted, true);
  assert.equal(reason.code, 'PLUGIN_INVOCATION_TIMEOUT');
}
