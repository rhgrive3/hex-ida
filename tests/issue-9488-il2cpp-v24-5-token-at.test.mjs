import assert from 'node:assert/strict';
import { parseMetadata, parseMetadataAuto, parseMetadataAutoAsync } from '../js/il2cpp.js';

const SANITY = 0xFAB11BAF;
const HEADER = 184;
const PAIR = { string: 2, methods: 5, typeDefinitions: 19 };

function buildFixture({ version, typeSize, methodSize, tokenAt }) {
  const nTypes = 2, nMethods = 2;
  const enc = new TextEncoder();
  const strings = [];
  const offsets = new Map();
  const add = (key, text) => { offsets.set(key, strings.length); strings.push(...enc.encode(text), 0); };
  for (let i = 0; i < nTypes; i++) { add(`t${i}`, `MyClass${i}`); add(`n${i}`, `MyNS${i}`); }
  for (let j = 0; j < nMethods; j++) add(`m${j}`, `MyMethod${j}`);
  const stringBytes = Uint8Array.from(strings);

  const stringOff = HEADER;
  const methodsOff = stringOff + stringBytes.length;
  const typeDefOff = methodsOff + nMethods * methodSize;
  const total = typeDefOff + nTypes * typeSize;
  const u8 = new Uint8Array(total);
  const dv = new DataView(u8.buffer);
  const put32 = (at, v) => dv.setUint32(at, v >>> 0, true);
  const putI32 = (at, v) => dv.setInt32(at, v | 0, true);

  put32(0, SANITY);
  putI32(4, version);

  const pairs = {
    [PAIR.string]: [stringOff, stringBytes.length],
    [PAIR.methods]: [methodsOff, nMethods * methodSize],
    [PAIR.typeDefinitions]: [typeDefOff, nTypes * typeSize],
  };
  for (const [idx, [off, size]] of Object.entries(pairs)) {
    putI32(8 + Number(idx) * 8, off);
    putI32(8 + Number(idx) * 8 + 4, size);
  }
  u8.set(stringBytes, stringOff);

  for (let i = 0; i < nTypes; i++) {
    const o = typeDefOff + i * typeSize;
    putI32(o, offsets.get(`t${i}`));
    putI32(o + 4, offsets.get(`n${i}`));
  }

  for (let j = 0; j < nMethods; j++) {
    const o = methodsOff + j * methodSize;
    putI32(o, offsets.get(`m${j}`));
    putI32(o + 4, j % nTypes);
    put32(o + tokenAt, 0x06000001 + j);
  }
  return u8;
}

// Issue #9488: Unity v24.5 layout (type: 92, method: 40) must have tokenAt = 20
{
  const u8 = buildFixture({ version: 24, typeSize: 92, methodSize: 40, tokenAt: 20 });
  const meta = parseMetadata(u8);
  assert.equal(meta.version, 24);
  assert.equal(meta.layout, '24.5');
  assert.equal(meta.methods.length, 2);
  assert.equal(meta.methods[0].name, 'MyMethod0');
  assert.equal(meta.methods[0].token, 0x06000001, 'Method token must be read at offset 20 for v24.5');
  assert.equal(meta.methods[1].token, 0x06000002, 'Method token 1 must be read at offset 20 for v24.5');

  const metaAsync = await parseMetadataAutoAsync(u8);
  assert.equal(metaAsync.layout, '24.5');
  assert.equal(metaAsync.methods[0].token, 0x06000001);
}

console.log('issue-9488 il2cpp v24.5 tokenAt regression: PASS');
