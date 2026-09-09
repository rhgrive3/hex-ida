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

// The same root cause in decodeUtf8Text()/readAtAddress({text:true}).
const overlongOffset = 2; // right after 'AB'
const read = await backend.readAt(0n + BigInt(overlongOffset), 16, true);
assert.equal(read?.text ?? read, 'AB', 'readAt text decode must stop at the invalid lead constraint, not emit U+FFFD');

console.log('issue #5376 utf-8 well-formedness gate regressions: PASS');
