import assert from 'node:assert/strict';
import test from 'node:test';

import { DwarfDebugInfoProvider } from '../../../js/analysis/debug/dwarf.js';
import { PdbDebugInfoProvider } from '../../../js/analysis/debug/pdb.js';
import {
  dwarfImage,
  loadDwarfFixtures,
  loadPdbFixtures,
  pdbImage,
} from '../../../tools/validation/phase7/lanes/debug.mjs';

const dwarfVariant = loadDwarfFixtures().variants.find((variant) => variant.name === 'dwarf5');
const pdbVariant = loadPdbFixtures().variants[0];

const malformedCursors = [
  ['1'],
  {},
  true,
  'not-a-cursor',
  '-1',
  '1.5',
  String(Number.MAX_SAFE_INTEGER + 1),
];

for (const [name, provider, image] of [
  ['DWARF', new DwarfDebugInfoProvider(), dwarfImage(dwarfVariant)],
  ['PDB', new PdbDebugInfoProvider(), pdbImage(pdbVariant)],
]) {
  test(`${name} paging accepts only canonical safe-integer cursors`, () => {
    const result = provider.probe(image);
    const first = provider.symbols(result, { pageSize: 1 });
    assert.equal(first.records.length, 1);
    assert.equal(first.truncated, true);
    assert.match(first.nextCursor, /^(0|[1-9]\d*)$/);

    const second = provider.symbols(result, { cursor: first.nextCursor, pageSize: 1 });
    assert.equal(second.records.length, 1);
    assert.notEqual(second.records[0].entityId, first.records[0].entityId);

    for (const cursor of malformedCursors) {
      assert.throws(
        () => provider.symbols(result, { cursor, pageSize: 1 }),
        /debug-page-cursor-invalid/,
        `accepted malformed cursor: ${String(cursor)}`,
      );
      assert.throws(
        () => provider.types(result, { cursor, pageSize: 1 }),
        /debug-page-cursor-invalid/,
        `accepted malformed type cursor: ${String(cursor)}`,
      );
    }
  });
}

test('PDB CodeView identity rejects structured GUID/age before authority comparison', () => {
  const provider = new PdbDebugInfoProvider();
  const malformed = provider.probe(pdbImage(pdbVariant, {
    codeView: {
      guid: [pdbVariant.codeView.guid],
      age: [pdbVariant.codeView.age],
    },
  }));

  assert.equal(malformed.identity.verdict, 'identity-unavailable');
  assert.equal(malformed.identity.expected, null);
  assert.equal(malformed.authoritative, false);

  const valid = provider.probe(pdbImage(pdbVariant, {
    codeView: {
      guid: `  ${pdbVariant.codeView.guid.toLowerCase()}  `,
      age: pdbVariant.codeView.age,
    },
  }));
  assert.equal(valid.identity.verdict, 'matched-authoritative');
  assert.equal(valid.identity.expected, `${pdbVariant.codeView.guid}/${pdbVariant.codeView.age}`);
  assert.equal(valid.authoritative, true);
});

test('missing-PDB path uses the same strict CodeView component validation', () => {
  const provider = new PdbDebugInfoProvider();
  const result = provider.probe({
    identity: {
      codeView: {
        guid: [pdbVariant.codeView.guid],
        age: [pdbVariant.codeView.age],
        path: 'fixture.pdb',
      },
    },
    pdbBytes: null,
  });

  assert.equal(result.identity.verdict, 'companion-missing');
  assert.equal(result.identity.expected, null);
  assert.equal(result.authoritative, false);
});
