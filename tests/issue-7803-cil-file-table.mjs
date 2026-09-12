import assert from 'node:assert/strict';
import { buildCil, cilTables } from './phase11/fixtures/medium-cil.mjs';
import { parseCil, probeCil } from '../js/managed/cil/parser.js';

const align = (n) => Math.ceil(n / 4) * 4;
const pad = (b) => { const p = new Uint8Array(align(b.length)); p.set(b); return p; };
const utf8 = (s) => [...new TextEncoder().encode(s), 0];

const strings = [0, ...utf8('A.netmodule'), ...utf8('B.netmodule')];
const blobHeap = Uint8Array.from([0, 3, 0xaa, 0xbb, 0xcc, 3, 0xdd, 0xbb, 0xcc, 0]);

function fileFixture({ flags = 0, nameIndex = 1, hashIndex = 1, rows } = {}) {
  const files = rows ?? (() => {
    const row = new Uint8Array(8);
    const v = new DataView(row.buffer);
    v.setUint32(0, flags, true);
    v.setUint16(4, nameIndex, true);
    v.setUint16(6, hashIndex, true);
    return row;
  })();
  const tables = cilTables(new Map([[0x26, { count: files.length / 8, bytes: files }]]));
  return buildCil({
    methods: [{ name: 'Run', body: [0x2a] }],
    streams: [
      { name: '#~', bytes: tables.bytes },
      { name: '#Strings', bytes: pad(Uint8Array.from(strings)) },
      { name: '#Blob', bytes: pad(blobHeap) },
    ],
  }).bytes;
}

const semantic = (image) => {
  const { rawBytes, ...rest } = image;
  return JSON.stringify(rest);
};

{
  const image = parseCil(fileFixture(), { binaryId: 'issue-7803-a' });
  assert.ok(Array.isArray(image.files));
  assert.equal(image.files.length, 1);
  assert.equal(image.files[0].rid, 1);
  assert.equal(image.files[0].token, '0x26000001');
  assert.equal(image.files[0].flags, 0);
  assert.equal(image.files[0].name, 'A.netmodule');
  assert.equal(image.files[0].hashValueBlobIndex, 1);
  assert.deepEqual([...image.files[0].hashValue], [0xaa, 0xbb, 0xcc]);
  const noMeta = parseCil(fileFixture({ flags: 1 }), { binaryId: 'issue-7803-nometa' });
  assert.equal(noMeta.files[0].flags, 1);
  assert.equal(noMeta.files[0].name, 'A.netmodule');
}

{
  const a = parseCil(fileFixture({ nameIndex: 1 }), { binaryId: 'same' });
  const b = parseCil(fileFixture({ nameIndex: 13 }), { binaryId: 'same' });
  assert.equal(a.files[0].name, 'A.netmodule');
  assert.equal(b.files[0].name, 'B.netmodule');
  assert.notEqual(semantic(a), semantic(b));
}

{
  const a = parseCil(fileFixture({ hashIndex: 1 }), { binaryId: 'same' });
  const b = parseCil(fileFixture({ hashIndex: 5 }), { binaryId: 'same' });
  assert.deepEqual([...a.files[0].hashValue], [0xaa, 0xbb, 0xcc]);
  assert.deepEqual([...b.files[0].hashValue], [0xdd, 0xbb, 0xcc]);
  assert.notEqual(semantic(a), semantic(b));
}

{
  assert.throws(() => parseCil(fileFixture({ flags: 2 }), { binaryId: 'badflags' }),
    /cil-file-flags-invalid|cil-unsupported-binary/);
  assert.throws(() => parseCil(fileFixture({ hashIndex: 0 }), { binaryId: 'nohash' }),
    /cil-file-hash-required|cil-unsupported-binary/);
  assert.throws(() => parseCil(fileFixture({ hashIndex: 0x50 }), { binaryId: 'badhash' }),
    /cil-file-hash-blob-invalid|cil-unsupported-binary/);
  assert.throws(() => parseCil(fileFixture({ hashIndex: 9 }), { binaryId: 'emptyhash' }),
    /cil-file-hash-empty|cil-file-hash-blob-invalid|cil-unsupported-binary/);
  const dup = new Uint8Array(16), dv = new DataView(dup.buffer);
  for (const pos of [0, 8]) {
    dv.setUint32(pos, 0, true);
    dv.setUint16(pos + 4, 1, true);
    dv.setUint16(pos + 6, 1, true);
  }
  assert.throws(() => parseCil(fileFixture({ rows: dup }), { binaryId: 'dupname' }),
    /cil-file-name-duplicate|cil-unsupported-binary/);
}

assert.deepEqual(probeCil(fileFixture()), {
  supported: true,
  confidence: 1,
  formatVersion: 'pe-cli',
  vmSpecEdition: 'clr-v4',
});

console.log('issue-7803-cil-file-table: PASS');
