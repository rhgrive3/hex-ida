// Regression for #5213: batchedScanAccess() created the access-scan timeout
// promise/timer before invoking scanAccess(), but the synchronous-throw catch
// branch only unlinked the parent listener. The timer survived, the orphaned
// timeout promise rejected with no handler (unhandledRejection), and the late
// timer callback still aborted the scan controller. Pin the full lifecycle
// cleanup for the sync-throw path while keeping the async-reject, genuine
// timeout, and success paths intact.
import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { pinpointLocation } from '../js/pinpoint.js';
import { GOALS } from '../js/goals.js';
import { AMOUNT, SHAPE, foldShapes } from '../js/shapes.js';

const BASE = 0x100000000n;
const goal = GOALS.find((g) => g.id === 'hp');

function modelOf(lines) {
  const rows = lines.map((line, i) => {
    const s = line.trim();
    const p = s.indexOf(' ');
    return { row: i, address: BASE + BigInt(i * 4), mn: p < 0 ? s : s.slice(0, p), ops: p < 0 ? '' : s.slice(p + 1) };
  });
  const rowOfAddress = (addr) => {
    const d = addr - BASE;
    if (d < 0n || d >= BigInt(lines.length * 4)) return null;
    return Number(d / 4n);
  };
  return buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
}

const model = modelOf([
  'mov x19, x0',
  'ldr w9, [x20, #0x30]',
  'ldr w8, [x19, #0x20]',
  'sub w8, w8, w9',
  'str w8, [x19, #0x20]',
  'ret',
]);

const program = {
  functionRange: () => ({ start: BASE, end: BASE + 24n }),
  functionStartOf: () => BASE,
};

function shapeIndex() {
  return foldShapes({
    count: 1, capped: false,
    disp: Int32Array.of(0x20),
    size: Uint8Array.of(4),
    flags: Uint8Array.of(SHAPE.DECREASE | SHAPE.CROSS),
    amtKind: Uint8Array.of(AMOUNT.FIELD),
    amtDisp: Int32Array.of(0x30),
    addr: BigUint64Array.of(BASE + 32n),
    span: Int32Array.of(0x100),
    amtSize: Uint8Array.of(4),
    amtSpan: Int32Array.of(0x100),
  });
}

function locate(extra) {
  return pinpointLocation({
    goal,
    ranked: [{ addr: BASE, name: 'applyDamage', strings: ['damage', 'hp'] }],
    program,
    analyze: async () => model,
    budget: { left: 12 },
    limit: 10,
    ...extra,
  });
}

const originalAbortController = globalThis.AbortController;
let createdControllers = [];
class TrackingAbortController extends AbortController {
  constructor() {
    super();
    createdControllers.push(this);
  }
}

