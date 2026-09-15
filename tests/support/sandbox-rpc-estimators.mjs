/*
 * Shared harness for the sandbox RPC/input estimators (#5500, #8668).
 *
 * js/sandbox.js keeps one binary transport-size contract that both the Worker
 * preflight and the host ingress guard execute. These tests load that single
 * source text into both estimator realms so any drift between them fails here
 * instead of shipping.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const INPUT_BUDGET = 4 * 1024 * 1024;
export const OUTPUT_BUDGET = 16 * 1024 * 1024;

const NATIVES = [
  'const nativeSetHas = Function.prototype.call.bind(Set.prototype.has);\n',
  'const nativeSetAdd = Function.prototype.call.bind(Set.prototype.add);\n',
  'const nativeSetDelete = Function.prototype.call.bind(Set.prototype.delete);\n',
  'const nativeArrayBufferByteLength = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get);\n',
  'const nativeTypedArrayBuffer = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "buffer").get);\n',
  'const nativeDataViewBuffer = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(DataView.prototype, "buffer").get);\n',
];

const TRANSPORT_MATCH = /function binaryTransportBytes\(value, buffers, N\) \{[\s\S]*?\n\}\n/;

function transportNatives(name) {
  return `const ${name} = Object.freeze({
    bufferByteLength: nativeArrayBufferByteLength,
    typedArrayBuffer: nativeTypedArrayBuffer,
    dataViewBuffer: nativeDataViewBuffer,
    isView: nativeArrayBufferIsView,
    has: nativeSetHas,
    add: nativeSetAdd,
  });\n`;
}

export function readSandboxSource() {
  return fs.readFileSync(path.join(ROOT, 'js/sandbox.js'), 'utf8');
}

/*
 * Rebuilds the exact program text that ships to the untrusted Worker, so a test
 * can prove the shared binary transport contract really is injected into that
 * realm instead of only existing in the host module.
 */
export function buildWorkerProgram(body = '') {
  const source = readSandboxSource();
  const contractStart = source.indexOf('function binaryTransportBytes');
  const preludeStart = source.indexOf('const WORKER_PRELUDE = String.raw`');
  const postludeStart = source.indexOf('const WORKER_POSTLUDE = String.raw`');
  const postludeEnd = source.indexOf('`;', postludeStart);
  assert.ok(contractStart >= 0, 'shared binary transport contract must exist');
  assert.ok(preludeStart > contractStart, 'Worker prelude must follow the shared contract');
  assert.ok(postludeEnd > postludeStart, 'Worker postlude must remain extractable');
  const slice = source.slice(contractStart, postludeEnd + 2);
  const realm = new Function(
    `${slice}\nreturn { prelude: WORKER_PRELUDE, postlude: WORKER_POSTLUDE };`,
  )();
  return realm.prelude + body + realm.postlude;
}

export function loadSandboxRpcEstimators() {
  const source = readSandboxSource();
  const workerMatch = source.match(/  const measure = \(value, seen = new NativeSet\(\), limit = MAX_ARGUMENT_UNITS \+ 1, buffers = new NativeSet\(\)\) => \{[\s\S]*?\n  \};\n\n  const rpc/);
  const hostMatch = source.match(/function valueSize\(value, seen = new Set\(\), limit = MAX_RPC_OUTPUT_BYTES \+ 1, buffers = new Set\(\)\) \{[\s\S]*?\n\}\n\nfunction sandboxOutputSize/);
  const transportMatch = source.match(TRANSPORT_MATCH);
  assert.ok(workerMatch, 'worker RPC estimator must remain extractable');
  assert.ok(hostMatch, 'host RPC estimator must remain extractable');
  assert.ok(transportMatch, 'binary transport-size contract must remain extractable');
  const transportBody = transportMatch[0];
  const workerBody = workerMatch[0].replace(/\n\n  const rpc$/, '');
  const hostBody = hostMatch[0].replace(/\n\nfunction sandboxOutputSize$/, '');
  const cloneCalls = { count: 0 };
  const worker = new Function(
    'CLONE_CALLS',
    `const MAX_ARGUMENT_UNITS = ${INPUT_BUDGET};\n`
      + 'const NativeObjectPrototype = Object.prototype;\n'
      + 'const NativeSet = Set;\n'
      + 'const nativeArrayIsArray = Array.isArray.bind(Array);\n'
      + 'const nativeArrayBufferIsView = ArrayBuffer.isView.bind(ArrayBuffer);\n'
      + 'const nativeGetPrototypeOf = Object.getPrototypeOf.bind(Object);\n'
      + 'const nativeKeys = Object.keys.bind(Object);\n'
      + 'const nativeDescriptor = Object.getOwnPropertyDescriptor.bind(Object);\n'
      + 'const nativeStructuredClone = (v) => { CLONE_CALLS.count++; return globalThis.structuredClone(v); };\n'
      + NATIVES.join('')
      + `${transportBody}${transportNatives('BINARY_TRANSPORT_NATIVES_FOR_WORKER')}`
      + `${workerBody}\nreturn { measure, prepareRpcArgs };`,
  )(cloneCalls);
  const valueSize = new Function(
    `const MAX_RPC_OUTPUT_BYTES = ${OUTPUT_BUDGET};\n`
      + 'const nativeArrayBufferIsView = ArrayBuffer.isView.bind(ArrayBuffer);\n'
      + NATIVES.join('')
      + `${transportBody}${transportNatives('BINARY_TRANSPORT_NATIVES')}`
      + `${hostBody}\nreturn valueSize;`,
  )();
  return { ...worker, valueSize, cloneCalls };
}
