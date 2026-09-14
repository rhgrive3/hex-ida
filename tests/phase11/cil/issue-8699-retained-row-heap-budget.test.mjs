import assert from 'node:assert/strict';
import { buildCil } from '../fixtures/medium-cil.mjs';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { createCilMetadataBudget } from '../../../js/managed/cil/metadata-layout.js';

console.log('[phase11] running issue #8699 retained-row heap budget tests...');

{
  const budget = createCilMetadataBudget({ resourceBudget: {
    maxRows: 1000, maxEstimatedHeapBytes: 700, maxWork: 1000, deadlineMs: 10_000,
  } });
  budget.chargeRow(8);
  budget.chargeRow(8);
  assert.throws(() => budget.chargeRow(8), /cil-metadata-resource-limit-heap/);
}

function genericParamAliasFixture(n) {
  const name = 'g';
  const pre = buildCil({ leadingStrings: [name] });
  const nameOff = pre.layout.leadingStringIndex[name];
  const rows = new Uint8Array(n * 8);
  const view = new DataView(rows.buffer);
  for (let i = 0; i < n; i++) {
    const p = i * 8;
    view.setUint16(p, i, true);
    view.setUint16(p + 2, 0, true);
    view.setUint16(p + 4, (1 << 1) | 0, true);
    view.setUint16(p + 6, nameOff, true);
  }
  const imageSize = 0x400 + 0x100 + rows.length + 0x1800;
  return buildCil({
    types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
    leadingStrings: [name],
    extraRows: new Map([[0x2a, { count: n, bytes: rows }]]),
    imageSize,
    metadataSize: imageSize - 0x300,
  }).bytes;
}

assert.throws(
  () => parseCil(genericParamAliasFixture(64), {
    binaryId: 'row-heap-tiny',
    resourceBudget: {
      maxRows: 10_000, maxStrings: 10_000, maxStringBytes: 1024 * 1024,
      maxEstimatedHeapBytes: 2048, maxWork: 1_000_000, deadlineMs: 10_000,
    },
  }),
  /cil-metadata-resource-limit-heap/,
);

const admitted = parseCil(genericParamAliasFixture(32), {
  binaryId: 'row-heap-admit',
  resourceBudget: {
    maxRows: 10_000, maxStrings: 10_000, maxStringBytes: 1024 * 1024,
    maxEstimatedHeapBytes: 1024 * 1024, maxWork: 1_000_000, deadlineMs: 10_000,
  },
});
assert.equal(admitted.genericParams.length, 32);

console.log('[phase11] issue #8699 retained-row heap budget tests passed');
