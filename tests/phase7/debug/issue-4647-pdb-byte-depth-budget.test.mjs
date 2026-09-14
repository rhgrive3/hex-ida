import assert from 'node:assert/strict';
import test from 'node:test';

import { PdbDebugInfoProvider, describeTypeIndex } from '../../../js/analysis/debug/pdb.js';
import { loadPdbFixtures, pdbImage } from '../../../tools/validation/phase7/lanes/debug.mjs';

const variant = loadPdbFixtures().variants[0];
const provider = new PdbDebugInfoProvider();

function pointerTypes() {
  return new Map([
    [0x1000, { kind: 'pointer', referent: 0x1001, attributes: (8 << 13) | 0x0c }],
    [0x1001, { kind: 'pointer', referent: 0x0074, attributes: (8 << 13) | 0x0c }],
  ]);
}

test('#4647: maxBytesScanned stops before the MSF superblock and fails closed', () => {
  const result = provider.probe(pdbImage(variant), { budget: { maxBytesScanned: 1 } });
  assert.equal(result.identity.verdict, 'identity-unavailable');
  assert.equal(result.authoritative, false);
  assert.equal(result.status.completeness, 'truncated');
  assert.equal(result.status.stopReason, 'budget-exhausted');
  assert.ok(result.diagnostics.some((entry) => entry.includes('byte budget exhausted')));
});

test('#4647: PDB byte budget uses one shared exact materialization boundary', () => {
  // This fixture needs exactly 2692 logical bytes: 56-byte superblock,
  // 4-byte directory-block map, 116-byte stream directory, then the streams
  // the provider actually materializes (93+655+256+636+480+236+160).
  const short = provider.probe(pdbImage(variant), { budget: { maxBytesScanned: 2691 } });
  assert.equal(short.status.stopReason, 'budget-exhausted');
  assert.equal(short.identity.verdict, 'identity-unavailable');
  assert.equal(short.authoritative, false, 'late exhaustion must discard previously matched authority');

  const exact = provider.probe(pdbImage(variant), { budget: { maxBytesScanned: 2692 } });
  assert.notEqual(exact.status.stopReason, 'budget-exhausted');
  assert.equal(exact.identity.verdict, 'matched-authoritative');
});

test('#4647: direct TPI traversal obeys caller maxDepth', () => {
  const shallow = describeTypeIndex(0x1000, pointerTypes(), 0, 1);
  assert.equal(shallow.complete, false);
  assert.match(shallow.name, /unknown/);

  const enough = describeTypeIndex(0x1000, pointerTypes(), 0, 2);
  assert.deepEqual(enough, { name: 'int * *', widthBits: 64, class: 'pointer', complete: true });
});

test('#4647: provider type pages retain the probe maxDepth authority', () => {
  const result = provider.probe(pdbImage(variant), { budget: { maxDepth: 1 } });
  const procedure = result.parsed.symbols.symbols.find((symbol) => symbol.kind === 'procedure');
  assert.ok(procedure, 'fixture must expose a procedure symbol');
  procedure.typeIndex = 0x1000;
  result.parsed.tpi.types.clear();
  for (const [index, record] of pointerTypes()) result.parsed.tpi.types.set(index, record);

  const record = provider.types(result, {}).records.find((entry) => entry.entityId === `pdb_sym_${procedure.recordOffset}`);
  assert.ok(record);
  assert.equal(record.descriptor.complete, false);
  assert.match(record.descriptor.claim.name, /unknown/);
});

test('#4647: default budget keeps the existing real PDB parse', () => {
  const result = provider.probe(pdbImage(variant));
  assert.equal(result.identity.verdict, 'matched-authoritative');
  assert.ok(result.counts.symbols > 0);
  assert.ok(result.counts.types > 0);
  assert.notEqual(result.status.stopReason, 'budget-exhausted');
});
