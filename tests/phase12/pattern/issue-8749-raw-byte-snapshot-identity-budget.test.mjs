import assert from 'node:assert/strict';
import test from 'node:test';

import { compilePattern, evaluatePattern, evaluatePatternAsync } from '../../../js/pattern/index.js';
import { byteViewDigest } from '../../../js/pattern/index-core.js';
import { stableDigest } from '../../../js/core/identity/index.js';

const patternSource = 'struct Root { value: u8; }';

test('#8749 raw-byte snapshot identity is the streaming byte-view digest, not a boxed Array.from hash', () => {
  const bytes = Uint8Array.from([0x2a, 0x00, 0x7f]);
  const compiled = compilePattern(patternSource);
  const result = evaluatePattern(compiled, bytes, { maxBytes: 1 });
  assert.equal(result.status, 'complete');
  assert.equal(result.snapshotId, byteViewDigest(bytes));
  // Regression guard: the removed pre-budget path boxed one JS number per byte
  // and canonicalized a decimal JSON string; the streaming digest is a
  // different value, so this equality fails on the un-fixed base.
  assert.notEqual(result.snapshotId, stableDigest(Array.from(bytes)));
});

test('#8749 snapshot identity stays content-complete over bytes the pattern never reads', () => {
  const compiled = compilePattern(patternSource);
  const a = Uint8Array.from([0x2a, ...new Array(255).fill(0), 0x01]);
  const b = Uint8Array.from([0x2a, ...new Array(255).fill(0), 0x02]);
  const ra = evaluatePattern(compiled, a, { maxBytes: 1 });
  const rb = evaluatePattern(compiled, b, { maxBytes: 1 });
  assert.equal(ra.value.fields.value.value, rb.value.fields.value.value, 'both read the same first byte');
  assert.notEqual(ra.snapshotId, rb.snapshotId, 'a trailing unread byte must still change provenance identity');
});

test('#8749 raw-byte snapshot identity is deterministic across sync and async evaluators', async () => {
  const compiled = compilePattern(patternSource);
  const bytes = Uint8Array.from([0x10, 0x20, 0x30, 0x40]);
  const sync = evaluatePattern(compiled, bytes, { maxBytes: 2 });
  const async = await evaluatePatternAsync(compiled, bytes, { maxBytes: 2 });
  assert.equal(sync.snapshotId, byteViewDigest(bytes));
  assert.equal(async.snapshotId, sync.snapshotId);
});

test('#8749 a caller-supplied snapshot identity still short-circuits re-derivation', () => {
  const compiled = compilePattern(patternSource);
  const bytes = Uint8Array.from([0x05, 0x06, 0x07]);
  // An explicit evaluate-time snapshot id must be honored without hashing the
  // raw source (the existing content-complete identity contract's shortcut).
  const result = evaluatePattern(compiled, bytes, { maxBytes: 1, snapshotId: 'snap-bound' });
  assert.equal(result.status, 'complete');
  assert.equal(result.snapshotId, 'snap-bound');
});

test('#8749 hashing a multi-megabyte raw source is linear-memory and completes', () => {
  const compiled = compilePattern(patternSource);
  const size = 4 * 1024 * 1024;
  const bytes = new Uint8Array(size);
  bytes[0] = 0x33;
  bytes[size - 1] = 0x77;
  const started = process.hrtime.bigint();
  const result = evaluatePattern(compiled, bytes, { maxBytes: 1 });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result.status, 'complete');
  assert.equal(result.snapshotId.length, 32);
  assert.equal(result.snapshotId, byteViewDigest(bytes));
  assert.ok(elapsedMs < 3000, `streaming digest must be fast, took ${elapsedMs}ms`);
});

test('#8749 compile fails closed on an attacker-sized binary-rich AST field before canonicalization', () => {
  const ast = {
    kind: 'struct',
    name: 'Root',
    fields: [{ name: 'blob', type: { kind: 'bytes' }, default: new Uint8Array(9 * 1024 * 1024) }],
  };
  assert.throws(
    () => compilePattern(ast),
    (error) => error.code === 'pattern-identity-input-too-large',
    'a >8 MiB binary field must fail closed with a stable code, not OOM in stableDigest',
  );
});
