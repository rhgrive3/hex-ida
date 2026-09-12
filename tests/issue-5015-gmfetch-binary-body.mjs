import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as network from '../js/userscript/network.js';
import { prepareUserscriptWorkers } from '../js/userscript/worker-assets.js';

const wasmFixture = new URL('../capstone.wasm', import.meta.url);
const originalFetch = globalThis.fetch;
const originalGM = globalThis.GM;
const originalLocation = globalThis.location;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const gmRequests = [];
const nativeRequests = [];
const createdBlobs = [];
const servedBytes = new Map();

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function lossyTextDecode(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

function gmTextOnlyRequest(details) {
  assert.equal(details.responseType, 'text',
    'GM transport must stay text-only: iOS Userscripts cannot deliver a byte-exact GM binary response (#620).');
  gmRequests.push({ url: details.url, responseType: details.responseType, method: details.method });
  const bytes = servedBytes.get(details.url);
  if (bytes == null) {
    queueMicrotask(() => details.onerror?.({ status: 404 }));
    return { abort() {} };
  }
  queueMicrotask(() => details.onload?.({
    status: 200,
    statusText: 'OK',
    response: lossyTextDecode(bytes),
    responseText: lossyTextDecode(bytes),
    responseHeaders: 'content-type: application/octet-stream\r\n',
  }));
  return { abort() {} };
}

async function nativeBinaryFetch(input, init = {}) {
  const url = String(input);
  nativeRequests.push({ url, credentials: init?.credentials });
  const bytes = servedBytes.get(url);
  if (bytes == null) return new Response(null, { status: 404, statusText: 'Not Found' });
  return new Response(bytes.slice(0), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/wasm' },
  });
}

function manifestFor(wasmName) {
  return {
    classicAssets: ['js/worker.js'],
    classicEntries: ['js/worker.js'],
    wasm: wasmName,
    moduleBundles: {},
  };
}

async function runWorkerAssetScenario(name, payload) {
  const assetBase = 'https://ida.example/userscript-assets/';
  const wasmURL = `${assetBase}${name}`;
  servedBytes.set(`${assetBase}js/worker.js`, new TextEncoder().encode('globalThis.hexWorkerReady = true;\n'));
  servedBytes.set(wasmURL, payload);
  createdBlobs.length = 0;
  const runtime = await prepareUserscriptWorkers({ origin: 'https://ida.example/', manifest: manifestFor(name) });
  const wasmBlob = createdBlobs.find((blob) => blob.type === 'application/wasm');
  assert.ok(wasmBlob, `a ${name} Blob must be created for ${wasmURL}`);
  const bytes = new Uint8Array(await wasmBlob.arrayBuffer());
  assert.deepEqual([...bytes], [...payload],
    `${name} must reach the WASM Blob byte-exact (text reconstruction corrupts arbitrary bytes)`);
  assert.equal(gmRequests.some((request) => request.url === wasmURL), false,
    `${name} must not be transported through the text-only GM bridge`);
  const assetRequest = nativeRequests.find((request) => request.url === wasmURL);
  assert.ok(assetRequest, `${name} must be transported through native fetch`);
  assert.equal(assetRequest.credentials, 'omit', 'binary asset transport must not send ambient credentials');
  runtime.cleanup();
  return bytes;
}

