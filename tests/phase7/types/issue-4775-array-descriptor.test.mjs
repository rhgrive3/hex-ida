import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHardConstraint,
  createSoftEvidence,
  createTypeClaim,
} from '../../../js/analysis/types/constraints.js';
import {
  TypeConstraintGraph,
  selectedTypeIfCertain,
} from '../../../js/analysis/types/graph.js';

const LAYERS = ['machine', 'abi', 'structural', 'nominal'];

function claim(layer, descriptor) {
  return createTypeClaim({ layer, entityId:`entity-${layer}`, descriptor });
}

test('issue #4775: arrays are never canonical TypeClaim descriptors', () => {
  for (const layer of LAYERS) {
    assert.throws(
      () => claim(layer, ['not-a-type']),
      /type-claim-descriptor-required/,
      `${layer} accepted an Array descriptor`,
    );
  }
});

test('issue #4775: hard constraints cannot launder an Array descriptor into certainty', () => {
  const graph = new TypeConstraintGraph({ snapshotId:'snapshot-4775' });
  assert.throws(
    () => graph.addHardConstraint({
      kind:'access-width',
      origin:'binary-evidence',
      claim:{
        layer:'machine',
        entityId:'v0',
        descriptor:['not-a-machine-type'],
      },
      evidenceIds:['insn:4775'],
    }),
    /type-claim-descriptor-required/,
  );

  const result = graph.solveEntity('v0');
  assert.equal(result.layers.machine?.confidence ?? 'unknown', 'unknown');
  assert.equal(selectedTypeIfCertain(result, 'machine'), null);
});

test('issue #4775: soft evidence uses the same descriptor boundary', () => {
  assert.throws(
    () => createSoftEvidence({
      kind:'use-shape',
      origin:'heuristic',
      claim:{ layer:'machine', entityId:'v0', descriptor:['pointer-ish'] },
      weight:0.5,
    }),
    /type-claim-descriptor-required/,
  );
});

test('issue #4775: ordinary descriptor objects remain valid on every layer', () => {
  const descriptors = {
    machine:{ class:'integer', widthBits:64 },
    abi:{ location:'x0', passingClass:'integer' },
    structural:{ kind:'pointer', targetEntityId:'v1' },
    nominal:{ name:'Widget' },
  };

  for (const layer of LAYERS) {
    const created = claim(layer, descriptors[layer]);
    assert.equal(created.layer, layer);
    assert.equal(Array.isArray(created.descriptor), false);
  }
});

test('issue #4775: Array subclasses and proxied Arrays do not bypass the boundary', () => {
  class DescriptorArray extends Array {}
  const subclass = new DescriptorArray('not-a-type');
  const proxied = new Proxy(['not-a-type'], {});

  for (const descriptor of [subclass, proxied]) {
    assert.throws(
      () => claim('machine', descriptor),
      /type-claim-descriptor-required/,
    );
  }
});

// Control: canonical hard evidence is still publishable as certain.
test('issue #4775: canonical singleton hard claims retain certain publication', () => {
  const graph = new TypeConstraintGraph({ snapshotId:'snapshot-4775-control' });
  graph.addHardConstraint({
    kind:'access-width',
    origin:'binary-evidence',
    claim:{ layer:'machine', entityId:'v1', descriptor:{ class:'integer', widthBits:64 } },
    evidenceIds:['insn:control'],
  });
  const result = graph.solveEntity('v1');
  assert.equal(result.layers.machine.confidence, 'certain');
  assert.equal(selectedTypeIfCertain(result, 'machine')?.descriptor.widthBits, 64);
});
