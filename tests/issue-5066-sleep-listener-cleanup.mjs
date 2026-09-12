import assert from 'node:assert/strict';
import { executeAutomationProgram } from '../js/userscript/dev/skills/automation-program.js';

const CLOCK_STEP_MS = 25;
const POLL_MS = 10;
const TIMEOUT_MS = 100;
const ABORT_WINDOW_MS = 1000;
const EXPECTED_POLLS = 4;

await testPollingLeavesNoAbortListener();
await testPollingThenSuccessLeavesNoAbortListener();
await testAbortDuringPollingStillCancels();
await testRealAbortSignalDuringPolling();
console.log('issue 5066 sleep listener cleanup: ok');

async function testPollingLeavesNoAbortListener() {
  const probe = trackingSignal();
  const document = fakeDocument({});
  const value = await executeAutomationProgram({
    version: 1, name: 'wait-missing', readOnly: true,
    steps: [{ op: 'waitFor', selector: '#never', as: 'missing', optional: true, timeoutMs: TIMEOUT_MS, pollMs: POLL_MS }],
  }, { document, location: fakeLocation(), signal: probe.signal, now: steppingNow() });

  assert.equal(value.missing, null, 'optional waitFor must settle with a null binding');
  assert.equal(probe.registered, EXPECTED_POLLS, `polling must register one abort listener per sleep (got ${probe.registered})`);
  assert.equal(probe.peak, 1, 'at most one sleep may hold an abort listener at a time');
  assert.equal(probe.retained, 0, 'settled sleeps must remove their abort listener from the signal');
}

async function testAbortDuringPollingStillCancels() {
  const probe = trackingSignal(2);
  const document = fakeDocument({});
  const pending = executeAutomationProgram({
    version: 1, name: 'abort-mid-poll', readOnly: true,
    steps: [{ op: 'waitFor', selector: '#never', as: 'missing', optional: true, timeoutMs: ABORT_WINDOW_MS, pollMs: POLL_MS }],
  }, { document, location: fakeLocation(), signal: probe.signal, now: steppingNow() });

  await assert.rejects(pending, (error) => error.code === 'cancelled');
  assert.equal(probe.registered, 2, 'cancellation must arrive while the program is still polling');
  assert.equal(probe.retained, 0, 'a rejected sleep must also remove its abort listener');
}

async function testRealAbortSignalDuringPolling() {
  const controller = new AbortController();
  const document = fakeDocument({});
  const pending = executeAutomationProgram({
    version: 1, name: 'real-signal', readOnly: true,
    steps: [{ op: 'waitFor', selector: '#never', as: 'missing', optional: true, timeoutMs: ABORT_WINDOW_MS, pollMs: POLL_MS }],
  }, { document, location: fakeLocation(), signal: controller.signal, now: steppingNow() });

  await sleep(POLL_MS * 2);
  controller.abort(new Error('user stopped'));
  await assert.rejects(pending, (error) => error.code === 'cancelled');
}

async function testPollingThenSuccessLeavesNoAbortListener() {
  const probe = trackingSignal();
  let polls = 0;
  const document = {
    querySelector(selector) {
      if (selector !== '#late') return null;
      polls += 1;
      return polls >= 3 ? { tagName: 'DIV', textContent: 'late' } : null;
    },
    querySelectorAll(selector) { return [selector].filter((name) => this.querySelector(name) !== null); },
  };
  const value = await executeAutomationProgram({
    version: 1, name: 'wait-late', readOnly: true,
    steps: [
      { op: 'waitFor', selector: '#late', as: 'late', timeoutMs: TIMEOUT_MS, pollMs: POLL_MS },
      { op: 'assert', condition: { type: 'exists', target: 'late' } },
      { op: 'return', value: { found: true } },
    ],
  }, { document, location: fakeLocation(), signal: probe.signal, now: steppingNow() });

  assert.deepEqual(value, { found: true });
  assert.equal(polls, 3, 'waitFor must succeed on the third poll');
  assert.equal(probe.registered, 2, 'the success path must sleep once per unsuccessful poll');
  assert.equal(probe.retained, 0, 'the sleep that resolved into the successful poll must clean up its listener');
}

function trackingSignal(autoAbortAfter = Infinity) {
  const listeners = new Set();
  let registered = 0;
  let peak = 0;
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(type, listener) {
      if (type !== 'abort') return;
      registered += 1;
      listeners.add(listener);
      peak = Math.max(peak, listeners.size);
      if (registered === autoAbortAfter) signal.abort(new Error('user stopped'));
    },
    removeEventListener(type, listener) {
      if (type !== 'abort') return;
      listeners.delete(listener);
    },
    abort(reason) {
      if (signal.aborted) return;
      signal.aborted = true;
      signal.reason = reason || new Error('cancelled');
      for (const listener of [...listeners]) {
        listeners.delete(listener);
        listener();
      }
    },
  };
  return {
    signal,
    get registered() { return registered; },
    get retained() { return listeners.size; },
    get peak() { return peak; },
  };
}

function steppingNow() {
  let calls = 0;
  return () => {
    const value = calls * CLOCK_STEP_MS;
    calls += 1;
    return value;
  };
}

function fakeDocument(entries) {
  return {
    querySelector(selector) { return entries[selector] || null; },
    querySelectorAll(selector) { return entries[selector] ? [entries[selector]] : []; },
  };
}

function fakeLocation() {
  return { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com', pathname: '/' };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
