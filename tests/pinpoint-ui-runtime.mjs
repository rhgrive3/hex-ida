import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePinpointAnalyzer, makePinpointAccessScanner } from '../js/ui/pinpoint-runtime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const panels = fs.readFileSync(path.resolve(HERE, '../js/panels-base.js'), 'utf8');

// Production wiring must use the cancellable adapters, not recreate the legacy
// async wrappers that stripped AbortSignal/cancel ownership.
assert.match(panels, /makePinpointAnalyzer\(app, region, signal\)/);
assert.match(panels, /makePinpointAccessScanner\(app, region, signal\)/);
assert.match(panels, /makeAnalyzer\(app, region, runController\.signal\)/);
assert.match(panels, /signal: controller\.signal/);

const region = { id: 'text', vmAddr: 0x1000n, size: 0x4000n };
const app = {
  store: { get: (key) => key === 'canDisassemble' },
  symbols: { gen: 1 },
  backend: {},
};

// The pinpoint timeout signal must reach the real function analyzer. Previously
// panels-base's (addr,end) adapter silently dropped the third options argument.
{
  const parent = new AbortController();
  const local = new AbortController();
  let seenSignal = null;
  let release;
  const analyze = (_backend, _region, _start, _end, _symbols, _progress, options) => {
    seenSignal = options.signal;
    return new Promise((resolve) => { release = () => resolve({ model: { ok: true } }); });
  };
  const wrapped = makePinpointAnalyzer(app, region, parent.signal, analyze);
  const pending = wrapped(0x1000n, 0x1100n, { signal: local.signal });
  await Promise.resolve();
  assert.ok(seenSignal, 'combined signal must reach analyzeFunctionCached');
  parent.abort('sheet-closed');
  assert.equal(seenSignal.aborted, true);
  assert.equal(seenSignal.reason, 'sheet-closed');
  release();
  const model = await pending;
  assert.equal(model.ok, true);
}

// Closing the sheet before a function analysis starts must reject without
// starting backend analysis at all.
{
  const parent = new AbortController();
  parent.abort('sheet-closed');
  let calls = 0;
  const wrapped = makePinpointAnalyzer(app, region, parent.signal, async () => {
    calls++;
    return { model: {} };
  });
  await assert.rejects(() => wrapped(0x1000n, 0x1100n), (error) =>
    error?.name === 'AbortError' && error?.code === 'ABORT_ERR');
  assert.equal(calls, 0);
}

// fieldAccessMany exposes a custom cancel method. An async adapter used to
// assimilate that promise and strip the method, leaving the worker alive after
// the 45s pinpoint timeout. The adapter must return the exact cancellable request.
{
  const parent = new AbortController();
  let cancelled = 0;
  let requested = null;
  let resolveRequest;
  const request = new Promise((resolve) => { resolveRequest = resolve; });
  request.cancel = () => { cancelled++; resolveRequest(new Map()); };
  request.requestId = 77;
  app.backend.fieldAccessMany = (regionId, offsets) => {
    requested = { regionId, offsets };
    return request;
  };
  const scan = makePinpointAccessScanner(app, region, parent.signal);
  const returned = scan([{ offset: 0x20n, size: 4 }]);
  assert.equal(returned, request, 'cancellable promise identity must be preserved');
  assert.equal(returned.requestId, 77);
  assert.deepEqual(requested, { regionId: 'text', offsets: [{ offset: 0x20n, size: 4 }] });
  parent.abort('sheet-closed');
  await returned;
  assert.equal(cancelled, 1, 'sheet close must cancel the owned worker request');
}

// The pinpoint-local timeout signal must cancel the worker even without a sheet
// parent signal. This pins the exact path used by batchedScanAccess().
{
  const local = new AbortController();
  let cancelled = 0;
  let resolveRequest;
  const request = new Promise((resolve) => { resolveRequest = resolve; });
  request.cancel = () => { cancelled++; resolveRequest(new Map()); };
  app.backend.fieldAccessMany = () => request;
  const scan = makePinpointAccessScanner(app, region);
  const returned = scan([{ offset: 0x30n, size: 8 }], { signal: local.signal });
  local.abort('pinpoint-access-timeout');
  await returned;
  assert.equal(cancelled, 1, 'pinpoint timeout must reach fieldAccessMany.cancel');
}

// Sheet close and the local pinpoint timeout can race on iOS. Both signals own
// the same request, but physical worker cancellation must remain idempotent.
{
  const parent = new AbortController();
  const local = new AbortController();
  let cancelled = 0;
  let resolveRequest;
  const request = new Promise((resolve) => { resolveRequest = resolve; });
  request.cancel = () => { cancelled++; resolveRequest(new Map()); };
  app.backend.fieldAccessMany = () => request;
  const scan = makePinpointAccessScanner(app, region, parent.signal);
  const returned = scan([{ offset: 0x40n, size: 4 }], { signal: local.signal });
  parent.abort('sheet-closed');
  local.abort('pinpoint-access-timeout');
  await returned;
  assert.equal(cancelled, 1, 'racing cancellation sources must cancel the worker once');
}

console.log('pinpoint-ui-runtime: PASS');
