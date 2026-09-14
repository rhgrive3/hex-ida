import assert from 'node:assert/strict';

// #5957: probeArchitectures() kept only the in-flight promise, so every
// sequential disassembly spawned a fresh capstone-probe Worker (with its WASM
// module init) and terminated it right after. A settled probe result must be
// reused for the Backend lifetime; only failures may retry, and dispose() must
// drop the cached result.
const workers = [];
class FakeWorker {
  constructor() { workers.push(this); this.terminated = false; }
  postMessage() {}
  terminate() { this.terminated = true; }
}
globalThis.Worker = FakeWorker;
globalThis.document = { hidden:false, addEventListener(){}, removeEventListener(){} };
const { Backend } = await import('../../../js/backend.js');
const probeOk = { ok:true, support:{ arm64:true, x86_64:true } };
const settleLast = (value) => workers.at(-1).onmessage({ data:value });

{
  const backend = new Backend();
  const first = backend.probeArchitectures();
  assert.equal(workers.length, 1);
  settleLast(probeOk);
  const result1 = await first;
  const second = backend.probeArchitectures();
  // On main this call regenerates a probe Worker and never settles without a
  // fresh worker message; the timeout converts that hang into a failure.
  const result2 = await Promise.race([
    second,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('probeArchitectures() did not reuse the settled probe result (#5957)')), 250)),
  ]);
  assert.equal(workers.length, 1, 'a settled successful probe must be reused without a new Worker (#5957)');
  assert.equal(result2, result1, 'the cached capability object is the settled probe result');
  assert.throws(() => { result1.support.arm64 = false; }, TypeError, 'cached probe capabilities are immutable');
  assert.equal(result2.support.arm64, true, 'external mutation cannot change cached capability authority');
  assert.equal(result2.ok, true);
  backend.dispose();
}

{
  // Failure results are not cached: the next call may retry the probe.
  const backend = new Backend();
  const before = workers.length;
  const failing = backend.probeArchitectures();
  settleLast({ ok:false, error:'capstone unavailable', support:{ arm64:false, x86_64:false } });
  await failing;
  const retry = backend.probeArchitectures();
  assert.equal(workers.length, before + 2, 'a failed probe must not be cached (#5957)');
  settleLast(probeOk);
  const retryResult = await retry;
  assert.equal(retryResult.ok, true);
  const cached = await backend.probeArchitectures();
  assert.equal(cached, retryResult, 'a subsequent successful probe is cached');
  assert.equal(workers.length, before + 2);
  backend.dispose();
}

{
  // Concurrent callers still coalesce onto one probe.
  const backend = new Backend();
  const before = workers.length;
  const a = backend.probeArchitectures();
  const b = backend.probeArchitectures();
  assert.equal(workers.length, before + 1);
  assert.equal(a, b, 'in-flight probe calls share one promise');
  settleLast(probeOk);
  await Promise.all([a, b]);
  backend.dispose();
}

{
  // dispose() invalidates the cached result: a disposed backend must not
  // serve a stale capability object nor spawn workers.
  const backend = new Backend();
  const before = workers.length;
  const probe = backend.probeArchitectures();
  settleLast(probeOk);
  await probe;
  backend.dispose();
  const disposed = await backend.probeArchitectures();
  assert.equal(disposed.ok, false);
  assert.equal(disposed.error, 'Backend has been disposed.');
  assert.equal(workers.length, before + 1, 'disposed backend must not spawn probe workers');
}

console.log('issue-5957 probe result cache regression: PASS');
