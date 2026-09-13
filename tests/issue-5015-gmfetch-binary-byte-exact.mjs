import assert from 'node:assert/strict';
import { gmFetch } from '../js/userscript/network.js';

const originalGM = globalThis.GM;
const originalLocation = globalThis.location;
const requests = [];

function binaryMock(details) {
  requests.push(details);
  if (details.responseType === 'arraybuffer') {
    const bytes = String(details.url).endsWith('.wasm')
      ? new Uint8Array([0xff, 0x00, 0x7f, 0x80])
      : new TextEncoder().encode('\uFFFD\u0000\u007F\uFFFD');
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
  assert.deepEqual(
    [...new Uint8Array(await response.arrayBuffer())],
    [0xff, 0x00, 0x7f, 0x80],
    'WASM bytes must survive the GM bridge byte-exact',
  );
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');

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
