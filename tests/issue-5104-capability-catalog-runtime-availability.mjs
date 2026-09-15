/**
 * #5104 regression: CapabilityCatalog runtime availability must match the
 * executor's real execution contract. Previously availability() only checked
 * whether `context.runtimePlatform` was truthy, so every runtime operation was
 * reported `available` as soon as a platform object existed, even with no
 * active session and even when the current adapter does not implement the
 * required DebugAdapter capability. Discovery then advertised operations that
 * the executor would reject as `No runtime session is available.` or
 * `unsupported`, contradicting the agent-facing capability list.
 */
import assert from 'node:assert/strict';
import { createCapabilityCatalog } from '../js/ai/capabilities/catalog.js';
import { DebugAdapter } from '../js/debug/adapter.js';

const catalog = createCapabilityCatalog();
const runtimeEntries = catalog.list();
const runtimeIds = runtimeEntries.filter((entry) => entry.category === 'runtime').map((entry) => entry.id);
const runtimeBoundIds = runtimeEntries.filter((entry) => entry.runtimeBound).map((entry) => entry.id);

function fakePlatform(state) {
  return {
    get adapters() { return state.adapters; },
    currentSession(required = true) {
      const session = state.session || null;
      if (!session && required) throw new Error('no active runtime session');
      return session;
    },
    adapter(name = null) {
      if (name != null) return state.adapters.get(name) || null;
      if (state.session) return state.session.adapter;
      return state.adapters.get('local') || state.adapters.values().next().value || null;
    },
  };
}

function makeAdapter(capabilities = {}, methods = {}) {
  const adapter = new DebugAdapter({ id: 'issue-5104', capabilities });
  for (const [name, fn] of Object.entries(methods)) adapter[name] = fn;
  return adapter;
}

function runtimeAvailability(context) {
  const map = new Map();
  for (const entry of catalog.list(context)) if (entry.category === 'runtime') map.set(entry.id, entry.available);
  return map;
}

/* 1. no runtime platform: every runtime operation except runtime.status is unavailable */
{
  const map = runtimeAvailability(null);
  for (const id of runtimeIds) {
    if (id === 'runtime.status') {
      assert.equal(map.get(id).ok, true, 'runtime.status must stay readable without a platform');
      continue;
    }
    assert.equal(map.get(id).ok, false, `${id} must be unavailable without a runtime platform`);
  }
}

/* 2. platform present but no active session: runtime-bound operations unavailable */
{
  const platform = fakePlatform({ session: null, adapters: new Map() });
  const map = runtimeAvailability({ runtimePlatform: platform });
  assert.ok(runtimeBoundIds.length >= 10, 'fixture expects the runtime-bound surface to be non-trivial');
  for (const id of runtimeBoundIds) {
    assert.equal(map.get(id).ok, false, `${id} is runtime-bound and must be unavailable without an active session`);
  }
  assert.equal(map.get('runtime.status').ok, true, 'runtime.status must stay readable without a session');
  assert.equal(map.get('runtime.connect').ok, false, 'connect must require a registered adapter, not just a platform');
}

/* 3. active session whose adapter does not advertise the operation capability: unavailable */
{
  const adapter = makeAdapter({}, {});
  const platform = fakePlatform({ session: { id: 's1', backend: 'issue-5104', adapter }, adapters: new Map([['issue-5104', adapter]]) });
  const map = runtimeAvailability({ runtimePlatform: platform });
  assert.equal(map.get('runtime.watchpoint-create').ok, false, 'watchpoint-create requires the watchpointMemory capability');
  assert.equal(map.get('runtime.registers').ok, false, 'registers requires the readRegisters capability');
  assert.equal(map.get('runtime.memory-read').ok, false, 'memory-read requires the readMemory capability');
  assert.equal(map.get('runtime.memory-write').ok, false, 'memory-write requires both readMemory and writeMemory');
  assert.equal(map.get('runtime.continue').ok, false, 'continue requires the resume capability');
  assert.equal(map.get('runtime.breakpoint-create').ok, false, 'breakpoint-create requires some breakpoint capability');
}

/* 4. active session + adapter that supports each operation: available */
{
  const adapter = makeAdapter({
    attach: true, resume: true, pause: true, stepInto: true, stepOver: true, stepOut: true,
    breakpointAddress: true, watchpointMemory: true, removeBreakpoint: true,
    readRegisters: true, readMemory: true, writeMemory: true,
  }, {
    attach: async () => ({}), resume: async () => ({}), pause: async () => ({}),
    stepInto: async () => ({}), stepOver: async () => ({}), stepOut: async () => ({}),
    setBreakpoint: async (spec) => spec, watchMemory: async (spec) => spec, removeBreakpoint: async () => ({}),
    readRegisters: async () => ({}), readMemory: async (_address, size) => new Uint8Array(size || 1), writeMemory: async () => ({}),
  });
  const platform = fakePlatform({ session: { id: 's2', backend: 'issue-5104', adapter }, adapters: new Map([['issue-5104', adapter]]) });
  const map = runtimeAvailability({ runtimePlatform: platform });
  for (const id of runtimeIds) {
    assert.equal(map.get(id).ok, true, `${id} must be available with a session whose adapter supports it`);
  }
  const agentIds = catalog.agent({ runtimePlatform: platform }).map((entry) => entry.id);
  for (const id of runtimeIds) assert.ok(agentIds.includes(id), `${id} must appear in the agent capability list when supported`);
}

/* 5. runtime.connect is available without an active session when an adapter is registered */
{
  const adapter = makeAdapter({ readMemory: true }, { readMemory: async (_a, size) => new Uint8Array(size || 1) });
  const platform = fakePlatform({ session: null, adapters: new Map([['local', adapter]]) });
  const map = runtimeAvailability({ runtimePlatform: platform });
  assert.equal(map.get('runtime.connect').ok, true, 'connect must not demand an active session it is about to create');
  assert.equal(map.get('runtime.registers').ok, false, 'registers still require an active session before connect');
}

/* 6/7. adapter / session switching: the catalog must reflect the new live state */
{
  const weakAdapter = makeAdapter({ readRegisters: true }, { readRegisters: async () => ({}) });
  const strongAdapter = makeAdapter({ readRegisters: true, watchpointMemory: true }, { readRegisters: async () => ({}), watchMemory: async (spec) => spec });
  const state = { session: { id: 's3', backend: 'issue-5104', adapter: weakAdapter }, adapters: new Map([['weak', weakAdapter]]) };
  const platform = fakePlatform(state);
  let map = runtimeAvailability({ runtimePlatform: platform });
  assert.equal(map.get('runtime.registers').ok, true, 'registers supported by the initial adapter');
  assert.equal(map.get('runtime.watchpoint-create').ok, false, 'watchpoint unsupported by the initial adapter');

  state.session = { id: 's4', backend: 'issue-5104', adapter: strongAdapter };
  state.adapters = new Map([['strong', strongAdapter]]);
  map = runtimeAvailability({ runtimePlatform: platform });
  assert.equal(map.get('runtime.watchpoint-create').ok, true, 'watchpoint-create must become available after switching to a capable adapter');

  state.session = null;
  state.adapters = new Map();
  map = runtimeAvailability({ runtimePlatform: platform });
  assert.equal(map.get('runtime.registers').ok, false, 'runtime-bound operations must go unavailable again once the session is closed');
  assert.equal(map.get('runtime.connect').ok, false, 'connect must go unavailable once no adapter is registered');
}

console.log('issue-5104-capability-catalog-runtime-availability: ok');
