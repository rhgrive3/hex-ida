import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDebugIdentity,
  createDebugProviderResult,
  createDebugRecord,
  debugFunctionEvidence,
} from '../../../js/analysis/debug/provider.js';
import { DwarfDebugInfoProvider } from '../../../js/analysis/debug/dwarf.js';
import { PdbDebugInfoProvider } from '../../../js/analysis/debug/pdb.js';
import {
  dwarfImage,
  loadDwarfFixtures,
  loadPdbFixtures,
  pdbImage,
} from '../../../tools/validation/phase7/lanes/debug.mjs';

function record(overrides = {}) {
  return createDebugRecord({
    kind: 'symbol',
    entityId: 'function-main',
    name: 'main',
    address: '0x1000',
    providerId: 'dwarf',
    providerVersion: '1',
    buildIdentity: 'build-main',
    descriptor: { isFunction: true },
    ...overrides,
  });
}

test('debug record sizes accept only primitive non-negative safe integers', () => {
  for (const value of [0, 16, Number.MAX_SAFE_INTEGER, null, undefined]) {
    const result = record({ sizeBytes: value });
    assert.equal(result.sizeBytes, value == null ? null : value);
    if (value != null) assert.equal(typeof result.sizeBytes, 'number');
  }

  for (const value of ['16', '0x10', ' 16 ', true, [], {}, NaN, Infinity, -1, 1.5]) {
    assert.throws(() => record({ sizeBytes: value }), /debug-record-invalid-size/, String(value));
  }
});

test('debug function evidence preserves a numeric extent and null absence', () => {
  const result = createDebugProviderResult({
    identity: createDebugIdentity({
      verdict: 'matched-authoritative',
      providerId: 'dwarf',
      providerVersion: '1',
      expected: 'build-main',
      observed: 'build-main',
      method: 'gnu-build-id',
    }),
    ecosystem: 'dwarf',
    status: {
      snapshotId: 'snapshot',
      analyzerId: 'debug',
      analyzerVersion: '1',
      completeness: 'complete',
    },
  });
  const evidence = debugFunctionEvidence(result, {
    records: [record({ sizeBytes: 16 }), record({ entityId: 'function-no-extent', sizeBytes: null })],
  });
  assert.deepEqual(evidence.map((item) => item.sizeBytes), [16, null]);
  assert.equal(typeof evidence[0].sizeBytes, 'number');
});

test('DWARF and PDB function extents remain primitive numbers', () => {
  const dwarfFixtures = loadDwarfFixtures();
  const dwarfVariant = dwarfFixtures.variants.find((variant) => variant.name === 'dwarf5');
  const pdbVariant = loadPdbFixtures().variants[0];
  const providers = [
    [new DwarfDebugInfoProvider(), dwarfImage(dwarfVariant)],
    [new PdbDebugInfoProvider(), pdbImage(pdbVariant)],
  ];

  for (const [provider, image] of providers) {
    const result = provider.probe(image);
    const functions = provider.symbols(result, {}).records.filter((item) => item.descriptor?.isFunction === true);
    assert.ok(functions.length > 0);
    assert.ok(functions.some((item) => item.sizeBytes != null));
    for (const item of functions) {
      if (item.sizeBytes != null) assert.equal(typeof item.sizeBytes, 'number');
    }
  }
});
