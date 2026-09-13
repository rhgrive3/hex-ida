// Regression for #5268: HypothesisVerifier passes { signal } to
// adapter.launch(), but LocalFunctionSandboxAdapter.launch(spec) dropped the
// second argument entirely, so a caller could not cancel during the launch
// phase (sandbox setup, initial heap/global stores). The adapter now accepts
// the AbortSignal-compatible options object: an already-aborted signal fails
// fast before any setup, and aborts mid-setup fail closed at the next
// checkpoint with code 'cancelled' (mapped by HypothesisVerifier to a
// cancelled observation) without installing the sandbox.
import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../../../js/adapters/index.js';
import { HypothesisVerifier, compileExperiment } from '../../../js/dynamic/experiments.js';

const CODE = new Map([['0x1000', { mn: 'mov', ops: 'x0, #1' }]]);
const io = { fetch: async (addr) => CODE.get(String(addr)) || null };
const spec = { address: 0x1000n, heap: [{ address: 0x600000001000n, size: 8, value: 5n }] };

// an already-aborted signal fails fast and installs nothing
{
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.connect();
  const ac = new AbortController();
  ac.abort('user-cancel');
  await assert.rejects(() => adapter.launch({ ...spec }, { signal: ac.signal }),
    (e) => e.code === 'cancelled', 'pre-aborted launch must fail fast');
  assert.throws(() => adapter.ensureSandbox(), 'a cancelled launch must not install a sandbox');
}

// abort during the setup phase fails closed at the next checkpoint
{
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.connect();
  const ac = new AbortController();
  const pending = adapter.launch({ ...spec }, { signal: ac.signal });
  ac.abort('user-cancel');
  await assert.rejects(() => pending, (e) => e.code === 'cancelled');
  assert.throws(() => adapter.ensureSandbox(), 'mid-setup cancel must not install a sandbox');
}

// HypothesisVerifier + local adapter: a mid-run cancel is observed as cancelled
{
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.connect();
  const verifier = new HypothesisVerifier(adapter);
  const experiment = compileExperiment({
    id: 'exp-5268', functionAddress: 0x1000n, fieldOffset: 0x20n, fieldSize: 8,
    initial: 100n, argumentIndex: 1, argumentKind: 'pointer', operator: 'add', operand: 0n,
    binaryHash: 'hash-5268',
  }, { binaryHash: 'hash-5268', inputs: [{ kind: 'scalar', id: 'one', value: 1n }] });
  const ac = new AbortController();
  const pending = verifier.verify(experiment, { signal: ac.signal, maxCases: 1 });
  ac.abort('user-cancel');
  const outcome = await pending;
  assert.equal(outcome.coverage.cancelled, true, 'verify reports the caller cancel');
}

// abort DURING slow setup stops the remaining setup work (in-setup
// checkpoints), rather than running setup to completion and rejecting after
{
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.connect();
  const ac = new AbortController();
  let storeCalls = 0;
  const rawStore = adapter.emulator?.store?.bind(adapter) || null;
  // A pre-launch adapter has no emulator yet; the sandbox emulator is created
  // inside launch, so gate on the sandbox objectMemory stores via a slow
  // first store through the io-independent emulator wrapper: wrap after the
  // sandbox exists by intercepting at the FunctionSandbox level instead.
  const { FunctionSandbox } = await import('../../../js/symbolic/function-sandbox.js');
  const sandbox = new FunctionSandbox(io);
  const slow = { resolve: null, promise: null };
  const rawSandboxStore = sandbox.emulator.store.bind(sandbox.emulator);
  sandbox.emulator.store = async (addr, size, value) => {
    storeCalls++;
    if (storeCalls === 1) {
      slow.promise = new Promise((resolve) => { slow.resolve = resolve; });
      await slow.promise;
    }
    return rawSandboxStore(addr, size, value);
  };
  const setupPending = sandbox.setup(0x1000n, {
    objectMemory: [1, 2, 3, 4, 5].map((n) => ({ offset: n * 0x10, size: 4, value: n })),
    signal: ac.signal,
  }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 5));
  ac.abort('user-cancel');
  slow.resolve();
  const outcome = await setupPending;
  assert.equal(outcome?.code, 'sandbox-setup-cancelled', 'setup must reject at the next in-setup checkpoint');
  assert.ok(storeCalls <= 2, `the remaining setup work must not run after the abort (stores=${storeCalls})`);
  void rawStore;
}

console.log('issue #5268 local launch AbortSignal support regression: PASS');
