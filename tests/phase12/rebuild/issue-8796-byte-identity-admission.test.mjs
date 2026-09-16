import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableDigest, stableDigestBytes } from '../../../js/core/identity/index.js';
import {
  createRebuildTransaction,
  materializeRebuildTransaction,
} from '../../../js/rebuild/transaction-v2.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

function randomBytes(size, seed = 7) {
  const bytes = new Uint8Array(size);
  let state = seed;
  for (let index = 0; index < size; index++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

function runLowHeapChild(mode) {
  const childSource = `
import { pathToFileURL } from 'node:url';
const root = ${JSON.stringify(REPO_ROOT)};
const { createRebuildTransaction, materializeRebuildTransaction } = await import(pathToFileURL(root + '/js/rebuild/transaction-v2.js').href);
const { stableDigestBytes } = await import(pathToFileURL(root + '/js/core/identity/index.js').href);
const source = new Uint8Array(4 * 1024 * 1024);
source.fill(65);
if (${JSON.stringify(mode)} === 'reject') {
  const tx = createRebuildTransaction({
    binaryId: 'binary:test', format: 'macho', architecture: 'arm64', loaderVersion: 'test',
    sourceHash: 'bytes:' + '0'.repeat(32),
    operations: [{ id: 'x', offset: 0, before: [65], after: [66] }],
  });
  const result = await materializeRebuildTransaction(tx, source, { maxOutputBytes: 1 });
  console.log(JSON.stringify({ status: result.status, reason: result.reason }));
} else {
  const tx = createRebuildTransaction({
    binaryId: 'binary:test', format: 'macho', architecture: 'arm64', loaderVersion: 'test',
    sourceHash: 'bytes:' + stableDigestBytes(source),
    operations: [{ id: 'x', offset: 0, before: [65], after: [66] }],
  });
  const result = await materializeRebuildTransaction(tx, source, {});
  console.log(JSON.stringify({
    status: result.status,
    hashShape: typeof result.outputHash === 'string' && /^bytes:[0-9a-f]{32}$/.test(result.outputHash),
    identityBound: result.outputIdentity === 'rebuild-output:' + result.transactionId + ':' + result.outputHash,
    sourceLength: result.sourceLength,
    outputLength: result.outputLength,
  }));
}
`;
  const file = join(process.env.TMPDIR || tmpdir(), `issue-8796-child-${mode}-${process.pid}.mjs`);
  writeFileSync(file, childSource);
  try {
    return spawnSync(process.execPath, ['--max-old-space-size=64', file], { encoding: 'utf8' });
  } finally {
    rmSync(file, { force: true });
  }
}

function childReport(child) {
  assert.equal(child.status, 0, `low-heap child exited ${child.status}: ${child.stderr}`);
  return JSON.parse(child.stdout.trim().split('\n').pop());
}

test('issue #8796: streaming byte digest is exactly equal to the boxed JSON digest', () => {
  const vectors = [
    new Uint8Array(0),
    Uint8Array.from([0]),
    Uint8Array.from([255]),
    Uint8Array.from([0, 1, 2, 253, 254, 255]),
    randomBytes(16_383),
    randomBytes(16_384),
    randomBytes(16_385),
    randomBytes(40_000),
    new Uint8Array(20_000).fill(65),
  ];
  for (const bytes of vectors) {
    assert.equal(
      stableDigestBytes(bytes),
      stableDigest(Array.from(bytes)),
      `chunked streaming digest must preserve the canonical value (length ${bytes.length})`,
    );
    assert.match(`bytes:${stableDigestBytes(bytes)}`, /^bytes:[0-9a-f]{32}$/);
  }
});

test('issue #8796: Blob declared-size admission rejects before arrayBuffer() materialization', async () => {
  let arrayBufferCalls = 0;
  class CountingBlob extends Blob {
    arrayBuffer() {
      arrayBufferCalls += 1;
      return super.arrayBuffer();
    }
  }
  const blob = new CountingBlob([new Uint8Array(4 * 1024 * 1024).fill(65)]);
  const transaction = createRebuildTransaction({
    binaryId: 'binary:test',
    format: 'macho',
    architecture: 'arm64',
    loaderVersion: 'test',
    sourceHash: `bytes:${'0'.repeat(32)}`,
    operations: [{ id: 'x', offset: 0, before: [65], after: [66] }],
  });
  const result = await materializeRebuildTransaction(transaction, blob, { maxOutputBytes: 1 });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'rebuild-v2-output-budget-exceeded');
  assert.equal(arrayBufferCalls, 0, 'a budget-rejected Blob source must never be materialized');
});

test('issue #8796: 4 MiB rejection path completes under a 64 MiB heap', () => {
  const reported = childReport(runLowHeapChild('reject'));
  assert.deepEqual(reported, { status: 'rejected', reason: 'rebuild-v2-output-budget-exceeded' });
});

test('issue #8796: 4 MiB successful materialization completes under a 64 MiB heap with one bounded output hash', () => {
  const reported = childReport(runLowHeapChild('materialize'));
  assert.equal(reported.status, 'materialized');
  assert.equal(reported.hashShape, true, 'output hash keeps the bytes:<32 hex> contract');
  assert.equal(reported.identityBound, true, 'output identity derives from the single computed output hash');
  assert.equal(reported.sourceLength, 4 * 1024 * 1024);
  assert.equal(reported.outputLength, 4 * 1024 * 1024);
});

test('issue #8796: materialized identity still validates against recomputed byte hashes', async () => {
  const source = randomBytes(300);
  const transaction = createRebuildTransaction({
    binaryId: 'binary:small',
    format: 'elf',
    architecture: 'x86_64',
    loaderVersion: 'test',
    sourceHash: `bytes:${stableDigestBytes(source)}`,
    operations: [{ id: 'op-1', offset: 10, before: Array.from(source.subarray(10, 14)), after: [1, 2, 3, 4] }],
  });
  const materialized = await materializeRebuildTransaction(transaction, source, {});
  assert.equal(materialized.status, 'materialized');
  assert.equal(materialized.sourceHash, `bytes:${stableDigest(Array.from(source))}`, 'source identity is unchanged for the legacy formula');
  assert.equal(materialized.outputHash, `bytes:${stableDigest(Array.from(materialized.bytes))}`, 'output identity is unchanged for the legacy formula');
});
