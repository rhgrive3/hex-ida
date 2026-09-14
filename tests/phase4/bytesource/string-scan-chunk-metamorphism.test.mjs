import assert from 'node:assert/strict';
import { scanSourceStrings } from '../../../js/bytesource/strings.js';

// Differential chunking is a metamorphic check, not an independent parser.
// TextDecoder(fatal:true) additionally verifies every emitted raw byte span.
let seed = 0x51ca11ab;
const random = (limit) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
const utf8Tokens = ['A', 'z', 'é', '中', '😀', '\t', '\0', '\u007f', '\u0085', '\ufeff'];
const utf16Tokens = ['\u0100', 'Q', 'é', '語', '😀', '\0', '\u007f', '\u0085', '\ud800', '\udfff'];
const ceilings = [1, 2, 3, 5, 8, 13];
let cases = 0;
let spans = 0;
const order = (a, b) => a.fileOffset < b.fileOffset ? -1 : a.fileOffset > b.fileOffset ? 1 : a.encoding < b.encoding ? -1 : a.encoding > b.encoding ? 1 : 0;

for (let fixture = 0; fixture < 128; fixture++) {
  for (const encoding of ['utf8', 'utf16le', 'utf16be']) {
    let payload;
    if (fixture % 4 === 0) {
      payload = Uint8Array.from({ length: random(80) }, () => random(256));
    } else {
      const tokens = encoding === 'utf8' ? utf8Tokens : utf16Tokens;
      const text = Array.from({ length: random(35) }, () => tokens[random(tokens.length)]).join('');
      if (encoding === 'utf8') payload = new TextEncoder().encode(text);
      else {
        const bytes = Buffer.from(text, 'utf16le');
        if (encoding === 'utf16be') bytes.swap16();
        payload = Uint8Array.from(bytes);
      }
    }
    const base = (1n << 60n) + BigInt(fixture * 101);
    const image = {
      sections: [{ name: 'data', fileOffset: base, fileSize: BigInt(payload.length), perms: { execute: false } }],
      segments: [], endian: encoding === 'utf16be' ? 'big' : 'little',
      offsetToAddress(offset) { return offset - base + 0x1000n; },
    };
    const options = { utf16: encoding === 'utf8' ? false : encoding, minLength: 2 + fixture % 3, maxLength: 4 + fixture % 9 };
    const whole = {
      size: base + BigInt(payload.length), maxReadLength: Math.max(1, payload.length),
      async read(offset, length) {
        assert.ok(offset >= base && offset + BigInt(length) <= this.size);
        return payload.subarray(Number(offset - base), Number(offset - base) + length);
      },
    };
    const expected = await scanSourceStrings(image, whole, options);
    const expectedRows = [...expected.results].sort(order);
    assert.equal(expected.cancelled, false);
    assert.equal(expected.capped, false);
    for (const maxReadLength of ceilings) {
      for (const type of ['uint8', 'buffer', 'dataview']) {
        const buffer = Buffer.alloc(maxReadLength + 4);
        const scratch = buffer.subarray(2, maxReadLength + 2);
        const source = {
          size: whole.size, maxReadLength,
          async read(offset, length) {
            assert.ok(offset >= base && offset + BigInt(length) <= this.size);
            assert.ok(length <= maxReadLength);
            const part = payload.subarray(Number(offset - base), Number(offset - base) + length);
            if (type === 'uint8') return part;
            scratch.fill(0xff);
            scratch.set(part);
            if (type === 'buffer') return scratch.subarray(0, length);
            return new DataView(scratch.buffer, scratch.byteOffset, length);
          },
        };
        const actual = await scanSourceStrings(image, source, options);
        const label = `fixture=${fixture} encoding=${encoding} ceiling=${maxReadLength} type=${type}`;
        assert.equal(actual.cancelled, false, label);
        assert.equal(actual.capped, false, label);
        assert.deepEqual([...actual.results].sort(order), expectedRows, label);
        for (const row of actual.results) {
          const start = Number(row.fileOffset - base);
          assert.ok(start >= 0 && row.byteLength > 0 && start + row.byteLength <= payload.length, label);
          const decoder = new TextDecoder(row.encoding === 'utf8' ? 'utf-8' : row.encoding === 'utf16le' ? 'utf-16le' : 'utf-16be', { fatal: true });
          assert.equal(row.text, decoder.decode(payload.subarray(start, start + row.byteLength)), label);
          assert.equal(row.address, row.fileOffset - base + 0x1000n, label);
          spans++;
        }
        cases++;
      }
    }
  }
}
assert.equal(cases, 6912);
console.log(`string-scan-chunk-metamorphism: PASS (${cases} chunk/type cases; ${spans} native-decoder span checks)`);
