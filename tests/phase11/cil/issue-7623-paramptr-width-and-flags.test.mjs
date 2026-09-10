import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCil } from '../../../js/managed/cil/parser.js';
import { metadataRowSize } from '../../../js/managed/cil/metadata-layout.js';
import { buildCil } from '../fixtures/medium-cil.mjs';

test('#7623 MethodDef.ParamList width follows ParamPtr when the pointer table is present', () => {
  const counts = Array(0x2d).fill(0);
  counts[0x07] = 0x10000; // ParamPtr needs a 4-byte table index.
  counts[0x08] = 1;       // Param itself still needs only 2 bytes.

  // MethodDef fixed columns (8) + String(2) + Blob(2) + ParamList(4).
  assert.equal(metadataRowSize(0x06, counts, 0), 16);
  // ParamPtr's target still indexes Param, so its own row remains 2 bytes.
  assert.equal(metadataRowSize(0x07, counts, 0), 2);

  counts[0x07] = 0;
  assert.equal(metadataRowSize(0x06, counts, 0), 14,
    'without ParamPtr, MethodDef.ParamList indexes Param directly');
});

test('#7623 ParamAttributes accepts every bit outside the ECMA reserved 0xcfe0 mask', () => {
  const rows = new Uint8Array(12);
  const view = new DataView(rows.buffer);
  // Sequence 0 return row: use 0x0008, which is not part of the reserved mask.
  view.setUint16(0, 0x0008, true);
  view.setUint16(2, 0, true);
  // Sequence 1 parameter: use 0x0004, also outside the reserved mask.
  view.setUint16(6, 0x0004, true);
  view.setUint16(8, 1, true);

  const { bytes } = buildCil({
    methods: [{ name: 'Run', body: [0x2a], signature: [0, 1, 1, 0x08] }],
    extraRows: [[0x08, { count: 2, bytes: rows }]],
  });
  const image = parseCil(bytes);
  assert.equal(image.params[0].flags, 0x0008);
  assert.equal(image.params[1].flags, 0x0004);
});

console.log('issue #7623 ParamPtr width/ParamAttributes regressions: PASS');
