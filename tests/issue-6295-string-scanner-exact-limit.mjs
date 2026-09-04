import assert from 'node:assert/strict';
import { scanSourceStrings } from '../js/bytesource/strings.js';

const dummyImage = {
  sections: [],
  segments: [],
  endian: 'little',
  offsetToAddress(offset) { return offset; },
};

// 1. 1 string + limit:1 -> 1件, capped: false
{
  const bytes = new TextEncoder().encode('HELLO_WORLD\0');
  const res = await scanSourceStrings(dummyImage, bytes, { minLength: 4, limit: 1 });
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].text, 'HELLO_WORLD');
  assert.equal(res.capped, false, 'exact limit match without extra candidate must not be capped');
  assert.equal(res.cancelled, false);
}

// 2. 2 strings + limit:1 -> 1件, capped: true
{
  const bytes = new TextEncoder().encode('HELLO\0WORLD\0');
  const res = await scanSourceStrings(dummyImage, bytes, { minLength: 4, limit: 1 });
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].text, 'HELLO');
  assert.equal(res.capped, true, 'limit reached with remaining candidate must be capped');
  assert.equal(res.cancelled, false);
}

// 3. N strings + limit:N -> N件, capped: false
{
  const N = 5;
  const words = Array.from({ length: N }, (_, i) => `WORD_${i}`);
  const bytes = new TextEncoder().encode(words.join('\0') + '\0');
  const res = await scanSourceStrings(dummyImage, bytes, { minLength: 4, limit: N });
  assert.equal(res.results.length, N);
  assert.equal(res.capped, false, 'exact N strings with limit N must be capped: false');
}

// 4. N+1 strings + limit:N -> N件, capped: true
{
  const N = 5;
  const words = Array.from({ length: N + 1 }, (_, i) => `WORD_${i}`);
  const bytes = new TextEncoder().encode(words.join('\0') + '\0');
  const res = await scanSourceStrings(dummyImage, bytes, { minLength: 4, limit: N });
  assert.equal(res.results.length, N);
  assert.equal(res.capped, true, 'N+1 strings with limit N must be capped: true');
}

// 5. ASCII + UTF-16 combined global limit
{
  // 1 ASCII string ('ASCII_STR\0') and 1 UTF-16LE string ('UTF16_STR\0')
  const asciiBytes = new TextEncoder().encode('ASCII_STR\0');
  const utf16Bytes = new Uint8Array([
    0x55, 0x00, 0x31, 0x00, 0x36, 0x00, 0x53, 0x00, 0x54, 0x00, 0x52, 0x00, 0x00, 0x00,
  ]);
  const combined = new Uint8Array(asciiBytes.length + utf16Bytes.length);
  combined.set(asciiBytes, 0);
  combined.set(utf16Bytes, asciiBytes.length);

  // limit: 1 -> should cap on the second string (UTF-16)
  const res1 = await scanSourceStrings(dummyImage, combined, { minLength: 4, utf16: 'le', limit: 1 });
  assert.equal(res1.results.length, 1);
  assert.equal(res1.results[0].text, 'ASCII_STR');
  assert.equal(res1.capped, true);

  // limit: 2 -> both strings found, no 3rd candidate -> capped: false
  const res2 = await scanSourceStrings(dummyImage, combined, { minLength: 4, utf16: 'le', limit: 2 });
  assert.equal(res2.results.length, 2);
  assert.equal(res2.capped, false);
}

// 6. Sentinel across chunk boundary
{
  const chunkSize = 64;
  // Put 1 string in chunk 1, 1 string in chunk 2
  const bytes = new Uint8Array(128);
  bytes.set(new TextEncoder().encode('STRING_ONE\0'), 0);
  bytes.set(new TextEncoder().encode('STRING_TWO\0'), 64);

  const res = await scanSourceStrings(dummyImage, bytes, { minLength: 4, chunkSize, limit: 1 });
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].text, 'STRING_ONE');
  assert.equal(res.capped, true, 'sentinel candidate in chunk 2 correctly detected across chunk boundary');
}

// 7. Cancellation semantics preserved
{
  const ac = new AbortController();
  ac.abort();
  const bytes = new TextEncoder().encode('AAAA\0BBBB\0');
  const res = await scanSourceStrings(dummyImage, bytes, { signal: ac.signal, limit: 1 });
  assert.equal(res.cancelled, true);
  assert.equal(res.capped, false);
}

// 8. Results length <= limit always
{
  const bytes = new TextEncoder().encode('A_1111\0B_2222\0C_3333\0D_4444\0');
  for (const limit of [1, 2, 3]) {
    const res = await scanSourceStrings(dummyImage, bytes, { minLength: 4, limit });
    assert.ok(res.results.length <= limit);
    assert.equal(res.results.length, limit);
    assert.equal(res.capped, true);
  }
}

console.log('issue-6295 regression test: PASS');
