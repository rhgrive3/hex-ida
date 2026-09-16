import assert from 'node:assert/strict';
import test from 'node:test';

import { DebugAdapter } from '../../../js/debug/adapter.js';
import { DebuggerProvider } from '../../../js/runtime/debugger-provider.js';
import { InstrumentationProvider } from '../../../js/runtime/instrumentation-provider.js';

const binaryId = 'bin_sha256_' + '9a'.repeat(32);
const req = { binaryId, targetIdentity: { kind: 'audit' } };

class SharedAdapter extends DebugAdapter {
  constructor() {
    super({ id: 'shared-audit', kind: 'lldb', capabilities: { modules: true, breakpoints: true } });
    this.breakpoints = new Map();
    this.disconnectGate = null;
  }
  async connect() {}
  async disconnect() {
    if (this.disconnectGate) await this.disconnectGate;
  }
  async getModules() { return []; }
  async setBreakpoint(bp) { this.breakpoints.set(bp.id, bp); return true; }
  async removeBreakpoint(id) { return this.breakpoints.delete(id); }
  async listBreakpoints() { return [...this.breakpoints.values()]; }
}

test('#8891 a fully closed stale debugger facet cannot mutate a successor session on the shared adapter', async () => {
  const adapter = new SharedAdapter();
  const provider = new DebuggerProvider(adapter, { id: 'audit-debugger' });
  const s1 = await provider.openSession({ ...req, sessionNonce: 's1' });
  await s1.close();
  assert.equal(s1.closed, true);
  assert.equal(s1.state, 'closed');

  const s2 = await provider.openSession({ ...req, sessionNonce: 's2' });
  await s2.facets.debugger.setBreakpoint({ id: 'owned-by-s2', kind: 'address', address: 0x2000n, enabled: true });
  assert.deepEqual((await s2.facets.debugger.listBreakpoints()).map((x) => x.id), ['owned-by-s2']);

  await assert.rejects(
    s1.facets.debugger.removeBreakpoint('owned-by-s2'),
    (error) => error.code === 'runtime-session-closed',
    'the closed stale facet must fail closed before touching the shared adapter',
  );
  assert.equal(adapter.breakpoints.has('owned-by-s2'), true, 'successor session state is intact');
  await s2.close();
});

test('#8891 a closed stale session cannot create adapter state a successor will observe', async () => {
  const adapter = new SharedAdapter();
  const provider = new DebuggerProvider(adapter, { id: 'audit-debugger-2' });
  const s1 = await provider.openSession({ ...req, sessionNonce: 's1' });
  await s1.close();
  const s2 = await provider.openSession({ ...req, sessionNonce: 's2' });
  await assert.rejects(
    s1.facets.debugger.setBreakpoint({ id: 'ghost', kind: 'address', address: 0x3000n, enabled: true }),
    (error) => error.code === 'runtime-session-closed',
  );
  assert.equal(adapter.breakpoints.has('ghost'), false);
  await s2.close();
});

test('#8891 admission is revoked at the start of close(), before async teardown completes', async () => {
  const adapter = new SharedAdapter();
  let release;
  adapter.disconnectGate = new Promise((resolve) => { release = resolve; });
  const provider = new DebuggerProvider(adapter, { id: 'audit-debugger-fence' });
  const s = await provider.openSession({ ...req, sessionNonce: 's1' });

  const closing = s.close();
  // Yield so close() has entered `closing` and run cancelAll() but is blocked on disconnect().
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.closed, false, 'still tearing down');

  await assert.rejects(
    s.facets.debugger.setBreakpoint({ id: 'late-during-close', kind: 'address', address: 0x3333n, enabled: true }),
    (error) => error.code === 'runtime-session-closed',
    'no new mutation may be admitted once close() has begun',
  );
  assert.equal(adapter.breakpoints.has('late-during-close'), false, 'adapter state unchanged during teardown');

  release();
  await closing;
  assert.equal(s.closed, true);
});

test('#8891 a closed instrumentation session cannot admit module-load or mint exact address authority', async () => {
  const backend = { id: 'audit-backend', version: '1', async connect() {}, async disconnect() {} };
  const provider = new InstrumentationProvider(backend, { id: 'audit-instrumentation' });
  const s = await provider.openSession({ ...req, sessionNonce: 's1' }, { connect: false });
  await s.close();

  assert.throws(
    () => s.facets.instrumentation.events.ingest({
      kind: 'module-load', sequence: 1,
      payload: { bindingKey: 'late', runtimeBase: '0x1000', runtimeSize: '0x100', staticBase: '0x4000', binaryId, identityState: 'exact', identityEvidenceIds: ['ev-late'] },
    }),
    (error) => error.code === 'runtime-session-closed',
    'post-close ingress must fail closed',
  );
  assert.equal(s.modules.active().length, 0, 'no module authority is created after close');
  assert.equal(s.facets.instrumentation.resolveAddress(0x1010n, { binaryId }).state, 'unresolved');
});

test('#8891 legitimate pre-close operations and idempotent close are preserved', async () => {
  const adapter = new SharedAdapter();
  const provider = new DebuggerProvider(adapter, { id: 'audit-debugger-happy' });
  const s = await provider.openSession({ ...req, sessionNonce: 's1' });
  await s.facets.debugger.setBreakpoint({ id: 'ok', kind: 'address', address: 0x1000n, enabled: true });
  assert.deepEqual((await s.facets.debugger.listBreakpoints()).map((x) => x.id), ['ok']);
  // A live session still mints controllers/epochs normally.
  const controller = s.controller();
  assert.equal(controller.signal.aborted, false);
  s.releaseController(controller);
  const epochBefore = s.epoch;
  assert.equal(s.newEpoch('test'), epochBefore + 1);
  // close() is idempotent / single-flight.
  await Promise.all([s.close(), s.close()]);
  assert.equal(s.closed, true);
  assert.throws(() => s.controller(), (error) => error.code === 'runtime-session-closed');
});
