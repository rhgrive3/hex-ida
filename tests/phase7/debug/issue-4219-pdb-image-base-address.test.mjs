import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryEvidence } from '../../../js/analysis/discovery/candidates.js';
import { fuseFunctionCandidates } from '../../../js/analysis/discovery/fusion.js';
import { debugFunctionEvidence } from '../../../js/analysis/debug/provider.js';
import { PdbDebugInfoProvider } from '../../../js/analysis/debug/pdb.js';
import { loadPdbFixtures, pdbImage } from '../../../tools/validation/phase7/lanes/debug.mjs';

const variant = loadPdbFixtures().variants[0];
const IMAGE_BASE = 0x140000000n;
const UINT64_MAX = (1n << 64n) - 1n;

function probeWithImage(image) {
  const provider = new PdbDebugInfoProvider();
  const result = provider.probe(image);
  assert.equal(result.identity.verdict, 'matched-authoritative');
  return { provider, result, page: provider.symbols(result, {}) };
}

function functionRecords(page, name = 'add_point') {
  return page.records.filter((record) => record.name === name && record.descriptor?.isFunction === true);
}

test('#4219: PDB section RVA is rebased by the PE image base before becoming an absolute address', () => {
  const { page } = probeWithImage({ ...pdbImage(variant), imageBase: IMAGE_BASE });
  const records = functionRecords(page);
  assert.ok(records.length >= 1);
  for (const record of records) {
    assert.equal(record.address, '0x140001000');
    assert.equal(record.descriptor.complete, true);
  }
});

test('#4219: an explicit zero image base preserves the corpus RVA addresses', () => {
  const { page } = probeWithImage({ ...pdbImage(variant), imageBase: 0n });
  const records = functionRecords(page);
  assert.ok(records.length >= 1);
  for (const record of records) {
    assert.equal(record.address, '0x1000');
    assert.equal(record.descriptor.complete, true);
  }
});

test('#4219: missing image base cannot mint an exact absolute PDB address', () => {
  const { imageBase: _fixtureBase, ...withoutImageBase } = pdbImage(variant);
  const { result, page } = probeWithImage(withoutImageBase);
  const records = functionRecords(page);
  assert.ok(records.length >= 1);
  for (const record of records) {
    assert.equal(record.address, null);
    assert.equal(record.descriptor.complete, false);
  }
  assert.equal(debugFunctionEvidence(result, page).filter((item) => item.name === 'add_point').length, 0);
  assert.equal(result.status.completeness, 'partial');
});

test('#4219: malformed or out-of-domain image bases fail closed without coercion', () => {
  let coercions = 0;
  const hostile = {
    toString() { coercions += 1; throw new Error('must not coerce imageBase'); },
    valueOf() { coercions += 1; throw new Error('must not coerce imageBase'); },
  };
  for (const imageBase of [0, '0x140000000', -1n, UINT64_MAX + 1n, hostile]) {
    const { result, page } = probeWithImage({ ...pdbImage(variant), imageBase });
    for (const record of functionRecords(page)) {
      assert.equal(record.address, null);
      assert.equal(record.descriptor.complete, false);
    }
    assert.equal(result.status.completeness, 'partial');
  }
  assert.equal(coercions, 0, 'imageBase validation must not invoke user coercion hooks');
});

test('#4219: absolute address overflow above uint64 fails closed', () => {
  const { page } = probeWithImage({ ...pdbImage(variant), imageBase: UINT64_MAX });
  const records = functionRecords(page);
  assert.ok(records.length >= 1);
  for (const record of records) {
    assert.equal(record.address, null);
    assert.equal(record.descriptor.complete, false);
  }
});


t
test('#4219: uint64 top boundary is accepted per symbol while later offsets still fail closed', () => {
  const base = UINT64_MAX - 0x1000n;
  const { page } = probeWithImage({ ...pdbImage(variant), imageBase: base });
  const addPoint = functionRecords(page, 'add_point');
  const scale2 = functionRecords(page, 'scale2');
  assert.ok(addPoint.length >= 1 && scale2.length >= 1);
  for (const record of addPoint) {
    assert.equal(record.address, '0xffffffffffffffff');
    assert.equal(record.descriptor.complete, true);
  }
  for (const record of scale2) {
    assert.equal(record.address, null);
    assert.equal(record.descriptor.complete, false);
  }
});

test('#4219: rebased PDB and loader evidence fuse into the same function-start bucket', () => {
  const { result, page } = probeWithImage({ ...pdbImage(variant), imageBase: IMAGE_BASE });
  const debug = debugFunctionEvidence(result, page).find((item) => item.name === 'add_point');
  assert.ok(debug, 'the matched PDB must emit exact add_point evidence');
  assert.equal(debug.confidence, 'exact');
  assert.equal(debug.address, '0x140001000');

  const fused = fuseFunctionCandidates([
    createDiscoveryEvidence({ kind: 'loader-function-start', start: 0x140001000n, producerId: 'pe-loader' }),
    createDiscoveryEvidence({ kind: 'debug-symbol', start: debug.address, name: debug.name, producerId: 'pdb' }),
  ], { snapshotId: 'snapshot-4219' });

  assert.equal(fused.candidates.length, 1);
  assert.equal(fused.candidates[0].start, 0x140001000n.toString());
  assert.equal(fused.candidates[0].startEvidence.length, 2);
  assert.equal(fused.candidates[0].startState, 'exact');
});
