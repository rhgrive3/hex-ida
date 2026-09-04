import assert from 'node:assert/strict';
import { MemoryByteSource, BlobByteSource, asByteSource } from '../js/binary/source.js';

// #6099: ByteSource abort must preserve AbortSignal.reason identity.
{
  const source = new MemoryByteSource(Uint8Array.of(0x41));
  const controller = new AbortController();
  const reason = Object.assign(new Error('user-cancelled-binary-read'), { code: 'USER_CANCEL' });
  controller.abort(reason);
  await assert.rejects(
    source.readExactly(0n, 1, { signal: controller.signal }),
    (error) => error === reason,
  );
}

for (const reason of [false, 0, '', 'user-stopped']) {
  const source = new MemoryByteSource(Uint8Array.of(0x41));
  const controller = new AbortController();
  controller.abort(reason);
  await assert.rejects(
    source.readExactly(0n, 1, { signal: controller.signal }),
    (error) => Object.is(error, reason),
  );
}

{
  const source = new MemoryByteSource(Uint8Array.of(0x41));
  const controller = new AbortController();
  controller.abort();
  try {
    await source.readExactly(0n, 1, { signal: controller.signal });
    assert.fail('must throw');
  } catch (error) {
    assert.equal(error === controller.signal.reason, true);
    assert.equal(error?.name, 'AbortError');
  }
}

{
  const source = new MemoryByteSource(Uint8Array.of(0x41, 0x42));
  const controller = new AbortController();
  const reason = new Error('memory-read-abort');
  controller.abort(reason);
  await assert.rejects(source.read(0n, 1, { signal: controller.signal }), (e) => e === reason);
}

if (typeof Blob !== 'undefined') {
  const source = new BlobByteSource(new Blob([Uint8Array.of(0x41)]));
  const controller = new AbortController();
  const reason = new Error('blob-read-abort');
  controller.abort(reason);
  await assert.rejects(source.read(0n, 1, { signal: controller.signal }), (e) => e === reason);
}

{
  const parent = new MemoryByteSource(Uint8Array.of(0x41));
  const source = asByteSource({ size: 1n, maxReadLength: 16, async read(o, l, opts) { return parent.read(o, l, opts); } });
  const controller = new AbortController();
  const reason = new Error('delegating-abort');
  controller.abort(reason);
  await assert.rejects(source.readExactly(0n, 1, { signal: controller.signal }), (e) => e === reason);
}

{
  const source = new MemoryByteSource(Uint8Array.of(0x41));
  const bytes = await source.readExactly(0n, 1, {});
  assert.equal(bytes[0], 0x41);
}

console.log('issue-6099: PASS');
