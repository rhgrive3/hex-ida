// Regression for #5696 + #5694: DebuggerProvider writeRegister/writeMemory and
// InstrumentationProvider installProbe/removeProbe/intercept/replace/
// writeMemory never created a session controller and never checked the epoch,
// so a mutation started before newProviderEpoch() committed its stale result
// into the InterventionLedger (and returned success) after the epoch changed.
// Mutations now register a session controller (cancelled by newEpoch) and
// fail closed with runtime-session-stale when the epoch moved mid-flight,
// matching the #5878 emulator-run contract.
import assert from 'node:assert/strict';
import { DebuggerProvider } from '../../../js/runtime/debugger-provider.js';
import { InstrumentationProvider } from '../../../js/runtime/instrumentation-provider.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// #5696: DebuggerProvider writeRegister/writeMemory
{
  const calls = {};
  const adapter = {
    id: 'stub', kind: 'stub', connected: false,
    capabilities: { modules: true, writeRegisters: true, writeMemory: true },
    async connect() { this.connected = true; },
    async disconnect() { this.connected = false; },
    async getModules() { return []; },
    async writeRegister() { calls.reg = deferred(); return calls.reg.promise; },
    async writeMemory() { calls.mem = deferred(); return calls.mem.promise; },
  };
  const session = await new DebuggerProvider(adapter).openSession({ binaryId: 'bin-1', sessionNonce: 'issue-5696' });
  const dbg = session.facets.debugger;

  for (const [label, pending, resolvers] of [
    ['writeRegister', dbg.writeRegister('x0', 1n), () => calls.reg],
    ['writeMemory', dbg.writeMemory(0x1000n, new Uint8Array([1])), () => calls.mem],
  ]) {
    const startedAt = session.epoch;
    const epochPromise = (async () => { session.newProviderEpoch(); })();
    const settle = pending.catch((e) => e);
    await epochPromise;
    assert.equal(session.epoch, startedAt + 1, `${label}: epoch advanced`);
    resolvers().resolve({ ok: true });
    const outcome = await settle;
    assert.equal(outcome?.code, 'runtime-session-stale', `${label}: stale completion must fail closed`);
    assert.equal(dbg.interventions.all().length, 0, `${label}: stale result must not reach the ledger`);
  }

  // a normal in-epoch mutation still succeeds and records
  {
    const p = dbg.writeRegister('x1', 2n);
    await new Promise((r) => setTimeout(r, 5));
    calls.reg.resolve({ ok: true });
    const ok = await p;
    assert.deepEqual(ok.result, { ok: true });
  }
  assert.equal(dbg.interventions.all().length, 1, 'in-epoch intervention is recorded');
}

// #5694: InstrumentationProvider mutation ops
{
  const calls = {};
  const backend = {
    id: 'test',
    async connect() {},
    async disconnect() {},
    async writeMemory() { calls.mem = deferred(); return calls.mem.promise; },
    async installProbe() { calls.probe = deferred(); return calls.probe.promise; },
    async removeProbe() { calls.remove = deferred(); return calls.remove.promise; },
    async intercept() { calls.intercept = deferred(); return calls.intercept.promise; },
    async replace() { calls.replace = deferred(); return calls.replace.promise; },
  };
  const provider = new InstrumentationProvider(backend, { allowMemoryWrite: true, allowReplacement: true });
  const session = await provider.openSession({ binaryId: 'bin-1', sessionNonce: 'issue-5694' });
  const inst = session.facets.instrumentation;
  const cases = [
    ['writeMemory', () => inst.writeMemory(0x1000n, new Uint8Array([0x41])), () => calls.mem],
    ['installProbe', () => inst.installProbe({ address: 0x1000n }), () => calls.probe],
    ['intercept', () => inst.intercept({ address: 0x1000n }), () => calls.intercept],
    ['replace', () => inst.replace(0x1000n, {}), () => calls.replace],
  ];
  for (const [label, start, resolvers] of cases) {
    const startedAt = session.epoch;
    const pending = start();
    const settle = pending.catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    session.newProviderEpoch();
    assert.equal(session.epoch, startedAt + 1, `${label}: epoch advanced`);
    resolvers().resolve({ written: 1 });
    const outcome = await settle;
    assert.equal(outcome?.code, 'runtime-session-stale', `${label}: stale completion must fail closed`);
    assert.equal(inst.interventions.all().length, 0, `${label}: stale result must not reach the ledger`);
  }
  // normal in-epoch write still works
  {
    const p = inst.writeMemory(0x2000n, new Uint8Array([7]));
    await new Promise((r) => setTimeout(r, 5));
    calls.mem.resolve({ written: 1 });
    const ok = await p;
    assert.deepEqual(ok.result, { written: 1 });
  }
  // #5694: read-only readMemory participates in the same session lifecycle —
  // a read pending across newProviderEpoch() must fail closed, not deliver
  // stale target bytes into the current epoch.
  {
    const calls = {};
    const backend = {
      id: 'test',
      async connect() {},
      async disconnect() {},
      async readMemory() { calls.read = deferred(); return calls.read.promise; },
    };
    const provider = new InstrumentationProvider(backend, { allowMemoryWrite: true });
    const session = await provider.openSession({ binaryId: 'bin-1', sessionNonce: 'issue-5694-read' });
    const inst = session.facets.instrumentation;
    const startedAt = session.epoch;
    const pending = inst.readMemory(0x1000n, 4).catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    session.newProviderEpoch();
    calls.read.resolve(new Uint8Array([1, 2, 3, 4]));
    const outcome = await pending;
    assert.equal(outcome?.code, 'runtime-session-stale', 'stale readMemory completion must fail closed');
    // in-epoch read still works
    const p = inst.readMemory(0x2000n, 1);
    await new Promise((r) => setTimeout(r, 5));
    calls.read.resolve(new Uint8Array([9]));
    assert.deepEqual([...await p], [9], 'in-epoch readMemory still delivers bytes');
  }
}

console.log('issues #5696/#5694 stale-epoch mutation fail-closed regression: PASS');
