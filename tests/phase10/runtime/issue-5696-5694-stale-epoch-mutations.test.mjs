// Regression for #5696 + #5694: provider-owned mutation operations must
// propagate a session-owned AbortSignal and still fail closed at completion
// when a backend ignores cancellation.
import assert from 'node:assert/strict';
import { DebuggerProvider } from '../../../js/runtime/debugger-provider.js';
import { InstrumentationProvider } from '../../../js/runtime/instrumentation-provider.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject, signal: null };
}

// #5696: DebuggerProvider writeRegister/writeMemory propagate the session
// signal to adapters, abort it on epoch transition, and reject a late resolve.
{
  const calls = {};
  const adapter = {
    id: 'stub', kind: 'stub', connected: false,
    capabilities: { modules: true, writeRegisters: true, writeMemory: true },
    async connect() { this.connected = true; },
    async disconnect() { this.connected = false; },
    async getModules() { return []; },
    async writeRegister(_name, _value, _threadId, options = {}) {
      calls.reg = deferred();
      calls.reg.signal = options.signal;
      return calls.reg.promise;
    },
    async writeMemory(_address, _bytes, options = {}) {
      calls.mem = deferred();
      calls.mem.signal = options.signal;
      return calls.mem.promise;
    },
  };
  const session = await new DebuggerProvider(adapter).openSession({ binaryId: 'bin-1', sessionNonce: 'issue-5696' });
  const dbg = session.facets.debugger;

  const cases = [
    ['writeRegister', () => dbg.writeRegister('x0', 1n), () => calls.reg],
    ['writeMemory', () => dbg.writeMemory(0x1000n, new Uint8Array([1])), () => calls.mem],
  ];
  for (const [label, start, current] of cases) {
    const startedAt = session.epoch;
    const pending = start();
    assert.ok(current().signal, `${label}: adapter receives a session-owned signal`);
    assert.equal(current().signal.aborted, false, `${label}: signal begins live`);
    session.newProviderEpoch();
    assert.equal(session.epoch, startedAt + 1, `${label}: epoch advanced`);
    assert.equal(current().signal.aborted, true, `${label}: epoch transition aborts backend signal`);
    current().resolve({ ok: true }); // backend intentionally ignores cancellation
    const outcome = await pending.catch((e) => e);
    assert.equal(outcome?.code, 'runtime-session-stale', `${label}: late completion must fail closed`);
    assert.equal(dbg.interventions.all().length, 0, `${label}: stale result must not reach the ledger`);
  }

  // Caller cancellation is composed into, rather than replacing, the
  // session-owned signal. Even an abort-ignoring adapter cannot commit later.
  {
    const caller = new AbortController();
    const pending = dbg.writeMemory(0x2000n, new Uint8Array([2]), { signal: caller.signal });
    const backendCall = calls.mem;
    assert.ok(backendCall.signal && backendCall.signal !== caller.signal, 'provider owns the backend-facing signal');
    caller.abort('caller-cancel');
    assert.equal(backendCall.signal.aborted, true, 'caller abort forwards into session-owned signal');
    backendCall.resolve({ ok: true });
    const outcome = await pending.catch((e) => e);
    assert.equal(outcome?.code, 'runtime-session-stale', 'late completion after caller abort fails closed');
    assert.equal(dbg.interventions.all().length, 0);
  }

  // Normal in-epoch mutation still succeeds and records.
  {
    const pending = dbg.writeRegister('x1', 2n);
    calls.reg.resolve({ ok: true });
    const ok = await pending;
    assert.deepEqual(ok.result, { ok: true });
    assert.equal(dbg.interventions.all().length, 1);
  }
}

// #5694: all instrumentation mutation backends receive the composed signal;
// epoch changes abort it, while completion-time checks protect against an
// abort-ignoring backend.
{
  const calls = {};
  const capture = (name, options) => {
    const d = deferred();
    d.signal = options?.signal;
    calls[name] = d;
    return d.promise;
  };
  const backend = {
    id: 'test',
    async connect() {},
    async disconnect() {},
    writeMemory(_address, _bytes, options) { return capture('mem', options); },
    installProbe(_spec, options) { return capture('probe', options); },
    removeProbe(_handle, options) { return capture('remove', options); },
    intercept(_spec, options) { return capture('intercept', options); },
    replace(_target, _replacement, options) { return capture('replace', options); },
    readMemory(_address, _size, options) { return capture('read', options); },
  };
  const provider = new InstrumentationProvider(backend, { allowMemoryWrite: true, allowReplacement: true });
  const session = await provider.openSession({ binaryId: 'bin-1', sessionNonce: 'issue-5694' });
  const inst = session.facets.instrumentation;
  const cases = [
    ['writeMemory', 'mem', () => inst.writeMemory(0x1000n, new Uint8Array([0x41]))],
    ['installProbe', 'probe', () => inst.installProbe({ address: 0x1000n })],
    ['removeProbe', 'remove', () => inst.removeProbe('probe-handle')],
    ['intercept', 'intercept', () => inst.intercept({ address: 0x1000n })],
    ['replace', 'replace', () => inst.replace(0x1000n, {})],
  ];
  for (const [label, key, start] of cases) {
    const startedAt = session.epoch;
    const pending = start();
    await Promise.resolve();
    assert.ok(calls[key].signal, `${label}: backend receives session-owned signal`);
    assert.equal(calls[key].signal.aborted, false);
    session.newProviderEpoch();
    assert.equal(session.epoch, startedAt + 1, `${label}: epoch advanced`);
    assert.equal(calls[key].signal.aborted, true, `${label}: epoch switch aborts backend signal`);
    calls[key].resolve(label === 'installProbe' || label === 'intercept' ? { handle: `${label}-handle` } : { written: 1 });
    const outcome = await pending.catch((e) => e);
    assert.equal(outcome?.code, 'runtime-session-stale', `${label}: stale completion must fail closed`);
    assert.equal(inst.interventions.all().length, 0, `${label}: stale result must not reach intervention state`);
  }

  // Read-side lifecycle uses the same session-owned cancellation contract.
  {
    const pending = inst.readMemory(0x1000n, 4);
    const backendCall = calls.read;
    session.newProviderEpoch();
    assert.equal(backendCall.signal.aborted, true, 'stale read signal is aborted');
    backendCall.resolve(new Uint8Array([1, 2, 3, 4]));
    const outcome = await pending.catch((e) => e);
    assert.equal(outcome?.code, 'runtime-session-stale');
  }

  // Caller signal also composes for instrumentation operations.
  {
    const caller = new AbortController();
    const pending = inst.writeMemory(0x2000n, new Uint8Array([7]), { signal: caller.signal });
    await Promise.resolve();
    const backendCall = calls.mem;
    assert.ok(backendCall.signal && backendCall.signal !== caller.signal);
    caller.abort('caller-cancel');
    assert.equal(backendCall.signal.aborted, true);
    backendCall.resolve({ written: 1 });
    const outcome = await pending.catch((e) => e);
    assert.equal(outcome?.code, 'runtime-session-stale');
    assert.equal(inst.interventions.all().length, 0);
  }

  // Normal in-epoch write still succeeds and records.
  {
    const pending = inst.writeMemory(0x3000n, new Uint8Array([9]));
    await Promise.resolve();
    calls.mem.resolve({ written: 1 });
    const ok = await pending;
    assert.deepEqual(ok.result, { written: 1 });
    assert.equal(inst.interventions.all().length, 1);
  }
}

console.log('issues #5696/#5694 session-owned mutation cancellation regression: PASS');
