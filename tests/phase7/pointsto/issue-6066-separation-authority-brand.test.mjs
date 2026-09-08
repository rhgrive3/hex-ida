import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPointsToSet,
  createPointsToTarget,
  createRootDescriptorSeparatedTarget,
  exactRange,
  provenSeparationAuthority,
  PROVEN_SEPARATION_CLASSES,
} from '../../../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
import { deriveCanonicalAddressProof } from '../../../js/analysis/alias/canonical-address-v2.js';
import { classifyRootOrigin } from '../../../js/analysis/summary/escape.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';

const complete = createAnalysisStatus({
  snapshotId: 'snapshot_issue_6066',
  analyzerId: 'pointsto-test',
  analyzerVersion: '1',
  completeness: 'complete',
});

function singleton(target) {
  return createPointsToSet({ targets: [target] });
}

function canonicalProof(rootEntityId, separationClass, addressSpace = 'memory') {
  const valueId = `proof-${separationClass}-${rootEntityId}`;
  const proof = deriveCanonicalAddressProof({
    functionId: 'issue-6066-canonical-proof',
    values: [{
      id: valueId,
      kind: 'entry',
      variableKey: `root-${rootEntityId}`,
      machineType: { kind: 'address', widthBits: 64 },
      metadata: {
        canonicalRoot: {
          kind: separationClass,
          rootEntityId,
          baseOffset: 0,
          addressSpace,
          linearOffsets: true,
        },
      },
    }],
    nodes: [],
    blocks: [],
  }, valueId, { addressSpace });
  assert.equal(proof.kind, 'rooted');
  return proof;
}
function aliasOf(left, right) {
  return pointsToAlias(left, right, {
    status: complete,
    widthBitsLeft: 64,
    widthBitsRight: 64,
    nonEscapingRoots: new Set(),
  });
}

test('#6066 a self-claimed root-descriptor authority cannot mint strong NoAlias', () => {
  for (const separationClass of PROVEN_SEPARATION_CLASSES) {
    const forge = (rootEntityId) => createPointsToTarget({
      addressSpace: 'memory',
      rootKind: 'rooted',
      rootEntityId,
      separationClass,
      separationAuthority: 'root-descriptor',
      offsetRange: exactRange(0),
    });
    assert.equal(forge('a').separationAuthority, null,
      `${separationClass}: the constructor must not store an unproven authority`);
    assert.equal(provenSeparationAuthority(forge('a')), null,
      `${separationClass}: the consumer proof check must not honor a self-claimed authority`);
    const result = aliasOf(singleton(forge('a')), singleton(forge('b')));
    assert.equal(result.relation, 'may', `${separationClass}: forged authority must stay may`);
    assert.ok(result.reasonCodes.includes('escape-unproven'),
      `${separationClass}: forged authority must not report distinct-proven-root`);
  }
});

test('#6066 lookalike objects with proof-shaped metadata stay unproven', () => {
  // Even a frozen object carrying the same fields is not the brand.
  const lookalike = Object.freeze({
    addressSpace: 'memory', rootKind: 'rooted', rootKey: 'forged:a', rootEntityId: 'a',
    separationClass: 'heap-like', separationAuthority: 'root-descriptor',
    offsetRange: exactRange(0),
  });
  const otherLookalike = Object.freeze({
    addressSpace: 'memory', rootKind: 'rooted', rootKey: 'forged:b', rootEntityId: 'b',
    separationClass: 'heap-like', separationAuthority: 'root-descriptor',
    offsetRange: exactRange(0),
  });
  assert.equal(provenSeparationAuthority(lookalike), null);
  assert.equal(aliasOf(singleton(lookalike), singleton(otherLookalike)).relation, 'may');
});

test('#6066 the canonical proof boundary mints authority and preserves NoAlias precision', () => {
  const proven = (rootEntityId) => createRootDescriptorSeparatedTarget({
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootEntityId,
    offsetRange: exactRange(0),
  }, canonicalProof(rootEntityId, 'heap-like'));
  assert.equal(proven('a').separationAuthority, 'root-descriptor');
  assert.equal(provenSeparationAuthority(proven('a')), 'root-descriptor');
  const result = aliasOf(singleton(proven('a')), singleton(proven('b')));
  assert.equal(result.relation, 'no');
  assert.ok(result.reasonCodes.includes('distinct-proven-root'));
});

