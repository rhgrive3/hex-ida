import assert from 'node:assert/strict';
import { parseMetadata, parseMetadataAuto, parseMetadataAutoAsync } from '../js/il2cpp.js';

const SANITY = 0xFAB11BAF;
const HEADER = 184;
const PAIR = { string: 2, methods: 5, typeDefinitions: 19 };

function buildFixture({ version, typeSize, methodSize, tokenAt }) {
  const nTypes = 3, nMethods = 6;
  const enc = new TextEncoder();
  const blob = [];
  const offsets = new Map();
  const add = (key, text) => { offsets.set(key, blob.length); blob.push(...enc.encode(text), 0); };
  for (let i = 0; i < nTypes; i++) { add(`t${i}`, `TC${i}`); add(`n${i}`, `NS${i}`); }
  for (let j = 0; j < nMethods; j++) add(`m${j}`, `MM${j}`);
  const strings = Uint8Array.from(blob);

  const stringOff = HEADER;
  const methodsOff = stringOff + strings.length;
  const typeDefOff = methodsOff + nMethods * methodSize;
  const total = typeDefOff + nTypes * typeSize;
  const u8 = new Uint8Array(total);
  const dv = new DataView(u8.buffer);
  const put32 = (at, v) => dv.setUint32(at, v >>> 0, true);
  const putI32 = (at, v) => dv.setInt32(at, v | 0, true);
  put32(0, SANITY); putI32(4, version);
  const pairs = {
    [PAIR.string]: [stringOff, strings.length],
    [PAIR.methods]: [methodsOff, nMethods * methodSize],
    [PAIR.typeDefinitions]: [typeDefOff, nTypes * typeSize],
  };
  for (const [idx, [off, size]] of Object.entries(pairs)) {
    putI32(8 + Number(idx) * 8, off); putI32(8 + Number(idx) * 8 + 4, size);
  }
  u8.set(strings, stringOff);
  for (let i = 0; i < nTypes; i++) {
    const o = typeDefOff + i * typeSize;
    putI32(o, offsets.get(`t${i}`)); putI32(o + 4, offsets.get(`n${i}`));
  }
  const wrongTokenAt = tokenAt === 20 ? 24 : 20;
  for (let j = 0; j < nMethods; j++) {
    const o = methodsOff + j * methodSize;
    putI32(o, offsets.get(`m${j}`));
    putI32(o + 4, j % nTypes);
    put32(o + tokenAt, 0x06000001 + j);
    if (o + wrongTokenAt + 4 <= o + methodSize) put32(o + wrongTokenAt, 0x06badbad);
  }
  return { u8, nTypes, nMethods };
}

function checkLayout({ version, typeSize, methodSize, tokenAt }) {
  const { u8, nTypes, nMethods } = buildFixture({ version, typeSize, methodSize, tokenAt });
  const meta = parseMetadata(u8);
  assert.equal(meta.version, version, `v${version}: version`);
  assert.equal(meta.classes.length, nTypes, `v${version}: type records`);
  assert.equal(meta.methods.length, nMethods, `v${version}: method records`);
  for (let i = 0; i < nTypes; i++) assert.equal(meta.classes[i].name, `TC${i}`, `v${version}: type name ${i}`);
  for (let j = 0; j < nMethods; j++) {
    assert.equal(meta.methods[j].name, `MM${j}`, `v${version}: method name ${j}`);
    assert.equal(meta.methods[j].classIndex, j % nTypes, `v${version}: owner ${j}`);
    assert.equal(meta.methods[j].token, 0x06000001 + j, `v${version}: token read at offset ${tokenAt}`);
  }
  return meta;
}

// regression 1-2 & audit: v27 (88/32, token @20)
checkLayout({ version: 27, typeSize: 88, methodSize: 32, tokenAt: 20 });
// regression 1-2: v29 (88/32, token @20)
const v29 = checkLayout({ version: 29, typeSize: 88, methodSize: 32, tokenAt: 20 });
// regression 3-4: v31 (88/36, returnParameterToken decoy @20, token @24)
const v31 = checkLayout({ version: 31, typeSize: 88, methodSize: 36, tokenAt: 24 });
assert.equal(v31.methods[0].token, 0x06000001, 'v31 returnParameterToken must not be read as the token');

// regression 6: table size that is not an integer multiple of the record size is rejected (fail-closed)
for (const { version, typeSize, methodSize, tokenAt } of [
  { version: 29, typeSize: 88, methodSize: 32, tokenAt: 20 },
  { version: 31, typeSize: 88, methodSize: 36, tokenAt: 24 },
]) {
  const { u8 } = buildFixture({ version, typeSize, methodSize, tokenAt });
  const badType = u8.slice(), bt = new DataView(badType.buffer);
  bt.setInt32(8 + PAIR.typeDefinitions * 8 + 4, typeSize * 3 - 4, true);
  assert.throws(() => parseMetadata(badType), /layout|判定/, `v${version}: malformed type table rejected (sync)`);
  assert.throws(() => parseMetadataAuto(badType), /layout|判定/, `v${version}: malformed type table rejected (auto)`);
  const badMethod = u8.slice(), bm = new DataView(badMethod.buffer);
  bm.setInt32(8 + PAIR.methods * 8 + 4, methodSize * 6 - 4, true);
  assert.throws(() => parseMetadata(badMethod), /layout|判定/, `v${version}: malformed method table rejected (sync)`);
}

// regression 7: sync and async parsers agree
for (const { version, typeSize, methodSize, tokenAt } of [
  { version: 27, typeSize: 88, methodSize: 32, tokenAt: 20 },
  { version: 29, typeSize: 88, methodSize: 32, tokenAt: 20 },
  { version: 31, typeSize: 88, methodSize: 36, tokenAt: 24 },
]) {
  const { u8 } = buildFixture({ version, typeSize, methodSize, tokenAt });
  const sync = parseMetadata(u8);
  const asyncMeta = await parseMetadataAutoAsync(u8);
  assert.deepEqual(asyncMeta.methods.map((m) => [m.name, m.classIndex, m.token]), sync.methods.map((m) => [m.name, m.classIndex, m.token]), `v${version}: async matches sync`);
  assert.deepEqual(asyncMeta.classes.map((c) => c.name), sync.classes.map((c) => c.name), `v${version}: async classes match sync`);
}

// unversioned buckets stay intact: v33 keeps the existing 92/40 layout
{
  const { u8 } = buildFixture({ version: 33, typeSize: 92, methodSize: 40, tokenAt: 24 });
  const meta = parseMetadata(u8);
  assert.equal(meta.version, 33);
  assert.equal(meta.methods[0].token, 0x06000001);
}

console.log('issue-4107 il2cpp v27/v29/v31 record layout: PASS');
