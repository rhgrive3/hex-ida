import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCurrentFunction } from '../js/ai/provider/worker-protocol.js';

function base(assemblyMeta) {
  return { address: '0x1000', assembly: 'ret\n', assemblyMeta };
}

const CANONICAL = {
  address: '0x1000', assembly: 'ret\n',
  assemblyMeta: {
    totalInstructions: 500, includedInstructions: 360,
    startRow: 0, endRow: 359, truncated: true, omittedInstructions: 140, selection: 'head',
  },
};

test('issue #6167 - canonical non-negative integer metadata is preserved', () => {
  const normalized = normalizeCurrentFunction({
    address: '0x1000', assembly: 'ret\n',
    assemblyMeta: { totalInstructions: 500, includedInstructions: 360, startRow: 0, endRow: 359, omittedInstructions: 140 },
  });
  assert.equal(normalized.assemblyMeta.totalInstructions, 500);
  assert.equal(normalized.assemblyMeta.includedInstructions, 360);
  assert.equal(normalized.assemblyMeta.startRow, 0);
  assert.equal(normalized.assemblyMeta.endRow, 359);
  assert.equal(normalized.assemblyMeta.truncated, true);
  assert.equal(normalized.assemblyMeta.omittedInstructions, 140);
});

test('issue #6167 - canonical total > included derives truncated', () => {
  const normalized = normalizeCurrentFunction({
    address: '0x1000', assembly: 'ret\n',
    assemblyMeta: { totalInstructions: 500, includedInstructions: 360 },
  });
  assert.equal(normalized.assemblyMeta.truncated, true);
  assert.equal(normalized.assemblyMeta.omittedInstructions, 140);
});

test('issue #6167 - structured values are not coerced into instruction counts', () => {
  const structuredInputs = [
    { totalInstructions: ['100'], includedInstructions: ['10'], startRow: ['20'], endRow: ['29'], omittedInstructions: ['90'] },
    { totalInstructions: '100', includedInstructions: '10', startRow: '20', endRow: '29', omittedInstructions: '90' },
    { totalInstructions: true, includedInstructions: false, startRow: true, endRow: false, omittedInstructions: true },
    { totalInstructions: { value: 100 }, includedInstructions: { value: 10 }, startRow: { value: 20 }, endRow: { value: 29 }, omittedInstructions: { value: 90 } },
    { totalInstructions: 100.5, includedInstructions: -1, startRow: NaN, endRow: Infinity, omittedInstructions: -0.5 },
  ];
  for (const assemblyMeta of structuredInputs) {
    const normalized = normalizeCurrentFunction(base(assemblyMeta));
    assert.deepEqual(
      { ...normalized.assemblyMeta, truncated: undefined, selection: undefined },
      {
        totalInstructions: 0, includedInstructions: 0,
        startRow: null, endRow: null, omittedInstructions: 0,
        truncated: undefined, selection: undefined,
      },
      `structured assemblyMeta ${JSON.stringify(assemblyMeta)} must fall back to zero counts`,
    );
  }
});

test('issue #6167 - malformed counts do not fabricate truncated evidence', () => {
  for (const totalInstructions of [['100'], '100', true, { value: 100 }, NaN]) {
    const normalized = normalizeCurrentFunction(base({ totalInstructions, includedInstructions: 10 }));
    assert.equal(normalized.assemblyMeta.truncated, false, `malformed totalInstructions ${JSON.stringify(String(totalInstructions))} must not fabricate truncation`);
    assert.equal(normalized.assemblyMeta.totalInstructions, 0);
    assert.equal(normalized.assemblyMeta.includedInstructions, 10);
  }
  for (const includedInstructions of [['10'], '10', false, { value: 10 }]) {
    const normalized = normalizeCurrentFunction(base({ totalInstructions: 0, includedInstructions }));
    assert.equal(normalized.assemblyMeta.truncated, false, `malformed includedInstructions ${JSON.stringify(String(includedInstructions))} must not fabricate truncation`);
    assert.equal(normalized.assemblyMeta.totalInstructions, 0);
    assert.equal(normalized.assemblyMeta.includedInstructions, 0);
  }
});

test('issue #6167 - startRow/endRow/omittedInstructions share the same strictness', () => {
  const normalized = normalizeCurrentFunction(base({
    totalInstructions: 500, includedInstructions: 360,
    startRow: ['0'], endRow: ['359'], omittedInstructions: ['140'],
  }));
  assert.equal(normalized.assemblyMeta.startRow, null);
  assert.equal(normalized.assemblyMeta.endRow, null);
  assert.equal(normalized.assemblyMeta.omittedInstructions, 140, 'omitted falls back to derived total-included');
});

test('issue #6167 - explicit truncated flag stays authoritative for well-formed counts', () => {
  const normalized = normalizeCurrentFunction(base({ totalInstructions: 4, includedInstructions: 4, truncated: true }));
  assert.equal(normalized.assemblyMeta.truncated, true);
  const untruncated = normalizeCurrentFunction(base({ totalInstructions: 4, includedInstructions: 4 }));
  assert.equal(untruncated.assemblyMeta.truncated, false);
});

test('issue #6167 - full untruncated canonical payload stays intact', () => {
  const normalized = normalizeCurrentFunction({
    address: '0x1000', assembly: 'ret\n',
    assemblyMeta: { totalInstructions: 4, includedInstructions: 4, startRow: 0, endRow: 3, omittedInstructions: 0, selection: 'head' },
  });
  assert.deepEqual(normalized.assemblyMeta, {
    totalInstructions: 4, includedInstructions: 4, startRow: 0, endRow: 3,
    truncated: false, omittedInstructions: 0, selection: 'head',
  });
});
