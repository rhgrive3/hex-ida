import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeAnalysisPlatform } from '../../../js/runtime/index.js';

function platformFor(adapter) {
  const platform = new RuntimeAnalysisPlatform({ symbolic: false });
  platform.registerAdapter('deadline-test', adapter);
  return platform.startSession({ adapter: 'deadline-test', binaryHash: 'bin-4572', connect: false })
    .then((session) => ({ platform, session }));
}

function baseAdapter(overrides = {}) {
  return {
    id: 'deadline-test',
    kind: 'deadline-test',
    capabilities: { launch: true, resume: true, traceFunction: true },
    ...overrides,
  };
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('#4572 launch is bounded by the trace-wide deadline even when the adapter ignores cancellation', async () => {
  let launchOptions;
  const adapter = baseAdapter({
    async launch(_spec, options) {
      launchOptions = options;
      await delay(120);
      return { launched: true };
    },
    async resume() {
      assert.fail('resume must not start after launch consumes the deadline');
    },
  });
  const { platform, session } = await platformFor(adapter);
  const started = Date.now();
  try {
    await assert.rejects(
      platform.traceFunction(0x1000n, { timeoutMs: 25 }),
      (error) => error?.code === 'timeout',
    );
    assert.ok(Date.now() - started < 200, 'platform boundary must not await a non-cooperative late launch');
    assert.equal(launchOptions.signal.aborted, true);
    assert.equal(launchOptions.signal.reason, 'timeout');
    assert.ok(launchOptions.timeoutMs >= 1 && launchOptions.timeoutMs <= 25);
    assert.equal(session.controllers.size, 0);
  } finally {
    await delay(0);
  }
});

test('#4572 resume receives only the remaining trace-wide timeout budget', async () => {
  const realNow = Date.now;
  let now = 10_000;
  let resumeOptions;
  Date.now = () => now;
  const adapter = baseAdapter({
    async launch(_spec, options) {
      assert.equal(options.timeoutMs, 1000);
      now += 900;
    },
    async resume(options) {
      resumeOptions = options;
      return { stop: { kind: 'return' }, trace: { events: [] } };
    },
  });
  const { platform } = await platformFor(adapter);
  try {
    const result = await platform.traceFunction(0x2000n, { timeoutMs: 1000 });
    assert.equal(result.observation.stop.kind, 'return');
    assert.equal(resumeOptions.timeoutMs, 100);
  } finally {
    Date.now = realNow;
  }
});

test('#4572 trace phase shares the same deadline after launch and resume', async () => {
  const realNow = Date.now;
  let now = 20_000;
  let traceOptions;
  Date.now = () => now;
  const adapter = baseAdapter({
    async launch() { now += 300; },
    async resume(options) {
      assert.equal(options.timeoutMs, 700);
      now += 250;
      return { stop: { kind: 'paused' } };
    },
    async trace(options) {
      traceOptions = options;
      return { events: [] };
    },
  });
  const { platform } = await platformFor(adapter);
  try {
    await platform.traceFunction(0x3000n, { timeoutMs: 1000 });
    assert.equal(traceOptions.timeoutMs, 450);
  } finally {
    Date.now = realNow;
  }
});

test('#4572 timeout-free trace preserves phase options without an artificial deadline', async () => {
  const seen = [];
  const adapter = baseAdapter({
    async launch(_spec, options) { seen.push(['launch', options]); },
    async resume(options) {
      seen.push(['resume', options]);
      return { stop: { kind: 'paused' } };
    },
    async trace(options) {
      seen.push(['trace', options]);
      return { events: [] };
    },
  });
  const { platform } = await platformFor(adapter);
  await platform.traceFunction(0x4000n);
  assert.equal(seen[0][1].timeoutMs, undefined);
  assert.equal(seen[1][1].timeoutMs, undefined);
  assert.equal(seen[2][1].timeoutMs, undefined);
});

test('#4572 external abort wins cleanly and releases the operation controller', async () => {
  const external = new AbortController();
  let launchSignal;
  const adapter = baseAdapter({
    async launch(_spec, options) {
      launchSignal = options.signal;
      external.abort({ source: 'user' });
      await delay(80);
    },
    async resume() { assert.fail('resume must not run after external cancellation'); },
  });
  const { platform, session } = await platformFor(adapter);
  try {
    await assert.rejects(
      platform.traceFunction(0x5000n, { timeoutMs: 1000, signal: external.signal }),
      (error) => error?.code === 'cancelled',
    );
    assert.equal(launchSignal.aborted, true);
    assert.equal(session.controllers.size, 0);
  } finally {
    await delay(0);
  }
});

test('#4572 an exhausted deadline prevents the next phase from starting', async () => {
  const realNow = Date.now;
  let now = 30_000;
  let resumeCalls = 0;
  Date.now = () => now;
  const adapter = baseAdapter({
    async launch() { now += 1000; },
    async resume() { resumeCalls += 1; },
  });
  const { platform, session } = await platformFor(adapter);
  try {
    await assert.rejects(
      platform.traceFunction(0x6000n, { timeoutMs: 1000 }),
      (error) => error?.code === 'timeout',
    );
    assert.equal(resumeCalls, 0);
    assert.equal(session.controllers.size, 0);
  } finally {
    Date.now = realNow;
  }
});


test('#4572 a terminal resume result that settles after the deadline cannot publish trace evidence', async () => {
  const realNow = Date.now;
  let now = 40_000;
  Date.now = () => now;
  const adapter = baseAdapter({
    async launch() { now += 100; },
    async resume() {
      now += 901;
      return { stop: { kind: 'return' }, trace: { events: [] } };
    },
  });
  const { platform, session } = await platformFor(adapter);
  try {
    await assert.rejects(
      platform.traceFunction(0x7000n, { timeoutMs: 1000 }),
      (error) => error?.code === 'timeout',
    );
    assert.equal(platform.evidence.length, 0);
    assert.equal(session.controllers.size, 0);
  } finally {
    Date.now = realNow;
  }
});

test('#4572 a late adapter rejection after hard timeout is observed and cannot become unhandled', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const adapter = baseAdapter({
    async launch() {
      await delay(45);
      throw new Error('late launch failure');
    },
    async resume() { assert.fail('resume must not run'); },
  });
  const { platform } = await platformFor(adapter);
  try {
    await assert.rejects(
      platform.traceFunction(0x8000n, { timeoutMs: 15 }),
      (error) => error?.code === 'timeout',
    );
    await delay(60);
    assert.deepEqual(unhandled, []);
    assert.equal(platform.evidence.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
