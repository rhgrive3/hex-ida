import assert from 'node:assert/strict';
import { createCapabilityCatalog } from '../js/ai/capabilities/catalog.js';
import { RuntimeAnalysisPlatform } from '../js/runtime/index.js';

function available(catalog, id, context) {
  const entry = catalog.list(context).find((item) => item.id === id);
  assert.ok(entry, `catalog must contain ${id}`);
  return entry.available;
}

// No session: runtime-bound operations must not report available.
{
  const platform = new RuntimeAnalysisPlatform({ symbolic: false });
  const catalog = createCapabilityCatalog();
  const context = { runtimePlatform: platform };
  assert.deepEqual(available(catalog, 'runtime.memory-read', context), { ok: false, reason: 'no-runtime-session' });
  assert.deepEqual(available(catalog, 'runtime.registers', context), { ok: false, reason: 'no-runtime-session' });
  assert.deepEqual(available(catalog, 'runtime.memory-write', context), { ok: false, reason: 'no-runtime-session' });
  assert.deepEqual(available(catalog, 'runtime.watchpoint-create', context), { ok: false, reason: 'no-runtime-session' });
  assert.deepEqual(available(catalog, 'runtime.step-in', context), { ok: false, reason: 'no-runtime-session' });
  // The status read itself stays available; connect reports no adapter to use.
  assert.deepEqual(available(catalog, 'runtime.status', context), { ok: true });
  assert.equal(available(catalog, 'runtime.connect', context).ok, false);
}

// Session with a limited adapter: unsupported operations stay unavailable,
// supported ones stay available.
{
  const platform = new RuntimeAnalysisPlatform({ symbolic: false });
  platform.registerAdapter('limited', {
    id: 'limited',
    kind: 'limited',
    capabilities: { readMemory: true, readRegisters: true },
  });
  await platform.startSession({ adapter: 'limited', connect: false });
  const catalog = createCapabilityCatalog();
  const context = { runtimePlatform: platform };
  assert.deepEqual(available(catalog, 'runtime.memory-read', context), { ok: true });
  assert.deepEqual(available(catalog, 'runtime.registers', context), { ok: true });
  assert.equal(available(catalog, 'runtime.watchpoint-create', context).ok, false, 'watchpointMemory is not supported');
  assert.equal(available(catalog, 'runtime.memory-write', context).ok, false, 'writeMemory is not supported');
  assert.equal(available(catalog, 'runtime.step-in', context).ok, false, 'stepInto is not supported');
  assert.equal(available(catalog, 'runtime.connect', context).ok, true, 'an adapter is registered');
}

// Session with a full adapter: bound operations are available.
{
  const platform = new RuntimeAnalysisPlatform({ symbolic: false });
  platform.registerAdapter('full', {
    id: 'full',
    kind: 'full',
    capabilities: {
      attach: true, pause: true, resume: true, stepInto: true, stepOver: true, stepOut: true,
      breakpointAddress: true, removeBreakpoint: true, watchpointMemory: true,
      readRegisters: true, readMemory: true, writeMemory: true,
    },
  });
  await platform.startSession({ adapter: 'full', connect: false });
  const catalog = createCapabilityCatalog();
  const context = { runtimePlatform: platform };
  for (const id of ['runtime.watchpoint-create', 'runtime.memory-write', 'runtime.registers', 'runtime.step-in', 'runtime.pause', 'runtime.attach', 'runtime.breakpoint-create']) {
    assert.deepEqual(available(catalog, id, context), { ok: true }, `${id} must be available`);
  }
}

// No platform at all: unchanged legacy reason.
{
  const catalog = createCapabilityCatalog();
  assert.deepEqual(available(catalog, 'runtime.memory-read', {}), { ok: false, reason: 'runtime-adapter-unavailable' });
}

console.log('issue-5104-runtime-availability: ok');
