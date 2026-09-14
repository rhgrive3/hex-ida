// Issue #4097 regression: makeStringAt() capped the NUL scan at a fixed
// 512 bytes, so legitimate UTF-8 names that fit entirely inside the declared
// string table but exceed 512 bytes (C# allows Unicode identifiers up to 512
// characters = 1536 UTF-8 bytes) were dropped as null by parseLayout(),
// parseLayoutAsync() and scoreLayout().
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMetadata, parseMetadataAuto, parseMetadataAutoAsync } from '../js/il2cpp.js';

const REQUIRED_HEADER_BYTES = 176;

function buildFixture() {
  const enc = new TextEncoder();
  const nameAscii = 'MyClass';
  const name510 = 'あ'.repeat(170);
  const name513 = 'あ'.repeat(171);
  const name900 = 'か'.repeat(300);
  const bytes510 = enc.encode(name510);
  const bytes513 = enc.encode(name513);
  const bytes900 = enc.encode(name900);
  assert.equal(bytes510.length, 510);
  assert.equal(bytes513.length, 513);
  assert.equal(bytes900.length, 900);

  const entries = [
    { bytes: enc.encode(nameAscii), nul: true },
    { bytes: bytes510, nul: true },
    { bytes: bytes513, nul: true },
    { bytes: bytes900, nul: true },
    { bytes: Uint8Array.from([0xff, 0xfe, 0x41]), nul: true },
    { bytes: enc.encode('TailNoNul'), nul: false },
  ];
  const indices = [];
  let cursor = 0;
  for (const entry of entries) {
    indices.push(cursor);
    cursor += entry.bytes.length + (entry.nul ? 1 : 0);
  }
  const stringTable = new Uint8Array(cursor);
  let at = 0;
  for (const entry of entries) {
    stringTable.set(entry.bytes, at);
    at += entry.bytes.length;
    if (entry.nul) at += 1;
  }

  const stringOffset = 256;
  const typeDefCount = entries.length;
  const typeSize = 92;
  const methodSize = 40;
  const typeDefOffset = stringOffset + stringTable.length + 8;
  const methodOffset = typeDefOffset + typeDefCount * typeSize;
  const total = methodOffset + methodSize + 64;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);

  dv.setUint32(0, 0xfab11baf, true);
  dv.setInt32(4, 29, true);
  dv.setUint32(8 + 2 * 8, stringOffset, true);
  dv.setUint32(8 + 2 * 8 + 4, stringTable.length, true);
  dv.setUint32(8 + 5 * 8, methodOffset, true);
  dv.setUint32(8 + 5 * 8 + 4, methodSize, true);
  dv.setUint32(8 + 19 * 8, typeDefOffset, true);
  dv.setUint32(8 + 19 * 8 + 4, typeDefCount * typeSize, true);

  assert.ok(stringOffset >= REQUIRED_HEADER_BYTES);
  buf.set(stringTable, stringOffset);
  for (let i = 0; i < typeDefCount; i++) {
    const o = typeDefOffset + i * typeSize;
    dv.setInt32(o, indices[i], true);
    dv.setInt32(o + 4, -1, true);
  }
  dv.setInt32(methodOffset, indices[2], true);
  dv.setInt32(methodOffset + 4, 2, true);
  return { buf, nameAscii, name510, name513, name900 };
}

const fixture = buildFixture();

test('#4097 sync parser keeps valid names beyond 512 UTF-8 bytes', () => {
  const meta = parseMetadata(fixture.buf);
  const names = meta.classes.map((c) => c.name);
  assert.deepEqual(names, [fixture.nameAscii, fixture.name510, fixture.name513, fixture.name900]);
  assert.equal(meta.classes.length, 4);
  assert.equal(meta.methods.length, 1);
  assert.equal(meta.methods[0].name, fixture.name513);
  assert.equal(meta.methods[0].full, `${fixture.name513}::${fixture.name513}`);
});

test('#4097 async parser agrees with the sync parser on long names', async () => {
  const sync = parseMetadataAuto(fixture.buf);
  const asyncMeta = await parseMetadataAutoAsync(fixture.buf);
  assert.deepEqual(asyncMeta.classes.map((c) => c.name), sync.classes.map((c) => c.name));
  assert.deepEqual(asyncMeta.classes.map((c) => c.name), [fixture.nameAscii, fixture.name510, fixture.name513, fixture.name900]);
  assert.deepEqual(asyncMeta.methods.map((m) => m.name), sync.methods.map((m) => m.name));
});

test('#4097 fail-closed paths stay closed', () => {
  const meta = parseMetadata(fixture.buf);
  const names = meta.classes.map((c) => c.name);
  assert.equal(names.length, 4);
  assert.ok(!names.some((n) => n.includes('TailNoNul')), 'NUL only outside the declared table must be rejected');
  assert.ok(!names.some((n) => n.includes('A')), 'invalid UTF-8 must be rejected');
  assert.ok(!names.some((n) => /\ufffd/.test(n)), 'replacement chars must never leak from fatal decoding');
});

test('#4097 beyond-window scanning is charged to the metadata budget', () => {
  assert.throws(
    () => parseMetadata(fixture.buf, { budget: { maxEstimatedHeapBytes: 1856 } }),
    (error) => error.code === 'IL2CPP_METADATA_BUDGET',
    'long-name scans past the first window must consume budget instead of silently truncating',
  );
  const aborted = new AbortController();
  aborted.abort();
  assert.throws(() => parseMetadata(fixture.buf, { signal: aborted.signal }), (error) => error.code === 'ABORT_ERR');
});

test('#4097 default budget still parses the same fixture cleanly', () => {
  const meta = parseMetadata(fixture.buf);
  assert.ok(meta.parseBudget && Number.isFinite(meta.parseBudget.operations) && meta.parseBudget.operations > 0);
  assert.ok(Number.isFinite(meta.parseBudget.estimatedHeapBytes) && meta.parseBudget.estimatedHeapBytes >= 0);
});
