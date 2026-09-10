// Issue #5376 regression: the UTF-8 run validators (scanStrings utf8Len +
// decodeUtf8Text) checked only that continuation bytes had 10xxxxxx shape, so
// overlong encodings, UTF-16 surrogates, and >U+10FFFF sequences were accepted
// and non-fatally decoded into U+FFFD "strings" from arbitrary binary bytes.
import assert from 'node:assert/strict';
import { NodeBackend } from './harness.mjs';

const enc = new TextEncoder();
// Invalid sequences from the issue, interleaved with valid ASCII runs.
const bytes = new Uint8Array([
  ...enc.encode('AB'),
  0xE0, 0x80, 0x80,          // overlong 3-byte (E0 must be followed by A0..BF)
  ...enc.encode('CD'), 0,
  0xED, 0xA0, 0x80,          // UTF-16 surrogate (ED must be followed by 80..9F)
  ...enc.encode('EF'), 0,
  0xF0, 0x80, 0x80, 0x80,    // overlong 4-byte (F0 must be followed by 90..BF)
  ...enc.encode('GH'), 0,
  0xF4, 0x90, 0x80, 0x80,    // > U+10FFFF (F4 must be followed by 80..8F)
  ...enc.encode('IJ'), 0,
  // Well-formed boundary sequences that must KEEP decoding:
  ...enc.encode('\u0800\uD7FF\u{10000}\u{10FFFF}'), 0,
  ...enc.encode('攻撃報酬'), 0,
]);
const file = {
  name: 'issue-5376.bin',
  size: bytes.length,
  slice(start, end) {
    const part = bytes.subarray(start, end);
    return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
  },
};

const backend = new NodeBackend();
const info = await backend.open(file);
const regionId = info.raw.id;
const res = await backend.strings({ regionId, min: 2, limit: 50 });
assert.equal(res.cancelled, false);
const texts = res.results.map((r) => r.text);
for (const text of texts) {
  assert.ok(!text.includes('\uFFFD'), `no replacement character may be minted, got ${JSON.stringify(text)}`);
}
assert.ok(texts.includes('AB'), 'the run before the overlong sequence stays its own string');
assert.ok(texts.includes('CD'), 'invalid sequence terminates the run instead of merging');
assert.ok(texts.includes('EF') && texts.includes('GH') && texts.includes('IJ'));
assert.ok(texts.includes('\u0800\uD7FF\u{10000}\u{10FFFF}'), 'well-formed boundary sequences still decode');
assert.ok(texts.includes('攻撃報酬'), 'ordinary multi-byte UTF-8 still decodes');

// The same root cause in decodeUtf8Text()/readAtAddress({text:true}). The
// production readAt text path delegates to decodeUtf8Text on the booted
// classic worker (readAt itself cannot resolve raw-region addresses:
// vmToFile skips the 'raw' region), so assert that exact function with
// real bytes: an invalid lead constraint must stop the decode, never mint
// U+FFFD, and a well-formed sequence must keep decoding.
const decodeText = globalThis.decodeUtf8Text;
assert.equal(typeof decodeText, 'function', 'classic worker must expose decodeUtf8Text');
assert.equal(decodeText(new Uint8Array([0x41, 0x42, 0xE0, 0x80, 0x80, 0x43, 0x44])), 'AB',
  'overlong E0 80 80 stops the run instead of emitting U+FFFD');
assert.equal(decodeText(new Uint8Array([0x41, 0x42, 0xED, 0xA0, 0x80, 0x43])), 'AB',
  'UTF-16 surrogate ED A0 80 stops the run');
assert.equal(decodeText(new Uint8Array([0x41, 0x42, 0xF0, 0x80, 0x80, 0x80, 0x43])), 'AB',
  'overlong F0 80 80 80 stops the run');
assert.equal(decodeText(new Uint8Array([0x41, 0x42, 0xF4, 0x90, 0x80, 0x80, 0x43])), 'AB',
  'beyond-U+10FFFF F4 90 stops the run');
assert.equal(decodeText(new Uint8Array([0x41, 0x42, 0xC3, 0xA9, 0x43, 0x44])), 'ABéCD',
  'well-formed 2-byte sequences still decode');

// Review-required scan-path controls: a truncated multibyte sequence must
// never be promoted to string evidence — neither at the tail of the region
// nor when it spans a scan-block boundary (carry re-validation).
const tailBytes = new Uint8Array([...enc.encode('TAIL'), 0, 0xE3, 0x81]);
const tailFile = {
  name: 'issue-5376-tail.bin',
  size: tailBytes.length,
  slice(start, end) {
    const part = tailBytes.subarray(start, end);
    return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
  },
};
const tailBackend = new NodeBackend();
const tailInfo = await tailBackend.open(tailFile);
const tailRes = await tailBackend.strings({ regionId: tailInfo.raw.id, min: 2, limit: 50 });
assert.equal(tailRes.cancelled, false);
assert.deepEqual(tailRes.results.map((r) => r.text), ['TAIL'],
  'the incomplete 3-byte sequence at EOF is dropped, not decoded or promoted');

// Block-boundary control: an incomplete sequence whose bytes straddle the
// SCAN_BLOCK boundary must fail closed after the carry merge. Layout: short
// valid runs, an E3 81 pair ending exactly at the 1MiB block edge, an invalid
// continuation (0x41) opening the next block, then a valid run, then an
// incomplete 4-byte sequence at EOF.
const SCAN_BLOCK = 1024 * 1024;
const blockBytes = new Uint8Array(SCAN_BLOCK + 16);
blockBytes.set(enc.encode('ok'), 0);
blockBytes.set([0xE3, 0x81], SCAN_BLOCK - 2);
blockBytes.set(enc.encode('AB'), SCAN_BLOCK);
blockBytes.set([0], SCAN_BLOCK + 2);
blockBytes.set([0xF0, 0x90], SCAN_BLOCK + 3);
const blockFile = {
  name: 'issue-5376-block-boundary.bin',
  size: blockBytes.length,
  slice(start, end) {
    const part = blockBytes.subarray(start, end);
    return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
  },
};
const blockBackend = new NodeBackend();
const blockInfo = await blockBackend.open(blockFile);
const blockRes = await blockBackend.strings({ regionId: blockInfo.raw.id, min: 2, limit: 50 });
assert.equal(blockRes.cancelled, false);
const blockTexts = blockRes.results.map((r) => r.text);
for (const text of blockTexts) {
  assert.ok(!text.includes('\uFFFD'), `no replacement character may be minted, got ${JSON.stringify(text)}`);
  assert.ok(!text.includes('あ'), 'no partial multibyte sequence may be decoded into string evidence');
}
assert.ok(blockTexts.includes('ok'), 'the run before the boundary stays its own string');
assert.ok(blockTexts.includes('AB'), 'the invalid continuation drops the carried sequence; AB is not merged into it');
assert.deepEqual(blockTexts, ['ok', 'AB'], 'only the two valid runs are evidence');

console.log('issue #5376 utf-8 well-formedness gate regressions: PASS');