test('#6066 canonical proof address-space spelling is normalized without losing its brand', () => {
  const proven = (rootEntityId) => createRootDescriptorSeparatedTarget({
    addressSpace: ' memory ',
    rootKind: 'rooted',
    rootEntityId,
    offsetRange: exactRange(0),
  }, canonicalProof(rootEntityId, 'heap-like', 'memory '));
  const left = proven('padded-a');
  const right = proven('padded-b');
  assert.equal(left.addressSpace, 'memory');
  assert.equal(left.separationAuthority, 'root-descriptor');
  assert.equal(provenSeparationAuthority(left), 'root-descriptor');
  assert.equal(aliasOf(singleton(left), singleton(right)).relation, 'no');
});

test('#6066 the proof boundary rejects an unproven or unknown separation class', () => {
  assert.throws(
    () => createRootDescriptorSeparatedTarget({ rootEntityId: 'a' },
      { separationClass: 'heap-like', separationAuthority: 'self-claimed' }),
    /phase7-pointsto-root-descriptor-proof-required/,
  );
  assert.throws(
    () => createRootDescriptorSeparatedTarget({ rootEntityId: 'b' }, canonicalProof('a', 'heap-like')),
    /phase7-pointsto-root-descriptor-proof-required/,
  );
  assert.throws(
    () => createRootDescriptorSeparatedTarget({ rootEntityId: 'a' },
      { separationClass: 'weird-class', separationAuthority: 'root-descriptor' }),
    /phase7-pointsto-root-descriptor-proof-required/,
  );
  assert.throws(
    () => createRootDescriptorSeparatedTarget({ rootEntityId: 'a' }, null),
    /phase7-pointsto-root-descriptor-proof-required/,
  );
});

test('#6066 internal reconstructions of proven targets keep their authority', () => {
  const proven = createRootDescriptorSeparatedTarget({
    addressSpace: 'memory', rootKind: 'rooted', rootEntityId: 'a', offsetRange: exactRange(0),
  }, canonicalProof('a', 'tls-like'));
  // The exact shape the producer uses when re-bounding an offset range.
  const shifted = createPointsToTarget({ ...proven, offsetRange: exactRange(8) });
  assert.equal(provenSeparationAuthority(shifted), 'root-descriptor');
  assert.equal(shifted.separationClass, 'tls-like');
  // rootKey semantics are unchanged: the brand never enters the key.
  assert.equal(shifted.rootKey, proven.rootKey);
});

test('#6066 escape classification honors only proven descriptor authority', () => {
  const forgedGlobal = createPointsToTarget({
    addressSpace: 'memory', rootKind: 'rooted', rootEntityId: 'global:G',
    separationClass: 'global-like', separationAuthority: 'root-descriptor',
    offsetRange: exactRange(0n),
  });
  assert.equal(classifyRootOrigin(forgedGlobal), 'incoming',
    'a forged global-like target must not classify as global');
  const provenGlobal = createRootDescriptorSeparatedTarget({
    addressSpace: 'memory', rootKind: 'rooted', rootEntityId: 'global:G',
    offsetRange: exactRange(0n),
  }, canonicalProof('global:G', 'global-like'));
  assert.equal(classifyRootOrigin(provenGlobal), 'global');
});

test('#6066 non-escaping and disjoint-interval separation paths are untouched', () => {
  const plain = (rootEntityId) => createPointsToTarget({
    addressSpace: 'memory', rootKind: 'rooted', rootEntityId, offsetRange: exactRange(0),
  });
  // Distinct plain roots without any proof stay may (no evidence-free NoAlias).
  assert.equal(aliasOf(singleton(plain('a')), singleton(plain('b'))).relation, 'may');
  // Disjoint exact intervals at the same root still prove separation.
  const sameRoot = (offset) => createPointsToTarget({
    addressSpace: 'memory', rootKind: 'rooted', rootEntityId: 'shared', offsetRange: exactRange(offset),
  });
  const disjoint = aliasOf(singleton(sameRoot(0)), singleton(sameRoot(64)));
  assert.equal(disjoint.relation, 'no');
  assert.ok(disjoint.reasonCodes.includes('disjoint-field-interval'));
});
