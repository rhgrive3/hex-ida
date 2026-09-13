import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import url from 'node:url';

/* #5381: scanStrings() stored only MAX_STRING_CHARS*4 (1600) bytes per run and
   published the stored prefix as a complete string — long valid strings lost
   their suffix silently (capped:false, no truncated flag), and distinct
   strings sharing a 1600-byte prefix collapsed into identical text.
   #5376: the UTF-8 validators only checked 10xxxxxx continuation shapes, so
   overlong encodings (E0 80 80), UTF-16 surrogates (ED A0 80) and sequences
   beyond U+10FFFF (F4 90 80 80) passed as "valid" and the non-fatal decoder
   laundered them into U+FFFD display strings. */

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const context = vm.createContext({
  console, performance, URL, URLSearchParams, TextDecoder, TextEncoder, Blob,
  Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int32Array,
  BigUint64Array, BigInt64Array, DataView, ArrayBuffer, SharedArrayBuffer,
  BigInt, Map, Set, WeakMap, WeakSet, Promise, Object, Array, Math, Number,
  String, Boolean, RegExp, Error, TypeError, RangeError, JSON, Date,
  setTimeout, clearTimeout, queueMicrotask,
});
context.self = context;
context.globalThis = context;
context.self.postMessage = () => {};
context.importScripts = () => {};
for (const file of ['js/macho.js', 'js/words.js', 'js/worker-budget.js', 'js/worker-legacy.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}

function scan(bytes) {
  context.__bytes = bytes;
  return vm.runInContext(`(async () => {
    blocks.clear();
    fileSize = BigInt(__bytes.length);
    file = {
      size: __bytes.length,
      slice(start, end) {
        const copy = __bytes.slice(Number(start), Number(end));
        return { arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) };
      },
    };
    regions = new Map();
    regions.set('r1', { id: 'r1', section: '__cstring', cstrings: true, vmAddr: 0x1000n, fileOffset: 0n, size: BigInt(__bytes.length) });
    currentEpoch = 0;
    return scanStrings({ regionId: 'r1', min: 2 });
  })()`, context);
}

const decodeText = (bytes) => {
  context.__textBytes = bytes;
  return vm.runInContext('decodeUtf8Text(__textBytes)', context);
};

{
  const bytes = new TextEncoder().encode('A'.repeat(1599) + '\0');
  const { results } = await scan(bytes);
  assert.equal(results.length, 1);
  assert.equal(results[0].text, 'A'.repeat(1599));
  assert.equal(results[0].byteLength, 1599);
  assert.equal(results[0].truncated, undefined, 'a 1599-byte run is stored whole: not truncated');
}
{
  const bytes = new TextEncoder().encode('A'.repeat(1600) + '\0');
  const { results } = await scan(bytes);
  assert.equal(results[0].truncated, undefined, 'a 1600-byte run is stored whole: not truncated');
  assert.equal(results[0].byteLength, 1600);
}
{
  const bytes = new TextEncoder().encode('A'.repeat(1600) + 'UNIQUE_SUFFIX' + '\0');
  const { results } = await scan(bytes);
  assert.equal(results.length, 1);
  assert.equal(results[0].truncated, true, 'a 1613-byte run exceeds the 1600-byte store: truncated must be flagged');
  assert.equal(results[0].byteLength, 1613, 'byteLength keeps the raw run extent (#5698), not the stored prefix');
  assert.ok(results[0].text.endsWith('A'), 'the stored prefix stays char-aligned ASCII');
}
{
  const bytes = new TextEncoder().encode('A'.repeat(1600) + 'TYPE_ONE\0' + 'A'.repeat(1600) + 'TYPE_TWO\0');
  const { results } = await scan(bytes);
  assert.equal(results.length, 2, 'both prefix-sharing strings are separate scan results');
  for (const entry of results) {
    assert.equal(entry.truncated, true, 'each 1608-byte run is flagged truncated');
    assert.equal(entry.byteLength, 1608, 'each raw extent is carried');
  }
}
{
  const bytes = new TextEncoder().encode('あ'.repeat(534) + '\0');
  const { results } = await scan(bytes);
  assert.equal(results.length, 1);
  assert.equal(results[0].truncated, true, 'the 1602-byte multibyte run exceeds the byte cap: flagged');
  assert.equal(results[0].byteLength, 1602);
  assert.equal(results[0].text, 'あ'.repeat(533), 'no partial code point is stored at the cap');
  assert.ok(!results[0].text.includes('\uFFFD'), 'the truncated prefix never ends in a replacement char');
}

{
  for (const character of ['é', 'あ', '😀']) {
    const prefix = 'A'.repeat(1599);
    const source = prefix + character + 'B';
    const { results } = await scan(new TextEncoder().encode(source + '\0' + 'NEXT\0'));
    assert.equal(results[0].text, prefix, 'after clipping a code point, later smaller characters cannot enter the stored prefix');
    assert.equal(results[0].byteLength, new TextEncoder().encode(source).length);
    assert.equal(results[0].truncated, true);
    assert.equal(results[1].text, 'NEXT', 'clipping state resets for the next run');
    assert.equal(results[1].truncated, undefined);
    assert.equal(results[1].byteLength, 4);
  }
}

{
  const malformed = [
    ['overlong 3-byte', [0xe0, 0x80, 0x80]],
    ['surrogate', [0xed, 0xa0, 0x80]],
    ['overlong 4-byte', [0xf0, 0x80, 0x80, 0x80]],
    ['beyond U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
  ];
  for (const [label, seq] of malformed) {
    const bytes = Uint8Array.from([...seq, ...seq, 0x00]);
    const { results } = await scan(bytes);
    assert.equal(results.length, 0, `${label} must not become a scanned string`);
    assert.equal(decodeText(Uint8Array.from(seq)), '', `${label} decodes as nothing (#5376)`);
  }
  assert.equal(decodeText(new TextEncoder().encode('あい')), 'あい', 'valid 3-byte sequences decode');
  assert.equal(decodeText(Uint8Array.from([0xed, 0x80, 0x80])), '\uD000', 'ED 80 80 (U+D000, non-surrogate) stays valid');
  assert.equal(decodeText(Uint8Array.from([0xf4, 0x8f, 0xbf, 0xbf])), '\u{10FFFF}', 'F4 8F BF BF (U+10FFFF) stays valid');
  assert.equal(decodeText(Uint8Array.from([0xc2, 0x80])), '\u0080', 'C2 80 (U+0080) stays valid');
  assert.equal(decodeText(Uint8Array.from([0xc1, 0x80])), '', 'C1 80 (overlong 2-byte) is rejected');
  assert.equal(decodeText(Uint8Array.from([0xe0, 0x9f, 0xbf])), '', 'E0 9F BF (overlong 3-byte) is rejected');
  assert.equal(decodeText(Uint8Array.from([0xf0, 0x8f, 0xbf, 0xbf])), '', 'F0 8F BF BF (overlong 4-byte) is rejected');
  const scanResult = await scan(new TextEncoder().encode('あいう'));
  assert.equal(scanResult.results.length, 1, 'valid multibyte strings still scan');
  assert.equal(scanResult.results[0].text, 'あいう');
}

console.log('issue-5381-5376 string scan truncation + utf8 well-formedness: ok');
