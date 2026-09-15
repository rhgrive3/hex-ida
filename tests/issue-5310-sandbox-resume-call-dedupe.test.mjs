import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../js/adapters/index.js';

const io = {
  fetch: async () => ({ mn: 'ret', ops: '' }),
  read: async () => null,
  isExecutable: () => true,
  symbolFor: () => null,
};

function fakeResult(trace, { steps = trace.length, traceMeta = {} } = {}) {
  return {
    trace,
    traceMeta,
    steps,
    takenBranches: [],
    touchedFields: [],
    before: [],
    after: [],
    modifiedObjectRanges: [],
    returnValue: 0n,
    stopped: null,
  };
}

// 1. BL in resume: raw trace has both instruction event and typed call event
{
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.connect();
  await adapter.launch({ address: 0x1000n, objectAsArg0: false });

  const rawTrace = [
    { addr: 0x1000n, text: 'bl #0x2000' },
    { type: 'call', addr: 0x1000n, address: 0x1000n, target: 0x2000n, indirect: false, text: 'bl #0x2000' },
  ];

  const result = adapter._normalizeResult(fakeResult(rawTrace));
  assert.equal(result.calls.length, 1, 'BL 1回につき call event は 1 件であるべき');
  assert.equal(result.calls[0].address, 0x1000n);
  assert.equal(result.calls[0].target, 0x2000n);

  const snapshot = adapter.traceBuffer.snapshot();
  const callEvents = snapshot.events.filter((e) => e.type === 'call');
  assert.equal(callEvents.length, 1, 'traceBuffer 内の call event も 1 件であるべき');

  await adapter.disconnect();
}

// 2. BLR in resume: raw trace has both instruction event and typed call event
{
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.connect();
  await adapter.launch({ address: 0x1000n, objectAsArg0: false });

  const rawTrace = [
    { addr: 0x1004n, text: 'blr x0' },
    { type: 'call', addr: 0x1004n, address: 0x1004n, target: 0x3000n, indirect: true, text: 'blr x0' },
  ];

  const result = adapter._normalizeResult(fakeResult(rawTrace));
  assert.equal(result.calls.length, 1, 'BLR 1回につき call event は 1 件であるべき');
  assert.equal(result.calls[0].address, 0x1004n);
  assert.equal(result.calls[0].indirect, true);

  const snapshot = adapter.traceBuffer.snapshot();
  const callEvents = snapshot.events.filter((e) => e.type === 'call');
  assert.equal(callEvents.length, 1, 'traceBuffer 内の BLR call event も 1 件であるべき');

  await adapter.disconnect();
}

// 3. Typed call only: 1 call
{
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.connect();
  await adapter.launch({ address: 0x1000n, objectAsArg0: false });

  const rawTrace = [
    { type: 'call', addr: 0x1000n, address: 0x1000n, target: 0x2000n, indirect: false, text: 'bl #0x2000' },
  ];

  const result = adapter._normalizeResult(fakeResult(rawTrace));
  assert.equal(result.calls.length, 1, 'typed call のみは 1 件');
  await adapter.disconnect();
}

// 4. Untyped text only (legacy): fallback 1 call
{
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.connect();
  await adapter.launch({ address: 0x1000n, objectAsArg0: false });

  const rawTrace = [
    { addr: 0x1000n, text: 'bl #0x2000' },
  ];

  const result = adapter._normalizeResult(fakeResult(rawTrace));
  assert.equal(result.calls.length, 1, 'untyped text のみは fallback で 1 件');
  assert.equal(result.calls[0].target, 0x2000n);
  await adapter.disconnect();
}

// 5. Different sites typed and untyped: not mistakenly deduplicated
{
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.connect();
  await adapter.launch({ address: 0x1000n, objectAsArg0: false });

  const rawTrace = [
    { addr: 0x1000n, text: 'bl #0x2000' },
    { type: 'call', addr: 0x1000n, address: 0x1000n, target: 0x2000n, indirect: false, text: 'bl #0x2000' },
    { addr: 0x1020n, text: 'bl #0x4000' }, // untyped at 0x1020
  ];

  const result = adapter._normalizeResult(fakeResult(rawTrace));
  assert.equal(result.calls.length, 2, '異なる site の typed/untyped は両方保持されるべき (2件)');
  assert.equal(result.calls[0].address, 0x1000n);
  assert.equal(result.calls[1].address, 0x1020n);
  await adapter.disconnect();
}

console.log('issue-5310-sandbox-resume-call-dedupe: PASS');
