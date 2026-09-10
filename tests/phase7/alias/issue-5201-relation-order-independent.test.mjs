import assert from 'node:assert/strict';
import test from 'node:test';

import { effectSummaryAliasRelation } from '../../../js/analysis/alias/legacy-safety-floor.js';

const origin = { instructionIds: ['i0'] };
const mk = (offset, id) => ({
  id,
  kind: 'stack-fixed',
  functionId: 'f',
  binaryId: 'b',
  offset: offset.toString(),
  widthBits: 32,
  origin,
});
const target = mk(0, 'stack-0');
const maybe = mk(2, 'stack-2');
const exact = mk(0, 'stack-0');
const classify = (access) => access.region;

test('#5201 the alias relation is order-independent over the same access multiset', () => {
  const a = effectSummaryAliasRelation({ scope: 'accesses', accesses: [{ region: maybe }, { region: exact }] }, target, classify);
  const b = effectSummaryAliasRelation({ scope: 'accesses', accesses: [{ region: exact }, { region: maybe }] }, target, classify);
  assert.equal(a, 'must', `an exact write seen after a may-overlap must still be reported: ${a}`);
  assert.equal(b, 'must');
  assert.equal(a, b, 'the same multiset must produce the same relation regardless of order');
});

test('#5202 without any exact identity, overlap stays may and disjoint stays no', () => {
  const overlap = effectSummaryAliasRelation({ scope: 'accesses', accesses: [{ region: maybe }] }, target, classify);
  assert.equal(overlap, 'may');
  const disjoint = mk(16, 'stack-16');
  const no = effectSummaryAliasRelation({ scope: 'accesses', accesses: [{ region: disjoint }] }, target, classify);
  assert.equal(no, 'no');
});

test('#5201 unknown classifications keep the conservative answer', () => {
  const unknownFirst = effectSummaryAliasRelation(
    { scope: 'accesses', accesses: [{ region: null }, { region: exact }] },
    target,
    () => { throw new Error('classifier broke'); },
  );
  assert.equal(unknownFirst, 'unknown');
});
