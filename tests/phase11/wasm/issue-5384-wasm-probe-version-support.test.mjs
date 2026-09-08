import assert from 'node:assert/strict';
import { parseWasm, probeWasm } from '../../../js/managed/wasm/parser.js';
import { probeManagedFrontend, openManagedImage } from '../../../js/managed/index.js';

const header = (version) => Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d,
  version & 0xff,
  (version >>> 8) & 0xff,
  (version >>> 16) & 0xff,
  (version >>> 24) & 0xff,
]);

const wasmV1 = header(1);
const wasmV0 = header(0);
const wasmV2 = header(2);
const wasmFuture = header(0xffffffff);
const invalidMagic = Uint8Array.from([0x00, 0x61, 0x73, 0x00, 0x01, 0, 0, 0]);

assert.equal(probeWasm(wasmV1).supported, true, 'version 1 must remain supported');
for (const bytes of [wasmV0, wasmV2, wasmFuture]) {
  assert.equal(probeWasm(bytes).supported, false, 'recognized but unsupported WASM version must fail closed');
}
const directV2Probe = probeWasm(wasmV2);
assert.equal(directV2Probe.formatVersion, '2');
assert.equal(directV2Probe.reason, 'unsupported-version');
assert.equal(directV2Probe.vmSpecEdition, 'unknown');
assert.throws(() => parseWasm(wasmV2), /wasm-unsupported-version/);
assert.throws(() => parseWasm(wasmFuture), /wasm-unsupported-version/);
const v2ArrayBuffer = wasmV2.buffer.slice(wasmV2.byteOffset, wasmV2.byteOffset + wasmV2.byteLength);
assert.equal(probeWasm(v2ArrayBuffer).supported, false, 'ArrayBuffer input must use the same support matrix');
assert.equal(probeWasm(invalidMagic).supported, false, 'invalid magic must remain unsupported');

// The WASM probe remains non-authoritative for sibling managed formats, so
// their later routing slots are not shadowed by this change.
const dexPrefix = Uint8Array.from([0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0x00]);
const jvmPrefix = Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x3d]);
const cilPrefix = Uint8Array.from([0x4d, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
for (const bytes of [dexPrefix, jvmPrefix, cilPrefix]) {
  assert.equal(probeWasm(bytes).supported, false, 'WASM probe must not shadow sibling managed frontends');
}

const routedV1 = await probeManagedFrontend(wasmV1);
assert.equal(routedV1.supported, true);
assert.equal(routedV1.frontendId, 'wasm');

const routedV2 = await probeManagedFrontend(wasmV2);
assert.equal(routedV2.supported, false, 'version 2 must not be advertised as open-capable');
assert.equal(routedV2.frontendId, null);

const openedV1 = await openManagedImage(wasmV1, { binaryId: 'issue-5384-v1' });
assert.equal(openedV1.formatVersion, '1');
await assert.rejects(
  () => openManagedImage(wasmV2, { binaryId: 'issue-5384-v2' }),
  (error) => error instanceof TypeError && error.message === 'managed-image-unsupported-format',
);

console.log('[phase11] issue #5384 wasm probe/open support matrix passed');
