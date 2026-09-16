import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gmFetch } from '../js/userscript/network.js';

const originalGM = globalThis.GM;
const originalLocation = globalThis.location;
const requests = [];
const WASM_BYTES = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const ARBITRARY_BYTES = new Uint8Array([0xff, 0x00, 0x7f, 0x80]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function binaryMock(details) {
  requests.push(details);
  if (details.responseType === 'arraybuffer') {
    const url = String(details.url);
    const bytes = url.endsWith('.wasm')
      ? WASM_BYTES
      : (url.endsWith('.bin') ? ARBITRARY_BYTES : new TextEncoder().encode('\uFFFD\u0000\u007F\uFFFD'));
    queueMicrotask(() => details.onload?.({
      status: 200,
      statusText: 'OK',
      response: bytes.slice().buffer,
      responseHeaders: 'content-type: application/octet-stream\r\n',
    }));
    return;
  }
  queueMicrotask(() => details.onload?.({
    status: 200,
    statusText: 'OK',
    response: '\uFFFD\u0000\u007F\uFFFD',
    responseText: '\uFFFD\u0000\u007F\uFFFD',
    responseHeaders: 'content-type: application/octet-stream\r\n',
  }));
}

try {
  Object.defineProperty(globalThis, 'location', {
    value: new URL('https://chatgpt.com/c/test'), configurable: true, writable: true,
  });
  globalThis.GM = { xmlHttpRequest: binaryMock };

  const response = await gmFetch('https://ida.example/assets/capstone.wasm');
  assert.equal(requests.at(-1).responseType, 'arraybuffer', 'gmFetch must request binary-safe response bytes');
  const returnedWasm = new Uint8Array(await response.arrayBuffer());
  assert.equal(sha256(returnedWasm), sha256(WASM_BYTES), 'WASM SHA-256 must survive the GM bridge byte-exact');
  await WebAssembly.compile(returnedWasm);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');

  const arbitrary = await gmFetch('https://ida.example/assets/arbitrary.bin');
  assert.deepEqual(
    [...new Uint8Array(await arbitrary.arrayBuffer())],
    [...ARBITRARY_BYTES],
    'arbitrary non-UTF8 bytes must survive the GM bridge byte-exact',
  );

  const decoded = await gmFetch('https://ida.example/api/ai/turn');
  const bytes = new Uint8Array(await decoded.arrayBuffer());
  assert.deepEqual([...bytes], [239, 191, 189, 0, 127, 239, 191, 189]);
  assert.equal(new TextDecoder().decode(bytes), '\uFFFD\u0000\u007F\uFFFD');

  console.log('issue-5015-gmfetch-binary-byte-exact: ok');
} finally {
  if (originalGM === undefined) delete globalThis.GM; else globalThis.GM = originalGM;
  if (originalLocation === undefined) delete globalThis.location;
  else Object.defineProperty(globalThis, 'location', { value: originalLocation, configurable: true, writable: true });
}
