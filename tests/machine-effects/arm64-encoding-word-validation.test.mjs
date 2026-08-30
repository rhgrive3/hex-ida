import assert from 'node:assert/strict';

import {
  arm64DecodedEncodingWord,
  arm64EncodingWord,
} from '../../js/targets/architecture/arm64/encoding-word.js';

const word = 0xd69f0bff;
const bytes = [0xff, 0x0b, 0x9f, 0xd6];

assert.equal(arm64EncodingWord(bytes, 0), word);
assert.equal(arm64EncodingWord(Uint8Array.from(bytes), 0), word);
assert.equal(arm64EncodingWord([0, 0, 0, 0, ...bytes], 1), word);
assert.equal(arm64DecodedEncodingWord({ rawBytes:bytes }), word);
assert.equal(arm64DecodedEncodingWord({ bytes:Uint8Array.from(bytes) }), word);
assert.equal(arm64DecodedEncodingWord({ word }), word);
assert.equal(arm64DecodedEncodingWord({ encodingWord:BigInt(word) }), word);

const malformedByteRuns = [
  ['255', 0x0b, 0x9f, 0xd6],
  [true, 0x0b, 0x9f, 0xd6],
  [false, 0x0b, 0x9f, 0xd6],
  [-1, 0x0b, 0x9f, 0xd6],
  [256, 0x0b, 0x9f, 0xd6],
  [1.5, 0x0b, 0x9f, 0xd6],
  [NaN, 0x0b, 0x9f, 0xd6],
  [Infinity, 0x0b, 0x9f, 0xd6],
  [{ valueOf() { return 0xff; } }, 0x0b, 0x9f, 0xd6],
  new Array(4),
];

for (const malformed of malformedByteRuns) {
  assert.equal(arm64EncodingWord(malformed, 0), null);
  assert.equal(arm64DecodedEncodingWord({ rawBytes:malformed }), null);
  assert.equal(arm64DecodedEncodingWord({ bytes:malformed }), null);
}

assert.equal(arm64EncodingWord([0xff, 0x0b, 0x9f], 0), null);
assert.equal(arm64EncodingWord(bytes, 1), null);
assert.equal(arm64EncodingWord(bytes, -1), null);
assert.equal(arm64EncodingWord(bytes, 0.5), null);
assert.equal(arm64DecodedEncodingWord({ rawBytes:[0xff, 0x0b, 0x9f] }), null);
assert.equal(arm64DecodedEncodingWord({ word:'0xd69f0bff' }), null);
assert.equal(arm64DecodedEncodingWord({ word:-1 }), null);
assert.equal(arm64DecodedEncodingWord({ word:0x1_0000_0000 }), null);

console.log('ARM64 encoding-word byte validation: PASS');
