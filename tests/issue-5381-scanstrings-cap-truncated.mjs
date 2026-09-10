// Issue #5381 regression: scanStrings() stored only MAX_STRING_CHARS*4 bytes
// (~1600) of a longer run and returned the prefix as if it were the complete
// string. The per-result entry must carry truncated:true so callers can never
// treat a display-budget prefix as full string identity.
import assert from 'node:assert/strict';
import { NodeBackend } from './harness.mjs';

const longString = 'A'.repeat(1600) + 'UNIQUE_SUFFIX';
const bytes = new TextEncoder().encode(longString + '\0' + 'B'.repeat(1600) + 'TYPE_TWO' + '\0');
const file = {
  name: 'issue-5381.bin',
  size: bytes.length,
  slice(start, end) {
    const part = bytes.subarray(start, end);
    return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
  },
};

const backend = new NodeBackend();
const info = await backend.open(file);
const regionId = info.raw.id;
const res = await backend.strings({ regionId, min: 4, limit: 20 });
assert.equal(res.cancelled, false);
assert.equal(res.capped, false, 'a per-string cap is not a result-count cap');
assert.equal(res.results.length, 2, 'both NUL-terminated runs are found');

const [first, second] = res.results;
assert.equal(first.text, 'A'.repeat(1600), 'only the stored prefix is returned');
assert.equal(first.truncated, true, 'the prefix entry must be flagged truncated, not passed off as the complete string');
assert.equal(first.text.includes('UNIQUE_SUFFIX'), false);
assert.equal(second.truncated, true, 'the second over-cap run is flagged too');
assert.equal(second.text, 'B'.repeat(1600));

// Review-required threshold matrix: truncation is a BYTE cap at
// MAX_STRING_CHARS*4 = 1600 bytes, so 1599 and exactly-1600 byte runs stay
// complete and 1601 bytes flips the flag. A future regression that marks
// every run truncated (or never marks it) must fail here.
const enc = new TextEncoder();
const runs = [
  ['A'.repeat(1599), false],
  ['B'.repeat(1600), false],
  ['C'.repeat(1601), true],
  ['P'.repeat(1600) + 'SUFFIX_ONE', true],
  ['P'.repeat(1600) + 'SUFFIX_TWO', true],
];
const thresholdBytes = new Uint8Array(runs.map(([text]) => enc.encode(text + '\0')).flatMap((u) => [...u]));
const thresholdFile = {
  name: 'issue-5381-thresholds.bin',
  size: thresholdBytes.length,
  slice(start, end) {
    const part = thresholdBytes.subarray(start, end);
    return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
  },
};
const thresholdBackend = new NodeBackend();
const thresholdInfo = await thresholdBackend.open(thresholdFile);
const thresholdRes = await thresholdBackend.strings({ regionId: thresholdInfo.raw.id, min: 4, limit: 20 });
assert.equal(thresholdRes.cancelled, false);
assert.equal(thresholdRes.capped, false);
assert.equal(thresholdRes.results.length, runs.length, 'each run is its own result, in offset order');
for (const [index, [text, truncated]] of runs.entries()) {
  const entry = thresholdRes.results[index];
  assert.equal(entry.truncated, truncated,
    `run of ${enc.encode(text).length} bytes must report truncated:${truncated}`);
  assert.equal(entry.text, text.slice(0, 1600),
    'stored text is the raw run prefix up to the 1600-byte cap');
}
// The two over-cap runs share their full 1600-byte prefix but are distinct
// strings: both must be found, and neither may leak its suffix into evidence.
const [one, two] = thresholdRes.results.slice(3, 5);
assert.notEqual(one.offset, two.offset, 'same-prefix runs stay distinct results');
assert.equal(one.text.includes('SUFFIX'), false);
assert.equal(two.text.includes('SUFFIX'), false);

// Multibyte boundary: the cap counts BYTES, not characters or code points.
// 500 x 'あ' is 1500 bytes (500 characters > MAX_STRING_CHARS=400) and stays
// complete; 401 x U+10FFFF is 1604 bytes and truncates at exactly 400
// characters (1600 stored bytes).
const multibyteBytes = new Uint8Array([
  ...enc.encode('あ'.repeat(500)), 0,
  ...enc.encode('\u{10FFFF}'.repeat(401)), 0,
]);
const multibyteFile = {
  name: 'issue-5381-multibyte-boundary.bin',
  size: multibyteBytes.length,
  slice(start, end) {
    const part = multibyteBytes.subarray(start, end);
    return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
  },
};
const multibyteBackend = new NodeBackend();
const multibyteInfo = await multibyteBackend.open(multibyteFile);
const multibyteRes = await multibyteBackend.strings({ regionId: multibyteInfo.raw.id, min: 4, limit: 20 });
assert.equal(multibyteRes.cancelled, false);
assert.equal(multibyteRes.results.length, 2);
const [threeByteRun, fourByteRun] = multibyteRes.results;
assert.equal(threeByteRun.text, 'あ'.repeat(500));
assert.equal(threeByteRun.truncated, false,
  '1500 bytes is under the byte cap even though 500 characters exceed the 400-character name budget');
assert.equal(fourByteRun.truncated, true, '1604 bytes crosses the 1600-byte cap');
assert.equal(fourByteRun.text, '\u{10FFFF}'.repeat(400), 'exactly 400 four-byte characters (1600 bytes) are stored');
assert.equal([...fourByteRun.text].length, 400, 'code-point count is capped at 400 (U+10FFFF is a surrogate pair)');

// Cross-cap code points: a code point that does not fit the remaining
// capacity is never stored in part. Appending whole code points while only
// checking the PRE-append length stored 1599+4 = 1603 bytes as
// truncated:false when the run ended right after — over the declared
// 1600-byte cap. Both must flag truncated:true with a <=1600-byte valid
// UTF-8 prefix.
const crossCapBytes = new Uint8Array([
  ...enc.encode('A'.repeat(1599) + '\u{10FFFF}'), 0,
  ...enc.encode('B'.repeat(1598) + 'あ'), 0,
]);
const crossCapFile = {
  name: 'issue-5381-cross-cap-codepoint.bin',
  size: crossCapBytes.length,
  slice(start, end) {
    const part = crossCapBytes.subarray(start, end);
    return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
  },
};
const crossCapBackend = new NodeBackend();
const crossCapInfo = await crossCapBackend.open(crossCapFile);
const crossCapRes = await crossCapBackend.strings({ regionId: crossCapInfo.raw.id, min: 4, limit: 20 });
assert.equal(crossCapRes.cancelled, false);
assert.equal(crossCapRes.results.length, 2);
const [asciiPlus4Byte, asciiPlus3Byte] = crossCapRes.results;
assert.equal(asciiPlus4Byte.text, 'A'.repeat(1599),
  'the 4-byte code point at 1599 stored bytes does not fit; it is not stored in part');
assert.equal(asciiPlus4Byte.truncated, true,
  '1603 bytes would exceed the 1600-byte cap: the run is truncated even though nothing was flushed past the cap');
assert.ok(enc.encode(asciiPlus4Byte.text).length <= 1600 && asciiPlus4Byte.byteLength <= 1600);
assert.equal(asciiPlus3Byte.text, 'B'.repeat(1598),
  'the 3-byte code point at 1598 stored bytes does not fit (1598+3=1601 > 1600)');
assert.equal(asciiPlus3Byte.truncated, true);
assert.ok(enc.encode(asciiPlus3Byte.text).length <= 1600 && asciiPlus3Byte.byteLength <= 1600);

console.log('issue #5381 scanStrings per-string truncation flag regressions: PASS');
