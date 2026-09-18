import assert from 'node:assert/strict';
import { DebugAdapterError, normalizeBreakpoint } from '../../../js/debug/adapter.js';
import { LocalFunctionSandboxAdapter, RemoteDebugAdapter } from '../../../js/adapters/index.js';

function expectInvalidBreakpoint(fn, label) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DebugAdapterError, `${label}: expected DebugAdapterError`);
    assert.equal(error.code, 'invalid-breakpoint', `${label}: expected invalid-breakpoint`);
    return true;
  });
}

const validSpecs = [
  { kind:'address', address:0x1000n },
  { kind:'function', function:'target' },
  { kind:'conditional', address:0x1010n, condition:'x0 == 1' },
  { kind:'memory', address:0x2000n, size:4, access:'write' },
];

for (const spec of validSpecs) {
  assert.equal(normalizeBreakpoint(spec).enabled, true, `${spec.kind}: omitted enabled defaults true`);
  assert.equal(normalizeBreakpoint({ ...spec, enabled:true }).enabled, true, `${spec.kind}: true remains true`);
  assert.equal(normalizeBreakpoint({ ...spec, enabled:false }).enabled, false, `${spec.kind}: false remains false`);
  for (const bad of ['false', 0, 1, null, [], {}, new Boolean(false)]) {
    expectInvalidBreakpoint(
      () => normalizeBreakpoint({ ...spec, enabled:bad }),
      `${spec.kind}: ${Object.prototype.toString.call(bad)}`,
    );
  }
}

{
  let reads = 0;
  const spec = {
    kind:'address',
    address:0x3000n,
    get enabled() {
      reads++;
      return reads === 1 ? false : true;
    },
  };
  assert.equal(normalizeBreakpoint(spec).enabled, false, 'enabled authority must come from one snapshot read');
  assert.equal(reads, 1, 'enabled getter must be read exactly once');
}

{
  let enabledReads = 0;
  const invalid = {
    kind:'address',
    address:-1n,
    get enabled() { enabledReads++; throw new Error('must not read enabled before address validation'); },
  };
  assert.throws(() => normalizeBreakpoint(invalid), (error) => error?.code === 'invalid-address');
  assert.equal(enabledReads, 0, 'existing field validation must keep precedence over enabled normalization');
}

{
  let physicalAdds = 0;
  const local = new LocalFunctionSandboxAdapter({});
  local.sandbox = {
    addBreakpoint() { physicalAdds++; },
    removeBreakpoint() {},
  };
  await assert.rejects(
    local.setBreakpoint({ kind:'address', address:0x4000n, enabled:'false' }),
    (error) => error?.code === 'invalid-breakpoint',
  );
  assert.equal(physicalAdds, 0, 'malformed enabled must not reach local physical breakpoint installation');
  assert.equal(local.breakpoints.size, 0, 'malformed enabled must not enter local breakpoint ledger');
}

{
  const sent = [];
  const remote = new RemoteDebugAdapter({
    send(packet) { sent.push(packet); },
    onMessage() { return () => {}; },
  }, {
    capabilities:{ breakpointAddress:true },
    protocol:{ timeoutMs:1000 },
  });
  // This focused boundary test bypasses handshake setup so it can prove that
  // malformed enabled is rejected by shared normalization before any request.
  remote.connected = true;

  let thrown = null;
  let pending = null;
  try {
    pending = remote.setBreakpoint({ kind:'address', address:0x5000n, enabled:'false' });
  } catch (error) {
    thrown = error;
  }
  if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  await Promise.resolve();
  remote.protocol.close();

  assert.equal(thrown?.code, 'invalid-breakpoint', 'malformed enabled must fail at remote adapter normalization');
  assert.equal(sent.length, 0, 'malformed enabled must not reach remote transport');
}

console.log('issue #5246 breakpoint enabled boolean authority: PASS');