function trackedSignal() {
  const parent = new originalAbortController();
  const counts = { added: 0, removed: 0 };
  const signal = new Proxy(parent.signal, {
    get(target, prop) {
      if (prop === 'addEventListener') {
        return (type, listener, options) => { counts.added++; return target.addEventListener(type, listener, options); };
      }
      if (prop === 'removeEventListener') {
        return (type, listener, options) => { counts.removed++; return target.removeEventListener(type, listener, options); };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { parent, signal, counts };
}

async function withAccessProbe(accessTimeoutMs, body) {
  createdControllers = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled = new Map();
  const cleared = new Set();
  const fired = new Set();
  globalThis.AbortController = TrackingAbortController;
  globalThis.setTimeout = (fn, delay, ...args) => {
    if (delay !== accessTimeoutMs) return originalSetTimeout(fn, delay, ...args);
    const id = originalSetTimeout(() => { fired.add(id); fn(); }, delay, ...args);
    scheduled.set(id, { delay });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    if (scheduled.has(id)) cleared.add(id);
    return originalClearTimeout(id);
  };
  try {
    const result = await body();
    return { result, timers: { scheduled, cleared, fired }, controllers: createdControllers };
  } finally {
    globalThis.AbortController = originalAbortController;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ACCESS_TIMEOUT_MS = 20;
const LONG_ACCESS_TIMEOUT_MS = ACCESS_TIMEOUT_MS * 5;

const unhandled = [];
const onUnhandled = (reason) => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);

try {
  Promise.reject(new Error('#5213 detection control'));
  await settle(50);
  assert.equal(unhandled.length, 1, 'the harness must observe an orphan rejection');
  assert.equal(unhandled[0].message, '#5213 detection control');
  unhandled.length = 0;

  // 1. Synchronous throw: the batched wrapper reaches the throwing scan, the
  //    access timer is cleared before it can fire, no orphan timeout
  //    rejection appears, no late callback aborts any controller, and every
  //    parent abort listener registered during the run is unlinked.
  let scanError = null;
  const tracked = trackedSignal();
  const probe = await withAccessProbe(ACCESS_TIMEOUT_MS, () => locate({
    shapes: shapeIndex(),
    signal: tracked.signal,
    accessScanTimeoutMs: ACCESS_TIMEOUT_MS,
    scanAccess() {
      scanError = new Error('scan failed synchronously');
      throw scanError;
    },
  }));
  assert.ok(scanError, 'the batched wrapper must reach the synchronous-throw scan');
  assert.ok(probe.result && Array.isArray(probe.result.candidates), 'pinpoint must settle after the sync-throw scan');
  assert.equal(probe.timers.scheduled.size, 1, 'exactly one access-scan timer must be scheduled');
  await settle(ACCESS_TIMEOUT_MS * 4);
  assert.equal(probe.timers.cleared.size, 1, 'the access-scan timer must be cleared on the sync-throw path');
  assert.equal(probe.timers.fired.size, 0, 'the access-scan timer must not fire after a sync-throw');
  assert.equal(tracked.parent.signal.aborted, false, 'the parent signal must stay untouched');
  assert.deepEqual(unhandled, [], 'a sync-throw must not leave an orphan timeout rejection');
  const syncAborted = probe.controllers.filter((c) => c.signal.aborted);
  assert.deepEqual(syncAborted.map((c) => c.signal.reason), [],
    'the expired timer must not abort any controller after a sync-throw');
  assert.equal(tracked.counts.added, tracked.counts.removed,
    'the sync-throw path must leave no parent abort listener behind');

  // 2. A genuine timeout still cancels the operation, aborts exactly the scan
  //    controller with pinpoint-access-timeout, and unlinks the parent listener.
  const trackedTimeout = trackedSignal();
  let cancelled = 0;
  const timeoutProbe = await withAccessProbe(ACCESS_TIMEOUT_MS, () => locate({
    shapes: shapeIndex(),
    signal: trackedTimeout.signal,
    accessScanTimeoutMs: ACCESS_TIMEOUT_MS,
    scanAccess: () => {
      const pending = new Promise(() => {});
      pending.cancel = () => { cancelled++; };
      return pending;
    },
  }));
  assert.ok(timeoutProbe.result && Array.isArray(timeoutProbe.result.candidates),
    'pinpoint continues after an access timeout');
  assert.equal(cancelled, 1, 'the timed-out scan must be cancelled exactly once');
  const timedOut = timeoutProbe.controllers.filter((c) => c.signal.aborted);
  assert.equal(timedOut.length, 1, 'exactly the scan controller must abort at the genuine timeout');
  assert.equal(timedOut[0].signal.reason, 'pinpoint-access-timeout');
  assert.equal(trackedTimeout.parent.signal.aborted, false,
    'the parent signal must not be aborted by the local timeout');
  assert.equal(trackedTimeout.counts.added, trackedTimeout.counts.removed,
    'the timeout path must unlink its parent listener');

  // 3. An async-rejected scan keeps its existing cleanup (do not regress the
  //    rejection race path).
  const trackedReject = trackedSignal();
  const rejectProbe = await withAccessProbe(LONG_ACCESS_TIMEOUT_MS, () => locate({
    shapes: shapeIndex(),
    signal: trackedReject.signal,
    accessScanTimeoutMs: LONG_ACCESS_TIMEOUT_MS,
    scanAccess: async () => { throw new Error('scan failed asynchronously'); },
  }));
  assert.ok(rejectProbe.result && Array.isArray(rejectProbe.result.candidates),
    'pinpoint continues after an async scan rejection');
  await settle(LONG_ACCESS_TIMEOUT_MS + 40);
  assert.equal(rejectProbe.timers.cleared.size, 1, 'the async-reject path must clear the access timer');
  assert.equal(rejectProbe.timers.fired.size, 0, 'the async-reject path must not let the timer fire');
  assert.deepEqual(unhandled, [], 'the async-reject path must not leak rejections');
  assert.equal(trackedReject.counts.added, trackedReject.counts.removed,
    'the async-reject path must unlink its parent listener');

  // 4. Success path: one batched scan is served, every timer/listener is
  //    cleaned up, and the cached groups are reused without a second scan.
  const trackedSuccess = trackedSignal();
  let scans = 0;
  const shapes = shapeIndex();
  const scanAccess = async (requested) => {
    scans++;
    const groups = new Map();
    for (const item of requested) {
      groups.set(BigInt(item.offset).toString(), [{ addr: BASE + 16n, kind: 'store', size: 4 }]);
    }
    return groups;
  };
  const successProbe = await withAccessProbe(LONG_ACCESS_TIMEOUT_MS, async () => {
    const first = await locate({ shapes, signal: trackedSuccess.signal, accessScanTimeoutMs: LONG_ACCESS_TIMEOUT_MS, scanAccess });
    const second = await locate({ shapes, signal: trackedSuccess.signal, accessScanTimeoutMs: LONG_ACCESS_TIMEOUT_MS, scanAccess });
    return { first, second };
  });
  assert.equal(scans, 1, 'the batched success path performs one cached scan across goals');
  assert.ok(successProbe.result.first.changeSites.length >= 1, 'access evidence remains available');
  assert.ok(successProbe.result.second.changeSites.length >= 1, 'the cached batch serves later goals');
  assert.equal(successProbe.timers.scheduled.size, 1, 'the cached reuse must not schedule a second access timer');
  assert.equal(successProbe.timers.cleared.size, 1, 'the success path must clear the access timer');
  assert.equal(successProbe.timers.fired.size, 0, 'the success path must not let the timer fire');
  assert.equal(trackedSuccess.counts.added, trackedSuccess.counts.removed,
    'the success path must unlink its parent listeners');
  assert.deepEqual(unhandled, [], 'the success path must not leak rejections');
} finally {
  process.off('unhandledRejection', onUnhandled);
}

console.log('issue #5213 batched scanAccess sync-throw timer lifecycle regression PASS');
