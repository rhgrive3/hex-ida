import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveCanonicalAddressProof } from '../../../js/analysis/alias/canonical-address-v2-core.js';
import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';

function castIr(kind, outputWidth, inputWidth = 64) {
  const constant = { kind: 'bitvector', value: '4096', widthBits: inputWidth };
  return {
    functionId: `issue5321_${kind}_${inputWidth}_${outputWidth}`,
    values: [
      {
        id: 'input',
        kind: 'definition',
        machineType: { kind: 'address', widthBits: inputWidth, addressSpace: 'memory' },
        definitionNodeId: 'input-const',
        metadata: { constant },
      },
      {
        id: 'output',
        kind: 'definition',
        machineType: { kind: 'address', widthBits: outputWidth, addressSpace: 'memory' },
        definitionNodeId: 'cast',
      },
    ],
    nodes: [
      {
        id: 'input-const',
        kind: 'const',
        inputs: [],
        outputs: ['input'],
        attributes: { constant },
      },
      { id: 'cast', kind, inputs: ['input'], outputs: ['output'] },
    ],
    blocks: [],
  };
}

function pointsTo(ir) {
  return analyzeLocalPointsTo(ir, null, { definitions: [], uses: [] }, { snapshotId: 'issue-5321' });
}

for (const kind of ['copy', 'bitcast']) {
  test(`#5321 ${kind} preserves provenance only when the machine width is unchanged`, () => {
    const result = pointsTo(castIr(kind, 64));
    const output = result.pointsTo.get('output');
    assert.ok(output);
    assert.equal(output.top, false);
    assert.equal(output.targets.length, 1);
    assert.equal(output.targets[0].address, '4096');
    assert.equal(output.targets[0].widthBits, 64);
  });

  test(`#5321 ${kind} width mismatch fails closed instead of retaining the input pointer target`, () => {
    const result = pointsTo(castIr(kind, 32));
    const output = result.pointsTo.get('output');
    assert.ok(output);
    assert.equal(output.top, true);
    assert.ok(output.lossReasons.includes('integer-to-pointer'));
    assert.equal(output.targets.length, 0);
  });
}

test('#5321 canonical copy derivation rejects a width-changing copy', () => {
  const proof = deriveCanonicalAddressProof(castIr('copy', 32), 'output');
  assert.equal(proof.kind, 'unknown');
  assert.equal(proof.reason, 'canonical-address-copy-width-not-preserved');
});

test('#5321 canonical copy derivation keeps an equal-width copy exact', () => {
  const proof = deriveCanonicalAddressProof(castIr('copy', 64), 'output');
  assert.equal(proof.kind, 'absolute');
  assert.equal(proof.address, 4096n);
  assert.equal(proof.widthBits, 64);
});

console.log('issue #5321 width-preserving cast regressions: PASS');
