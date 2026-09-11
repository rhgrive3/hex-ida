import assert from 'node:assert/strict';
import { runAgent } from '../../js/agent/runtime.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settleWithin(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}-did-not-settle`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function oneToolModel(tool, args) {
  return {
    async next({ observations }) {
      if (observations.length) return { answer:{ confidence:0 } };
      return { tool, args };
    },
  };
}

// The run deadline is authoritative even when a backend ignores cancellation.
{
  let seenSignal = null;
  const running = runAgent({
    goal:'find string needle',
    timeoutMs:20,
    budget:{ maxToolCalls:1, timeoutMs:20 },
    llm:oneToolModel('search_strings', ['needle']),
    context:{
      async searchStrings(_query, options) {
        seenSignal = options?.signal ?? null;
        return new Promise(() => {});
      },
    },
  });
  const result = await settleWithin(running, 150, 'tool-timeout');
  assert.ok(result.missingEvidence.includes('timeout'));
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].result.error, 'timeout');
  assert.ok(seenSignal instanceof AbortSignal, 'known option-bearing tools should receive the run signal');
  assert.equal(seenSignal.aborted, true, 'the cooperative tool signal must abort at the run deadline');
}

// A cooperative backend may reject immediately when the run signal aborts;
// the run-level terminal reason must still be the authoritative timeout.
{
  const running = runAgent({
    goal:'find string needle', timeoutMs:20,
    budget:{ maxToolCalls:1, timeoutMs:20 },
    llm:oneToolModel('search_strings', ['needle']),
    context:{
      async searchStrings(_query, options) {
        return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('backend-aborted')), { once:true });
        });
      },
    },
  });
  const result = await settleWithin(running, 150, 'cooperative-tool-timeout');
  assert.ok(result.missingEvidence.includes('timeout'));
}

// Caller cancellation must settle the run while the tool is pending, even if
// the backend never observes its signal.
{
  const controller = new AbortController();
  let started;
  const toolStarted = new Promise((resolve) => { started = resolve; });
  const running = runAgent({
    goal:'find string needle',
    timeoutMs:1000,
    budget:{ maxToolCalls:1, timeoutMs:1000 },
    signal:controller.signal,
    llm:oneToolModel('search_strings', ['needle']),
    context:{
      async searchStrings() {
        started();
        return new Promise(() => {});
      },
    },
  });
  await toolStarted;
  controller.abort('user-cancelled');
  const result = await settleWithin(running, 150, 'tool-cancel');
  assert.ok(result.missingEvidence.includes('cancelled'));
  assert.ok(!result.missingEvidence.includes('timeout'));
  assert.equal(result.observations[0].result.error, 'cancelled');
}

// analyze() is a sibling backend path reached through deterministic tools. It
// must be bounded by the outer run boundary even if it has no cooperative
// signal contract at this call site.
{
  const running = runAgent({
    goal:'inspect function 0x1000',
    timeoutMs:20,
    budget:{ maxToolCalls:1, timeoutMs:20 },
    llm:oneToolModel('get_function', [0x1000n]),
    context:{
      candidateFunctions:[0x1000n],
      async analyze() { return new Promise(() => {}); },
    },
  });
  const result = await settleWithin(running, 150, 'analyze-timeout');
  assert.ok(result.missingEvidence.includes('timeout'));
  assert.equal(result.observations[0].result.error, 'timeout');
}

// Optional passthrough tools have heterogeneous signatures, so the runtime
// must not depend on signal injection to bound them.
for (const [tool, method] of [['decompile', 'decompile'], ['emulate', 'emulate'], ['resolve_type', 'resolveType']]) {
  const context = {
    [method]: async () => new Promise(() => {}),
  };
  const running = runAgent({
    goal:`exercise ${tool}`,
    timeoutMs:20,
    budget:{ maxToolCalls:1, timeoutMs:20 },
    llm:oneToolModel(tool, [0x1000n]),
    context,
  });
  const result = await settleWithin(running, 150, `${tool}-timeout`);
  assert.ok(result.missingEvidence.includes('timeout'), `${tool} must share the run deadline`);
  assert.equal(result.observations[0].result.error, 'timeout');
}

