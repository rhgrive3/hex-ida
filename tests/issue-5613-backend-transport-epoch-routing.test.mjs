import assert from 'node:assert/strict';

const workers = [];
class ControlledWorker {
  constructor(url) {
    this.url = String(url);
    this.sent = [];
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
    workers.push(this);
  }
  postMessage(message) { this.sent.push(message); }
  terminate() { this.terminated = true; }
  reply(request, result, { ok = true, error = null } = {}) {
    this.onmessage?.({
      data: ok
        ? { t: 'ok', id: request.id, epoch: request.epoch, result }
        : { t: 'err', id: request.id, epoch: request.epoch, error: error || 'failed' },
    });
  }
  sendProgress(type, requestId, epoch, progressPayload = {}) {
    this.onmessage?.({
      data: { t: type, requestId, epoch, ...progressPayload },
    });
  }
}
globalThis.Worker = ControlledWorker;

const { Backend, StaleRequestError } = await import('../js/backend.js');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Setup backend
const backend = new Backend();
backend._worker('platform');
backend._worker('legacy');
const legacy = workers.find((w) => /worker\.js/.test(w.url) && !/platform/.test(w.url));
const platform = workers.find((w) => /platform\/worker\.js/.test(w.url));
assert.ok(legacy && platform);

// Initial open to get into a stable state
const initialFile = { name: 'init.bin', size: 1024 };
const openInit = backend.open(initialFile);
await tick();
const initDetect = platform.sent.find((m) => m.t === 'open' && m.file === initialFile);
platform.reply(initDetect, {
  detection: { formatId: 'elf' },
  formatId: 'elf',
  capability: { architecture: 'x86_64' },
  slices: [{ id: 's0', default: true }],
  raw: { id: 'raw' },
});
await openInit;

// 1. Current epoch progress and final resolve normally
{
  let progressCount = 0;
  const searchPromise = backend.search({ pattern: 'pattern' }, (p) => { progressCount++; });
  await tick();
  const searchMsg = platform.sent.find((m) => m.t === 'search');
  assert.ok(searchMsg);
  const currentEpoch = searchMsg.epoch;

  // Send progress
  platform.sendProgress('searchProgress', searchMsg.id, currentEpoch, { hits: 1 });
  assert.equal(progressCount, 1, 'current epoch progress must be delivered');

  // Send ok final
  platform.reply(searchMsg, { hits: [{ address: '0x1000' }] });
  const result = await searchPromise;
  assert.deepEqual(result, { hits: [{ address: '0x1000' }] });
}

// 2 & 3. After open() begins (incrementing transportEpoch), old transport progress is dropped and old final ok rejects with StaleRequestError
{
  let oldProgressDelivered = false;
  const scanPromise = backend.search({ pattern: 'scan-pattern' }, (p) => { oldProgressDelivered = true; });
  const scanRejection = assert.rejects(
    scanPromise,
    (err) => err instanceof StaleRequestError || err?.stale === true,
    'old transport request must reject with StaleRequestError when completed after transportEpoch changed',
  );
  await tick();
  const scanMsg = platform.sent.find((m) => m.t === 'search' && m.pattern === 'scan-pattern');
  assert.ok(scanMsg);
  const oldEpoch = scanMsg.epoch;

  // Start a new open() -> increments backend.transportEpoch and rejects old pending
  const newFile = { name: 'new.bin', size: 2048 };
  const openPromise = backend.open(newFile);
  await tick();

  // Send progress from old request with old epoch
  platform.sendProgress('searchProgress', scanMsg.id, oldEpoch, { hits: 1 });
  assert.equal(oldProgressDelivered, false, 'progress from old transport epoch must not be delivered after open() starts');

  // Send final ok from old request with old epoch
  platform.reply(scanMsg, { hits: ['old_hit'] });

  // Await rejection
  await scanRejection;

  // Complete open
  const newOpenMsg = platform.sent.find((m) => m.t === 'open' && m.file === newFile);
  platform.reply(newOpenMsg, {
    detection: { formatId: 'elf' },
    formatId: 'elf',
    capability: { architecture: 'x86_64' },
    slices: [{ id: 's0', default: true }],
    raw: { id: 'raw' },
  });
  await openPromise;
}

// 4. Progress types: scanProgress and analysisProgress also dropped when epoch is stale
{
  let scanProgressCalled = false;
  let analysisProgressCalled = false;
  backend.onScanProgress = () => { scanProgressCalled = true; };
  backend.onAnalysisProgress = () => { analysisProgressCalled = true; };

  // Register fake pending in old epoch
  backend.pending.set('old-scan', {
    resolve: () => {},
    reject: () => {},
    uiEpoch: backend.gen,
    transportEpoch: backend.transportEpoch - 1, // older epoch
    workerName: 'platform',
  });
  backend.pending.set('old-analysis', {
    resolve: () => {},
    reject: () => {},
    uiEpoch: backend.gen,
    transportEpoch: backend.transportEpoch - 1, // older epoch
    workerName: 'platform',
  });

  platform.sendProgress('scanProgress', 'old-scan', backend.transportEpoch - 1);
  platform.sendProgress('analysisProgress', 'old-analysis', backend.transportEpoch - 1);

  assert.equal(scanProgressCalled, false, 'stale scanProgress must be dropped');
  assert.equal(analysisProgressCalled, false, 'stale analysisProgress must be dropped');
}

// 5. Worker mismatch rejected / ignored
{
  backend.pending.set('test-worker-mismatch', {
    resolve: () => { assert.fail('should not resolve across workers'); },
    reject: () => {},
    uiEpoch: backend.gen,
    transportEpoch: backend.transportEpoch,
    workerName: 'legacy',
  });

  // platform worker sends message for request assigned to legacy worker
  platform.reply({ id: 'test-worker-mismatch', epoch: backend.transportEpoch }, { some: 'result' });
  assert.ok(backend.pending.has('test-worker-mismatch'), 'message from wrong worker must be ignored');
  backend.pending.delete('test-worker-mismatch');
}

console.log('issue-5613-backend-transport-epoch-routing: PASS');
