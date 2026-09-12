import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decompressGzipExact } from '../js/userscript/decompress.js';

const NativeDecompressionStream = globalThis.DecompressionStream;
assert.equal(typeof NativeDecompressionStream, 'function', 'Node runtime must provide DecompressionStream');
assert.equal(typeof Response, 'function', 'Node runtime must provide Response');

const unhandled = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push(reason);
});

const drain = () => new Promise((resolve) => setTimeout(resolve, 100));

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return { failed: true, error };
  }
  return { failed: false };
}

const nativeAttempt = await captureRejection(decompressGzipExact(new Uint8Array([1, 2, 3])));
assert.ok(nativeAttempt.failed, 'invalid gzip bytes must reject decompressGzipExact');
assert.ok(nativeAttempt.error instanceof TypeError, 'invalid gzip bytes must reject with a TypeError');
await drain();

let writableFirstAttempts = 0;
let readableFailures = 0;

class WritableFirstFailureDecompressionStream {
  constructor(format) {
    assert.equal(format, 'gzip');
    let errorReadable;
    this.readable = new ReadableStream({
      start(controller) {
        errorReadable = (failure) => {
          readableFailures += 1;
          controller.error(failure);
        };
      },
    });
    this.writable = {
      getWriter() {
        return {
          async write() {
            writableFirstAttempts += 1;
            const failure = new TypeError('synthetic writable-first gzip failure');
            queueMicrotask(() => errorReadable(failure));
            throw failure;
          },
          close() {
            return Promise.reject(new TypeError('synthetic writable close failure'));
          },
        };
      },
    };
  }
}

globalThis.DecompressionStream = WritableFirstFailureDecompressionStream;
try {
  const syntheticAttempt = await captureRejection(
    decompressGzipExact(new Uint8Array([0x1f, 0x8b, 0x08, 0x00])),
  );
  assert.ok(syntheticAttempt.failed, 'writable-first stream failure must reject decompressGzipExact');
  assert.equal(syntheticAttempt.error.message, 'synthetic writable-first gzip failure');
  assert.ok(writableFirstAttempts >= 1, 'the writable side must have been exercised');
  assert.ok(readableFailures >= 1, 'the readable side must have rejected with the same stream failure');
  await drain();
} finally {
  globalThis.DecompressionStream = NativeDecompressionStream;
}

const source = 'Hex gzip failure must settle both stream promises';
const gz = gzipSync(Buffer.from(source));
async function withinDeadline(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('decompression did not settle before fallback deadline')), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const chunkTypes = [];
class TypedArrayOnlyDecompressionStream {
  constructor(format) {
    const inner = new NativeDecompressionStream(format);
    const writer = inner.writable.getWriter();
    this.readable = inner.readable;
    this.writable = {
      getWriter() {
        return {
          write(chunk) {
            chunkTypes.push(chunk.constructor);
            if (chunk instanceof ArrayBuffer) return Promise.reject(new TypeError('typedarray chunk required'));
            return writer.write(chunk);
          },
          close() { return writer.close(); },
          abort(reason) { return writer.abort(reason); },
        };
      },
    };
  }
}

globalThis.DecompressionStream = TypedArrayOnlyDecompressionStream;
try {
  const result = await withinDeadline(decompressGzipExact(new Uint8Array(gz)));
  assert.equal(new TextDecoder().decode(result), source);
  assert.deepEqual(chunkTypes, [ArrayBuffer, Uint8Array], 'an open readable must not block the typed-array retry');
} finally {
  globalThis.DecompressionStream = NativeDecompressionStream;
}

for (const failure of [undefined, null, false, 0, '']) {
  for (const failingSide of ['write', 'close', 'read']) {
    globalThis.DecompressionStream = class {
      constructor() {
        this.readable = new ReadableStream({
          start(controller) {
            if (failingSide === 'read') controller.error(failure);
            else controller.close();
          },
        });
        this.writable = {
          getWriter() {
            return {
              async write() { if (failingSide === 'write') throw failure; },
              async close() { if (failingSide === 'close') throw failure; },
            };
          },
        };
      }
    };
    try {
      const result = await captureRejection(withinDeadline(decompressGzipExact(new Uint8Array(gz))));
      assert.equal(result.failed, true, `${failingSide} must reject even with a falsy reason`);
      assert.equal(result.error, failure, `${failingSide} must preserve the exact rejection reason`);
    } finally {
      globalThis.DecompressionStream = NativeDecompressionStream;
    }
  }
}
await drain();

const roundtrip = await decompressGzipExact(new Uint8Array(gz));
assert.equal(new TextDecoder().decode(roundtrip), source, 'valid gzip must still decompress exactly');

assert.deepEqual(
  unhandled.map((error) => `${error?.name}: ${error?.message}`),
  [],
  `gzip decompression failure must not leave unhandled rejections (observed ${unhandled.length})`,
);

console.log('issue-5013 gzip decompression unhandled-rejection regression PASS');
