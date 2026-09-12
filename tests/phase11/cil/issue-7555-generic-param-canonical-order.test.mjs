import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCil } from '../../../js/managed/cil/parser.js';
import { buildCil } from '../fixtures/medium-cil.mjs';

const TYPE_DEF = (rid) => (rid << 2) | 0;
const TYPEDEF_OWNER = (rid) => (rid << 1) | 0;

function genericParamRow(number, nameIndex) {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, number, true);
  view.setUint16(4, TYPEDEF_OWNER(1), true);
  view.setUint16(6, nameIndex, true);
  return bytes;
}

function constraintRow(ownerRid, targetRid) {
  const bytes = new Uint8Array(4);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, ownerRid, true);
  view.setUint16(2, TYPE_DEF(targetRid), true);
  return bytes;
}

const base = {
  leadingStrings: ['T', 'U'],
  methods: [{ name: 'Run', body: [0x2a] }],
  types: [
    { name: 'G`2', namespace: 'N', fieldList: 1, methodList: 1 },
    { name: 'A', namespace: 'N', fieldList: 1, methodList: 2 },
    { name: 'B', namespace: 'N', fieldList: 1, methodList: 2 },
    { name: 'C', namespace: 'N', fieldList: 1, methodList: 2 },
  ],
};

function image({ reverseParams = false, reverseConstraints = false, changedTarget = false } = {}) {
  // leadingStrings uses a zero byte followed by NUL-terminated strings: T=1, U=3.
  const params = reverseParams
    ? [genericParamRow(1, 3), genericParamRow(0, 1)]
    : [genericParamRow(0, 1), genericParamRow(1, 3)];
  const tRid = reverseParams ? 2 : 1;
  let constraints = [constraintRow(tRid, 2), constraintRow(tRid, changedTarget ? 4 : 3)];
  if (reverseConstraints) constraints = constraints.reverse();
  return parseCil(buildCil({
    ...base,
    extraRows: new Map([
      [0x2a, { count: 2, bytes: Uint8Array.of(...params[0], ...params[1]) }],
      [0x2c, { count: 2, bytes: Uint8Array.of(...constraints[0], ...constraints[1]) }],
    ]),
  }).bytes);
}

const boundProjection = (parsed) => parsed.types[0].genericParams.map((row) => ({
  number: row.number,
  name: row.name,
  constraintTokens: row.constraintTokens,
}));

test('#7555 bound generic semantics ignore physical parameter/constraint row order', () => {
  const canonical = image();
  const reordered = image({ reverseParams: true, reverseConstraints: true });

  assert.deepEqual(boundProjection(canonical), [
    { number: 0, name: 'T', constraintTokens: ['0x02000002', '0x02000003'] },
    { number: 1, name: 'U', constraintTokens: [] },
  ]);
  assert.deepEqual(boundProjection(reordered), boundProjection(canonical));
  assert.notDeepEqual(
    reordered.genericParams.map((row) => [row.rid, row.number, row.name]),
    canonical.genericParams.map((row) => [row.rid, row.number, row.name]),
    'standalone table identity may preserve physical metadata order',
  );
});

test('#7555 changing a constraint target still changes bound semantics', () => {
  assert.notDeepEqual(boundProjection(image({ changedTarget: true })), boundProjection(image()));
});
