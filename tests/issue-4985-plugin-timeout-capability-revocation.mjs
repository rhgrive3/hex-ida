// Regression for #4985: PlatformPluginRegistry.invoke() must revoke the
// invocation's host-facing capabilities once the invocation has been settled
// by timeout or external abort. A timed-out plugin continuation must not be
// able to perform a late binary read, report late progress, or consume the
// host resource budget, and its late settle must not produce unhandled
// rejections or leak into the next invocation.
import assert from 'node:assert/strict';
import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function hostCounters() {
  return { hostReads: 0, hostProgress: 0, hostBudgetConsume: 0, pluginReadsRejected: 0, pluginProgressRejected: 0, pluginBudgetRejected: 0 };
}

function hostContext(counters) {
  return {
    pluginPolicy: { binaryRead: true },
    resourceBudget: {
      scope() { return this; },
      consume() { counters.hostBudgetConsume += 1; },
    },
    read: async (_address, length) => { counters.hostReads += 1; return new Uint8Array(length); },
    reportProgress: () => { counters.hostProgress += 1; },
  };
}

async function exerciseLateContinuation({ abort }) {
  const gate = deferred();
  const finished = deferred();
  const counters = hostCounters();
  const registry = new PlatformPluginRegistry();
  registry.registerAnalyzer('issue4985.late-continuation', {
    async analyze(context) {
      await new Promise((r) => setTimeout(r, 30));
      try { await context.read(0n, 1); } catch { counters.pluginReadsRejected += 1; }
      try { context.reportProgress({ phase: 'late' }); } catch { counters.pluginProgressRejected += 1; }
      try { context.resourceBudget.consume('bytesRead', 1); } catch { counters.pluginBudgetRejected += 1; }
      finished.resolve();
      return 'late';
    },
  });
  const controller = abort ? new AbortController() : null;
  const invocation = registry.invoke(
    'analyzer', 'issue4985.late-continuation', 'analyze', hostContext(counters),
    abort ? { timeoutMs: 5000, signal: controller.signal } : { timeoutMs: 10 },
  );
  if (abort) setTimeout(() => controller.abort(new Error('external abort')), 5);
  const result = await invocation;
  assert.equal(result.ok, false);
  if (abort) assert.match(result.error, /external abort|abort/i);
  else assert.equal(result.timeout, true);
  gate.resolve();
  await finished.promise;

  assert.equal(counters.hostReads, 0, 'a settled invocation must not perform a late binary read');
  assert.equal(counters.hostProgress, 0, 'a settled invocation must not deliver late progress to the host');
  assert.equal(counters.hostBudgetConsume, 0, 'a settled invocation must not consume host resource budget');
  assert.equal(counters.pluginReadsRejected, 1);
  assert.equal(counters.pluginProgressRejected, 1);
  assert.equal(counters.pluginBudgetRejected, 1);
}

await exerciseLateContinuation({ abort: false });
await exerciseLateContinuation({ abort: true });

// Pre-settlement capabilities stay intact and later invocations are isolated.
{
  const counters = hostCounters();
  const registry = new PlatformPluginRegistry({ timeoutMs: 1000 });
  registry.registerAnalyzer('issue4985.timed-out', {
    async analyze(context) {
      await context.read(0n, 4);
      await new Promise((r) => setTimeout(r, 60));
      return 'never';
    },
  });
  registry.registerAnalyzer('issue4985.clean', {
    async analyze(context) {
      const bytes = await context.read(0n, 2);
      context.reportProgress({ phase: 'clean' });
      context.resourceBudget.consume('bytesRead', 2);
      return bytes.byteLength;
    },
  });
  const timedOut = await registry.invoke('analyzer', 'issue4985.timed-out', 'analyze', hostContext(counters), { timeoutMs: 10 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.timeout, true);
  assert.equal(counters.hostReads, 1, 'reads issued before settlement remain allowed');
  const clean = await registry.invoke('analyzer', 'issue4985.clean', 'analyze', hostContext(counters));
  assert.equal(clean.ok, true);
  assert.equal(clean.value, 2, 'late side effects must not leak into the next invocation');
  assert.equal(counters.hostProgress, 1);
  assert.equal(counters.hostBudgetConsume, 3);
}

console.log('issue 4985 plugin timeout capability revocation: PASS');
