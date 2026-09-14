import assert from 'node:assert/strict';
import { buildCil } from '../fixtures/medium-cil.mjs';
import { parseCil } from '../../../js/managed/cil/parser.js';

console.log('[phase11] running #8699/#8797 public parse single-pass budget regressions...');

function fieldAliasFixture(n, nameLen = 4095) {
  const shared = 'F'.repeat(nameLen);
  const fields = new Uint8Array(n * 6);
  const fv = new DataView(fields.buffer);
  for (let i = 0; i < n; i++) {
    const p = i * 6;
    fv.setUint16(p, 6, true);
    fv.setUint16(p + 2, 1, true);
    fv.setUint16(p + 4, 5, true);
  }
  const types = Array.from({ length: n }, (_, i) => ({
    name: `T${i}`, namespace: '', flags: 1, fieldList: i + 1, methodList: 1,
  }));
  const imageSize = 0x400 + 0x100 + shared.length + n * 14 + n * 6 + n * 12 + 0x2000;
  return buildCil({
    methods: [], types, leadingStrings: [shared],
    extraRows: new Map([[0x04, { count: n, bytes: fields }]]),
    imageSize, metadataSize: imageSize - 0x300,
  }).bytes;
}

function withBudgetStartCount(fn) {
  const originalNow = Date.now;
  let starts = 0;
  Date.now = () => { starts += 1; return 0; };
  try { return { value: fn(), starts }; }
  finally { Date.now = originalNow; }
}

// #8699: the caller's tiny row budget must be the first metadata admission
// budget used by public parseCil(). Before the wrapper fix an unbounded probe
// completed both overlays first, so this path created three budgets before the
// requested maxRows=1 rejection (probe metadata + probe manifest + parse metadata).
{
  let starts = 0;
  const originalNow = Date.now;
  Date.now = () => { starts += 1; return 0; };
  try {
    assert.throws(
      () => parseCil(fieldAliasFixture(2000), {
        binaryId: 'public-budget-first-pass',
        resourceBudget: { maxRows: 1 },
      }),
      /cil-metadata-resource-limit-rows/,
      'public parse must reject from the caller-bounded first metadata pass',
    );
  } finally {
    Date.now = originalNow;
  }
  assert.equal(starts, 1,
    'low-budget public parse must not run an unbounded metadata/manifest probe first');
}

// #8797: a successful public parse performs each semantic overlay once. Each
// overlay constructs one aggregate metadata budget, so one authoritative parse
// creates two budgets total (metadata + manifest), not four from probe+parse.
{
  const bytes = buildCil({
    methods: [{ name: 'Run', body: [0x2a] }],
    types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
  }).bytes;
  const { value: image, starts } = withBudgetStartCount(() =>
    parseCil(bytes, { binaryId: 'public-single-pass' }));
  assert.equal(image.methods.length, 1);
  assert.equal(starts, 2,
    'public parse must not repeat completed metadata/manifest semantic overlays');
}

console.log('[phase11] #8699/#8797 public parse single-pass budget regressions passed');