// A normal tool result remains an observation/evidence source when it settles
// before the deadline.
{
  const result = await runAgent({
    goal:'find string needle',
    timeoutMs:500,
    budget:{ maxToolCalls:1, timeoutMs:500 },
    llm:oneToolModel('search_strings', ['needle']),
    context:{
      async searchStrings() {
        return { results:[{ address:0x2000n, value:'needle', evidence:['string:needle'] }], total:1, complete:true };
      },
    },
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].result.error, undefined);
  assert.ok(result.evidence.includes('string:needle'), 'pre-deadline deterministic evidence must be preserved');
}

// The refactor must preserve the model-side timeout boundary as well.
{
  let modelSignal = null;
  const result = await settleWithin(runAgent({
    goal:'inspect function', timeoutMs:20,
    budget:{ maxToolCalls:1, timeoutMs:20 },
    context:{},
    llm:{ async next({ signal }) { modelSignal = signal; return new Promise(() => {}); } },
  }), 150, 'model-timeout');
  assert.ok(result.missingEvidence.includes('timeout'));
  assert.equal(result.observations.length, 0);
  assert.ok(modelSignal instanceof AbortSignal);
  assert.equal(modelSignal.aborted, true);
}

// A late completion after timeout is abandoned: it cannot mutate returned
// observations/evidence, and a late rejection must already have a handler.
{
  let resolveBackend;
  const backend = new Promise((resolve) => { resolveBackend = resolve; });
  const running = runAgent({
    goal:'find string needle', timeoutMs:20,
    budget:{ maxToolCalls:1, timeoutMs:20 },
    llm:oneToolModel('search_strings', ['needle']),
    context:{ async searchStrings() { return backend; } },
  });
  const result = await settleWithin(running, 150, 'late-resolve-timeout');
  const frozen = JSON.stringify({ observations:result.observations, evidence:result.evidence });
  resolveBackend({ results:[], evidence:['stale-evidence'], total:0, complete:true });
  await delay(30);
  assert.equal(JSON.stringify({ observations:result.observations, evidence:result.evidence }), frozen);
  assert.ok(!result.evidence.includes('stale-evidence'));
}

{
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    let rejectBackend;
    const backend = new Promise((_, reject) => { rejectBackend = reject; });
    const running = runAgent({
      goal:'find string needle', timeoutMs:20,
      budget:{ maxToolCalls:1, timeoutMs:20 },
      llm:oneToolModel('search_strings', ['needle']),
      context:{ async searchStrings() { return backend; } },
    });
    await settleWithin(running, 150, 'late-reject-timeout');
    rejectBackend(new Error('late-backend-failure'));
    await delay(30);
    assert.deepEqual(unhandled, [], 'abandoned tool rejection must remain observed');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
}

// The tool receives only the remaining portion of the single run deadline;
// model time is not reset when tool execution begins. A fresh tool timeout would
// let this backend resolve normally, while the shared deadline must expire first.
{
  let toolStarted = false;
  const result = await settleWithin(runAgent({
    goal:'find string needle', timeoutMs:100,
    budget:{ maxToolCalls:1, timeoutMs:100 },
    llm:{ async next() { await delay(45); return { tool:'search_strings', args:['needle'] }; } },
    context:{
      async searchStrings() {
        toolStarted = true;
        await delay(70);
        return { results:[], total:0, complete:true };
      },
    },
  }), 220, 'shared-deadline');
  assert.equal(toolStarted, true, 'the model phase must complete before the shared deadline');
  assert.ok(result.missingEvidence.includes('timeout'));
  assert.equal(result.observations[0].result.error, 'timeout', 'the tool must not receive a fresh full timeout');
}

console.log('issue #4579 agent tool run-budget boundary: PASS');
