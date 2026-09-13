import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compilePattern, evaluatePattern, evaluatePatternAsync } from '../../../js/pattern/index.js';
import { NodeFileByteSource } from '../../../js/bytesource/node.js';

const snapshotId = 'issue-4897';
const targetA = 32n;
const targetB = 40n;

function putU64(bytes, offset, value) {
  new DataView(bytes.buffer).setBigUint64(offset, value, true);
}

function asyncSparseSource(bytes, reads, signalSeen = null) {
  return {
    snapshotId,
    size: BigInt(bytes.length),
    async read(offset, length, request = {}) {
      reads.push({ offset: BigInt(offset), length, space: request.space, signal: request.signal });
      if (signalSeen) signalSeen.push(request.signal);
      await Promise.resolve();
      const at = Number(offset);
      return bytes.slice(at, at + length);
    },
  };
}

const bytes = new Uint8Array(64);
bytes[0] = 0x11;
bytes[1] = 0x21;
bytes[2] = 0x22;
putU64(bytes, 3, targetA);
putU64(bytes, 11, targetB);
bytes[Number(targetA)] = 0xa1;
bytes[Number(targetB)] = 0xb2;

const compiled = compilePattern({
  kind: 'struct',
  name: 'Root',
  fields: [
    { name: 'head', type: { kind: 'primitive', name: 'u8' } },
    { name: 'items', type: { kind: 'array', count: 2, element: { kind: 'primitive', name: 'u8' } } },
    { name: 'ptr', type: { kind: 'pointer', space: 'file', target: { kind: 'primitive', name: 'u8' } } },
    { name: 'off', type: { kind: 'offset', space: 'file', target: { kind: 'primitive', name: 'u8' } } },
  ],
}, { snapshotId });

// Public async evaluation must await source reads throughout struct fields.
{
  const reads = [];
  const signals = [];
  const controller = new AbortController();
  const result = await evaluatePatternAsync(compiled, asyncSparseSource(bytes, reads, signals), {
    signal: controller.signal,
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.value.fields.head.value, 0x11);
  assert.equal(result.value.fields.ptr.value, Number(targetA));
  assert.equal(result.value.fields.off.value, Number(targetB));
  assert.ok(signals.length >= 3);
  assert.ok(signals.every((signal) => signal === controller.signal), 'signal must reach every async source read');

  // Lazy array and pointer/offset continuations must remain usable and await reads.
  assert.equal((await result.value.fields.items.expand(0)).value, 0x21);
  assert.equal((await result.value.fields.items.expand(1)).value, 0x22);
  assert.equal((await result.value.fields.ptr.dereference()).value, 0xa1);
  assert.equal((await result.value.fields.off.dereference()).value, 0xb2);
  assert.ok(signals.every((signal) => signal === controller.signal));
}

// The repository's official file-backed ByteSource is async and must work directly.
{
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hex-pattern-4897-'));
  const file = path.join(dir, 'fixture.bin');
  await writeFile(file, Uint8Array.of(0x2a));
  const source = await NodeFileByteSource.open(file);
  try {
    const result = await evaluatePatternAsync(
      compilePattern('struct Root { value: u8; }'),
      source,
    );
    assert.equal(result.status, 'complete');
    assert.equal(result.value.fields.value.value, 0x2a);
  } finally {
    await source.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// Cancellation during an in-flight async read must be forwarded to the ByteSource.
{
  const controller = new AbortController();
  let receivedSignal = null;
  const reason = new Error('stop-pattern-async-read');
  const source = {
    snapshotId,
    size: 1n,
    read(_offset, _length, { signal } = {}) {
      receivedSignal = signal;
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const pending = evaluatePatternAsync(
    compilePattern('struct Root { value: u8; }', { snapshotId }),
    source,
    { signal: controller.signal },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(receivedSignal, controller.signal);
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
}

// The synchronous API remains synchronous and unchanged for memory-backed input.
{
  const result = evaluatePattern('struct Root { value: u8; }', Uint8Array.of(0x7f));
  assert.equal(result.status, 'complete');
  assert.equal(result.value.fields.value.value, 0x7f);
  assert.equal(result.value.fields.value.provenance.offset, '0');
}

console.log('[phase12] issue #4897 async Pattern ByteSource regressions passed');
