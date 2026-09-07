import assert from 'node:assert/strict';
import test from 'node:test';

import { DwarfDebugInfoProvider } from '../../../js/analysis/debug/dwarf.js';
import { PdbDebugInfoProvider } from '../../../js/analysis/debug/pdb.js';

function dwarfResult() {
  return { parsed: { dies: new Map() } };
}

function pdbResult() {
  return {
    parsed: {
      sectionHeaders: [],
      symbols: { symbols: [] },
      tpi: { types: new Map() },
    },
  };
}

const readers = [
  {
    name: 'DWARF symbols',
    run: (options) => new DwarfDebugInfoProvider().symbols(dwarfResult(), options),
  },
  {
    name: 'DWARF types',
    run: (options) => new DwarfDebugInfoProvider().types(dwarfResult(), options),
  },
  {
    name: 'PDB symbols',
    run: (options) => new PdbDebugInfoProvider().symbols(pdbResult(), options),
  },
  {
    name: 'PDB types',
    run: (options) => new PdbDebugInfoProvider().types(pdbResult(), options),
  },
];

const malformed = [
  ['1'],
  {},
  true,
  1,
  'not-a-cursor',
  '-1',
  '1.5',
  '01',
  '+1',
  ' 1 ',
  '9007199254740992',
];

for (const reader of readers) {
  test(`${reader.name} rejects malformed cursors before backend coercion`, () => {
    for (const cursor of malformed) {
      assert.throws(
        () => reader.run({ cursor }),
        (error) => error instanceof TypeError && error.message === 'debug-page-cursor-invalid',
        `${reader.name} should reject ${JSON.stringify(cursor)}`,
      );
    }
  });

  test(`${reader.name} preserves canonical decimal cursors`, () => {
    for (const cursor of [null, '0', '1', '9007199254740991']) {
      const page = reader.run({ cursor, pageSize: 1 });
      assert.deepEqual(page.records, []);
      assert.equal(page.nextCursor, null);
      assert.equal(page.truncated, false);
    }
  });
}
