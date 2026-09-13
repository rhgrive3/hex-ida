// Regression for #5677 + #5675 (initial module import must match the refresh
// path):
// #5677 — openSession() built binding keys as id ?? uuid ?? name only, so an
// explicit bindingKey/moduleKey was re-keyed to `module:<i>` and the identical
// snapshot re-loaded under its real key at the first refreshModules().
// #5675 — openSession() accepted only base/size extents, while the canonical
// normalizer and the refresh path also accept runtimeBase/runtimeSize; adapters
// returning only the runtime* form produced an empty module table until the
// first refresh. The initial import now mirrors DebuggerProvider's
// moduleBindingKey() authority order and runtime* extent acceptance.
import assert from 'node:assert/strict';
import { DebuggerProvider } from '../../../js/runtime/debugger-provider.js';

function stubAdapter(getModules) {
  return {
    id: 'stub', kind: 'stub', connected: false,
    capabilities: { modules: true },
    async connect() { this.connected = true; },
    async disconnect() { this.connected = false; },
    getModules,
  };
}

// #5677: explicit bindingKey survives open and is stable across refresh
{
  const modules = [{ bindingKey: 'main-runtime-module', base: 0x1000n, size: 0x100n }];
  const session = await new DebuggerProvider(stubAdapter(async () => modules))
    .openSession({ binaryId: 'bin:test', sessionNonce: 'issue-5677' });
  assert.deepEqual(session.modules.active().map((m) => m.bindingKey), ['main-runtime-module'],
    'explicit bindingKey must be the initial import identity');
  await session.facets.debugger.refreshModules();
  assert.deepEqual(session.modules.active().map((m) => m.bindingKey), ['main-runtime-module'],
    'an identical snapshot must not re-key modules at refresh');

  // moduleKey has the same authority; id/uuid/name keep working
  for (const keyField of ['moduleKey', 'id', 'uuid', 'name']) {
    const variant = [{ [keyField]: 'auth-5677', base: 0x1000n, size: 0x100n }];
    const s = await new DebuggerProvider(stubAdapter(async () => variant))
      .openSession({ binaryId: 'bin:test', sessionNonce: `issue-5677-${keyField}` });
    assert.deepEqual(s.modules.active().map((m) => m.bindingKey), ['auth-5677'],
      `${keyField} must remain a binding-key authority`);
  }
}

// #5675: runtimeBase/runtimeSize-only adapters register at open, not refresh
{
  const modules = [{ bindingKey: 'm2', runtimeBase: 0x2000n, runtimeSize: 0x100n }];
  const session = await new DebuggerProvider(stubAdapter(async () => modules))
    .openSession({ binaryId: 'bin:test2', sessionNonce: 'issue-5675' });
  assert.deepEqual(session.modules.active().map((m) => m.bindingKey), ['m2'],
    'runtime* extents must be accepted at the initial import');
  await session.facets.debugger.refreshModules();
  assert.deepEqual(session.modules.active().map((m) => m.bindingKey), ['m2'],
    'refresh must be a no-op for the same snapshot');
}

console.log('issues #5677/#5675 initial module import parity regression: PASS');
