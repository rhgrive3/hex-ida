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

console.log('issue #5268 local launch AbortSignal support regression: PASS');