try {
  Object.defineProperty(globalThis, 'location', {
    value: new URL('https://chatgpt.com/c/test'), configurable: true, writable: true,
  });
  Object.defineProperty(URL, 'createObjectURL', {
    value(blob) { createdBlobs.push(blob); return `blob:hex-issue-5015-${createdBlobs.length}`; },
    configurable: true, writable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value() {}, configurable: true, writable: true });
  globalThis.Worker = class HexWorkerStub { constructor(url) { this.url = url; } postMessage() {} terminate() {} };
  globalThis.addEventListener = () => {};
  globalThis.GM = { xmlHttpRequest: gmTextOnlyRequest };
  globalThis.fetch = nativeBinaryFetch;

  {
    const url = 'https://ida.example/api/ai/turn';
    servedBytes.set(url, new TextEncoder().encode('gm-ok'));
    const response = await network.gmFetch(url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'gm-ok', 'ASCII text bodies must survive the GM bridge');
  }

  {
    const url = 'https://ida.example/api/ai/unicode';
    const text = 'Hex — 日本語 🟦 ok';
    const bytes = new TextEncoder().encode(text);
    servedBytes.set(url, bytes);
    const response = await network.gmFetch(url);
    const decodedText = await response.clone().text();
    const decodedBytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(decodedText, text, 'UTF-8 text bodies must survive the GM bridge');
    assert.deepEqual([...decodedBytes], [...bytes],
      'UTF-8 text bodies must re-encode to their original bytes');
  }

  const arbitrary = await runWorkerAssetScenario('arbitrary.wasm', new Uint8Array([0x00, 0xff, 0x80, 0x7f]));
  assert.deepEqual([...arbitrary], [0x00, 0xff, 0x80, 0x7f],
    'arbitrary bytes must reach the WASM Blob byte-exact');

  const capstoneBytes = new Uint8Array(await readFile(wasmFixture));
  const loadedCapstone = await runWorkerAssetScenario('capstone.wasm', capstoneBytes);
  assert.equal(sha256(loadedCapstone), sha256(capstoneBytes),
    'the real capstone.wasm fixture must keep its SHA-256 digest across the userscript asset transport');

  assert.equal(typeof network.fetchBinary, 'function',
    'a byte-exact binary transport must be exposed by the userscript network module');
  const direct = await network.fetchBinary('https://ida.example/userscript-assets/capstone.wasm');
  assert.equal(sha256(new Uint8Array(await direct.arrayBuffer())), sha256(capstoneBytes),
    'fetchBinary() must return byte-exact response body bytes');

  {
    delete globalThis.__HEX_NATIVE_FETCH__;
    const bridged = async () => { throw new Error('the bridged text fetch must never carry binary bodies'); };
    Object.defineProperty(bridged, '__hexUserscriptFetch', { value: true });
    globalThis.fetch = bridged;
    await assert.rejects(
      network.fetchBinary('https://ida.example/userscript-assets/capstone.wasm'),
      (error) => error instanceof TypeError,
      'binary transport must fail closed when only the lossy text bridge is available',
    );
  }

  const sources = await Promise.all([
    readFile(new URL('../js/userscript/network.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/userscript/worker-assets.js', import.meta.url), 'utf8'),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(source, /responseType:\s*['"](?!text)/,
      'GM requests must never ask for a non-text response type (#620 iOS invariant)');
  }

  const userscriptDir = new URL('../js/userscript/', import.meta.url);
  for (const entry of (await readdir(userscriptDir)).filter((name) => name.endsWith('.js'))) {
    const source = await readFile(new URL(entry, userscriptDir), 'utf8');
    for (const assignment of source.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*await\s+gmFetch\s*\(/g)) {
      assert.doesNotMatch(source, new RegExp(`\\b${assignment[1]}\\s*\\.\\s*(?:arrayBuffer|blob)\\s*\\(`),
        `${entry}: a GM bridge response must never be read as binary bytes`);
    }
  }
  console.log('issue-5015-gmfetch-binary-body: ok');
} finally {
  globalThis.fetch = originalFetch;
  if (originalGM === undefined) delete globalThis.GM; else globalThis.GM = originalGM;
  if (originalLocation === undefined) delete globalThis.location;
  else Object.defineProperty(globalThis, 'location', { value: originalLocation, configurable: true, writable: true });
  Object.defineProperty(URL, 'createObjectURL', { value: originalCreateObjectURL, configurable: true, writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: originalRevokeObjectURL, configurable: true, writable: true });
  delete globalThis.Worker;
  delete globalThis.addEventListener;
  delete globalThis.__HEX_NATIVE_FETCH__;
}
