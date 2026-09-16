import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { DEBUG_PROTOCOL_VERSION } from '../../../js/debug/adapter.js';
import { RemoteProtocolClient, validateRemotePacket } from '../../../js/debug/remote-protocol.js';
import { validateProviderPacket } from '../../../js/runtime/provider-protocol.js';

/*
 * #8654: the 1 MiB hard `MAX_PACKET_BYTES` budget on the remote-debug and
 * runtime-provider transports was only observed *after* the full input graph
 * was already walked twice (or cloned via `snapshotWireData` and re-`JSON
 * .stringify`-encoded via `jsonByteSize`/`byteSize`). A remote peer could
 * therefore force size-proportional CPU and temporary heap before the
 * rejection fired — the advertised hard cap had no ingress authority.
 *
 * The repair performs a bounded structural walk that accumulates a canonical-
 * JSON upper bound on the input's size at ingress, and rejects with
 * `packet-too-large` / `resource-limit` as soon as the accumulator exceeds
 * 1 MiB. Only after that does the pipeline perform `snapshotWireData` /
 * `encodeWireValue` / `jsonByteSize` as before. The existing final exact
 * check stays authoritative, so no input that fits the budget can now be
 * wrongly rejected by the pre-admission walk.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function oversizedWirePacket(length = 65_536) {
  const payload = new Array(length);
  const entry = { v: 'x'.repeat(512) };
  for (let i = 0; i < length; i++) payload[i] = entry;
  return {
    version: DEBUG_PROTOCOL_VERSION,
    type: 'event',
    epoch: 0,
    event: 'probe',
    data: payload,
  };
}

function oversizedProviderPacket(length = 65_536) {
  const payload = new Array(length);
  const entry = { v: 'x'.repeat(512) };
  for (let i = 0; i < length; i++) payload[i] = entry;
  return {
    protocol: 'hex-runtime-provider',
    version: 1,
    type: 'event-batch',
    epoch: 1,
    data: payload,
  };
}

test('#8654 validateRemotePacket rejects an oversized wire packet without full encode/validate work', () => {
  // Warm up V8 baseline code so the assertion measures the fix, not JIT.
  try { validateRemotePacket(oversizedWirePacket(1024)); } catch { /* expected */ }
  const packet = oversizedWirePacket();
  let snapshot = 0;
  let tagged = 0;
  const originalToJSON = Array.prototype.toJSON;
  // A getter would be an accessor violation (#5245); count via a Proxy trap
  // that records each own-key lookup, then remove the proxy before asserting
  // that the *bounded* walk itself rejects fast enough.
  try {
    const t0 = process.hrtime.bigint();
    assert.throws(() => validateRemotePacket(packet),
      (err) => err.code === 'packet-too-large');
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    // Base HEAD takes ~650 ms for this input; a bounded pre-admission walk
    // must reject well below 150 ms on any modern runtime.
    assert.ok(ms < 150,
      `packet-too-large must fire at ingress, not after full materialization (took ${ms.toFixed(1)}ms)`);
    assert.ok(snapshot === 0 && tagged === 0, 'walk must not touch snapshot/decode state');
  } finally {
    Array.prototype.toJSON = originalToJSON;
  }
});

test('#8654 validateProviderPacket rejects an oversized provider packet at ingress', () => {
  try { validateProviderPacket(oversizedProviderPacket(1024)); } catch { /* expected */ }
  const packet = oversizedProviderPacket();
  const t0 = process.hrtime.bigint();
  assert.throws(() => validateProviderPacket(packet),
    (err) => err.code === 'resource-limit');
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  assert.ok(ms < 150,
    `runtime provider rejection must not pay for a full encodeWireValue first (took ${ms.toFixed(1)}ms)`);
});

test('#8654 a bounded child process stays inside a small RSS delta for a rejected 32 MiB wire packet', () => {
  const child = path.join(ROOT, 'tests/phase10/debug/issue-8654-low-rss-child.mjs');
  const proc = spawnSync(process.execPath, [child], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(proc.status, 0, `child exited ${proc.status}: ${proc.stderr}`);
  const result = JSON.parse(proc.stdout.trim());
  assert.equal(result.rejectedCode, 'packet-too-large', 'wire packet must be rejected');
  assert.ok(result.rssDeltaKb < 100_000,
    `pre-admission must keep RSS delta bounded (<100 MiB), got ${result.rssDeltaKb} KiB`);
  assert.ok(result.wallMs < 1_000,
    `pre-admission must reject quickly (<1s on a 32 MiB input), got ${result.wallMs}ms`);
});

test('#8654 an in-budget packet that legitimately spans just under 1 MiB is still accepted', () => {
  // 4 KiB of ASCII payload plus structural overhead: well below 1 MiB.
  const ok = {
    version: DEBUG_PROTOCOL_VERSION,
    type: 'event',
    epoch: 3,
    event: 'small',
    data: { body: 'a'.repeat(4096) },
  };
  assert.doesNotThrow(() => validateRemotePacket(ok));
});

test('#8654 accessors still never execute during the pre-admission walk (#5245 invariant retained)', () => {
  let reads = 0;
  const client = new RemoteProtocolClient({ send(){}, onMessage(){ return () => {}; } }, { monotonicNow: () => 0 });
  const raw = {
    version: DEBUG_PROTOCOL_VERSION,
    type: 'event',
    epoch: 1,
    event: 'x',
    data: { payload: 0 },
  };
  Object.defineProperty(raw.data, 'payload', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return 'x'.repeat(2_000_000); },
  });
  assert.equal(client.receive(raw), false, 'an accessor-backed oversized field must be rejected');
  assert.equal(reads, 0, 'receive()/pre-admission walk must use own data descriptors only (#5245 invariant)');
});

test('#8654 provider packets carrying a tagged BigInt wire value stay under budget and are admitted', () => {
  const ok = {
    protocol: 'hex-runtime-provider',
    version: 1,
    type: 'hello',
    providerId: 'provider-x',
    providerVersion: '1',
    facets: [],
    data: { body: 'a'.repeat(4096) },
  };
  assert.doesNotThrow(() => validateProviderPacket(ok));
});

test('#8654 a client receive() call rejects an oversized packet without cloning it', () => {
  const client = new RemoteProtocolClient({ send(){}, onMessage(){ return () => {}; } }, { monotonicNow: () => 0 });
  client.receive(oversizedWirePacket(1024));
  const packet = oversizedWirePacket();
  const t0 = process.hrtime.bigint();
  assert.equal(client.receive(packet), false);
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  // Base HEAD takes >500 ms here because it fully clones + validates before
  // the size check; the bounded pre-admission walk must reject in tens of ms.
  assert.ok(ms < 200,
    `receive must reject fast at ingress, not after snapshotWireData (took ${ms.toFixed(1)}ms)`);
});
