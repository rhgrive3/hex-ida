import assert from 'node:assert/strict';

import { readSwiftMangledName } from '../js/swift.js';

function readerFor(bytes) {
  return async (_addr, len) => bytes.subarray(0, len);
}

// kind 0x18 = symbolic reference with pointer-sized payload.
const fourBytePayload = Uint8Array.from([0x18, 0x34, 0x12, 0x00, 0x00, 0x00]);
const eightBytePayload = Uint8Array.from([0x18, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

const malformedWidths = [['4'], '4', true, false, 4.5, '8', {}, ['8'], 3, 16, BigInt(4)];

await Promise.all(malformedWidths.map(async (malformed) => {
  await assert.rejects(
    () => readSwiftMangledName(readerFor(eightBytePayload), 0x1000n, { compilerMetadata: true, pointerBytes: malformed }),
    /swift-invalid-pointer-bytes/,
    `pointerBytes ${String(malformed)} must fail closed`,
  );
  await assert.rejects(
    () => readSwiftMangledName(readerFor(eightBytePayload), 0x1000n, { compilerMetadata: true, pointerSize: malformed }),
    /swift-invalid-pointer-bytes/,
    `pointerSize ${String(malformed)} must fail closed`,
  );
}));

const as4 = await readSwiftMangledName(readerFor(fourBytePayload), 0x1000n, { compilerMetadata: true, pointerBytes: 4 });
assert.equal(as4.complete, true, 'canonical 4 must parse 4-byte symbolic payloads');
assert.equal(as4.reason ?? null, null);

const truncatedAs8 = await readSwiftMangledName(readerFor(fourBytePayload), 0x1000n, { compilerMetadata: true, pointerBytes: 8 });
assert.equal(truncatedAs8.complete, false);
assert.equal(truncatedAs8.reason, 'symbolic-reference-truncated');

const as8 = await readSwiftMangledName(readerFor(eightBytePayload), 0x1000n, { compilerMetadata: true, pointerBytes: 8 });
assert.equal(as8.complete, true, 'canonical 8 must parse 8-byte symbolic payloads');

const byDefault = await readSwiftMangledName(readerFor(eightBytePayload), 0x1000n, { compilerMetadata: true });
assert.equal(byDefault.complete, true, 'unset pointer width keeps the 8-byte default');
const byDefaultPointerSize = await readSwiftMangledName(readerFor(eightBytePayload), 0x1000n, { compilerMetadata: true, pointerSize: 8 });
assert.equal(byDefaultPointerSize.complete, true, 'canonical pointerSize 8 keeps working');

const fourAs8 = await readSwiftMangledName(readerFor(eightBytePayload), 0x1000n, { compilerMetadata: true, pointerBytes: 4 });
assert.equal(fourAs8.complete, true, 'explicit 4 on an 8-byte record consumes only the first 4 payload bytes');

const withoutMetadata = await readSwiftMangledName(readerFor(fourBytePayload), 0x1000n, { pointerBytes: 4 });
assert.equal(withoutMetadata.complete, false);
assert.equal(withoutMetadata.reason, 'symbolic-reference-not-authorized');

console.log('#5871 swift pointer width fail-closed: PASS');
