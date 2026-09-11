import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPointsToSet,
  createPointsToTarget,
  createRootDescriptorSeparatedTarget,
  exactRange,
  joinPointsTo,
} from '../../../js/analysis/pointsto/lattice.js';
import { normalizeRootIdentity } from '../../../js/analysis/alias/canonical-address-v2-core.js';
import {
  deriveCanonicalAddressProof,
  isCanonicalRootDescriptorProof,
} from '../../../js/analysis/alias/canonical-address-v2.js';
import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';

const complete = createAnalysisStatus({
  snapshotId: 'snapshot_issue_5172',
  analyzerId: 'pointsto-test',
  analyzerVersion: '1',
  completeness: 'complete',
});

function target(rootIdentity, offset = 0) {
  return createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootIdentity,
    rootEntityId: 'root',
    offsetRange: exactRange(offset),
    widthBits: 64,
  });
}

function singleton(value) {
  return createPointsToSet({ targets: [value] });
}

function alias(left, right) {
  return pointsToAlias(singleton(left), singleton(right), {
    status: complete,
    widthBitsLeft: 64,
    widthBitsRight: 64,
    nonEscapingRoots: new Set(),
  });
}

test('#5172 lossy object members cannot become authoritative root identity', () => {
  for (const identity of [
    { source: undefined },
    { source() {} },
    { source: Symbol('root') },
    { source: NaN },
    { source: Infinity },
    { source: -Infinity },
  ]) {
    assert.throws(
      () => target(identity),
      /points-to-invalid-root-identity/,
      `lossy root identity ${String(identity.source)} must be rejected`,
    );
  }
});

test('#5172 root identity validation does not execute accessors', () => {
  let reads = 0;
  const identity = {};
  Object.defineProperty(identity, 'source', {
    enumerable: true,
    get() { reads += 1; return 'root'; },
  });
  assert.throws(() => target(identity), /points-to-invalid-root-identity/);
  assert.equal(reads, 0);
});

test('#5172 non-JSON identity forms that stringify like canonical data are rejected', () => {
  assert.throws(() => target(1n), /points-to-invalid-root-identity/);
  assert.throws(() => target(-0), /points-to-invalid-root-identity/);
  assert.throws(() => target(new Date('2026-09-10T00:00:00.000Z')), /points-to-invalid-root-identity/);
});

test('#5172 canonical identical roots still prove MustAlias', () => {
  const left = target({ kind: 'fixture-root', nested: ['a', 1, true, null] });
  const right = target({ nested: ['a', 1, true, null], kind: 'fixture-root' });
  assert.equal(left.rootKey, right.rootKey);
  const result = alias(left, right);
  assert.equal(result.relation, 'must');
  assert.ok(result.reasonCodes.includes('identical-root-and-exact-offset'));
});

test('#5172 same-root join still merges canonical targets', () => {
  const left = singleton(target({ id: 'same' }, 0));
  const right = singleton(target({ id: 'same' }, 8));
  const joined = joinPointsTo(left, right);
  assert.equal(joined.top, false);
  assert.equal(joined.targets.length, 1);
  assert.equal(joined.targets[0].offsetRange.min, 0n);
  assert.equal(joined.targets[0].offsetRange.max, 8n);
});

test('#5172 sparse and decorated arrays cannot collapse through JSON normalization', () => {
  const sparse = new Array(1);
  assert.throws(() => target(sparse), /points-to-invalid-root-identity/);
  const decorated = ['a'];
  decorated.extra = 'ignored-by-json-array';
  assert.throws(() => target(decorated), /points-to-invalid-root-identity/);
});

test('#5172 A2 SSA-entry rejects lossy physicalIdentity and preserves canonical equal roots', () => {
  const badVariable = {
    key: 'v1',
    kind: 'logical-state',
    scope: 'function',
    physicalIdentity: { source: undefined },
  };
  const emptyVariable = {
    key: 'v1',
    kind: 'logical-state',
    scope: 'function',
    physicalIdentity: {},
  };
  const equalVariable1 = {
    key: 'v1',
    kind: 'logical-state',
    scope: 'function',
    physicalIdentity: { reg: 'x0' },
  };
  const equalVariable2 = {
    key: 'v1',
    kind: 'logical-state',
    scope: 'function',
    physicalIdentity: { reg: 'x0' },
  };

  assert.equal(normalizeRootIdentity(badVariable, 'fn-5172'), null);
  const emptyIdentity = normalizeRootIdentity(emptyVariable, 'fn-5172');
  assert.ok(emptyIdentity);
  assert.notEqual(emptyIdentity, null);

  const id1 = normalizeRootIdentity(equalVariable1, 'fn-5172');
  const id2 = normalizeRootIdentity(equalVariable2, 'fn-5172');
  assert.deepEqual(id1, id2);

  const ir = {
    functionId: 'fn-5172',
    values: [
      { id: 'v_bad', kind: 'entry', variableKey: 'v_bad', machineType: { widthBits: 64 } },
      { id: 'v_empty', kind: 'entry', variableKey: 'v_empty', machineType: { widthBits: 64 } },
      { id: 'v_eq1', kind: 'entry', variableKey: 'v_eq1', machineType: { widthBits: 64 } },
      { id: 'v_eq2', kind: 'entry', variableKey: 'v_eq2', machineType: { widthBits: 64 } },
    ],
    nodes: [],
    blocks: [],
  };
  const cfg = { entryBlockId: 'b0', blocks: [{ id: 'b0', successors: [] }] };
  const ssa = {
    definitions: [
      {
        valueId: 'v_bad',
        kind: 'entry',
        definitionId: 'd_bad',
        proof: { variableIdentity: badVariable, machineType: { widthBits: 64 } },
      },
      {
        valueId: 'v_empty',
        kind: 'entry',
        definitionId: 'd_empty',
        proof: { variableIdentity: emptyVariable, machineType: { widthBits: 64 } },
      },
      {
        valueId: 'v_eq1',
        kind: 'entry',
        definitionId: 'd_eq1',
        proof: { variableIdentity: equalVariable1, machineType: { widthBits: 64 } },
      },
      {
        valueId: 'v_eq2',
        kind: 'entry',
        definitionId: 'd_eq2',
        proof: { variableIdentity: equalVariable2, machineType: { widthBits: 64 } },
      },
    ],
    uses: [],
  };

  const result = analyzeLocalPointsTo(ir, cfg, ssa);
  const badSet = result.ssaPointsTo.get('v_bad');
  const emptySet = result.ssaPointsTo.get('v_empty');
  const eq1Set = result.ssaPointsTo.get('v_eq1');
  const eq2Set = result.ssaPointsTo.get('v_eq2');

  assert.equal(badSet.top, true);
  assert.equal(emptySet.top, false);
  assert.notEqual(badSet.targets?.[0]?.rootKey, emptySet.targets?.[0]?.rootKey);
  const aliasBadEmpty = pointsToAlias(badSet, emptySet, { status: complete, widthBitsLeft: 64, widthBitsRight: 64 });
  assert.notEqual(aliasBadEmpty.relation, 'must');

  assert.equal(eq1Set.top, false);
  assert.equal(eq2Set.top, false);
  assert.equal(eq1Set.targets[0].rootKey, eq2Set.targets[0].rootKey);
  const aliasEqual = pointsToAlias(eq1Set, eq2Set, { status: complete, widthBitsLeft: 64, widthBitsRight: 64 });
  assert.equal(aliasEqual.relation, 'must');
});

test('#5172 branded root-descriptor proof rejects lossy rootIdentity and cannot alias {}', () => {
  const ir = {
    functionId: 'fn-5172-desc',
    values: [{ id: 'v1', kind: 'entry', variableKey: 'x0', machineType: { widthBits: 64 } }],
    nodes: [],
    blocks: [],
  };

  const badProof = deriveCanonicalAddressProof(ir, 'v1', {
    rootDescriptors: new Map([
      ['value:v1', { kind: 'heap-like', baseOffset: 0, rootIdentity: { source: undefined } }],
    ]),
  });
  assert.equal(badProof.kind, 'unknown');
  assert.equal(isCanonicalRootDescriptorProof(badProof), false);
  assert.throws(
    () => createRootDescriptorSeparatedTarget({ addressSpace: 'memory', offsetRange: exactRange(0n) }, badProof),
    /phase7-pointsto-root-descriptor-proof-required/,
  );

  const goodProof = deriveCanonicalAddressProof(ir, 'v1', {
    rootDescriptors: new Map([
      ['value:v1', { kind: 'heap-like', baseOffset: 0, rootIdentity: {} }],
    ]),
  });
  assert.equal(goodProof.kind, 'rooted');
  assert.equal(isCanonicalRootDescriptorProof(goodProof), true);
  assert.deepEqual(goodProof.rootIdentity, {});

  assert.throws(
    () => createRootDescriptorSeparatedTarget(
      { addressSpace: 'memory', rootIdentity: { source: undefined }, offsetRange: exactRange(0n) },
      goodProof,
    ),
    /points-to-invalid-root-identity/,
  );

  const proofA = deriveCanonicalAddressProof(ir, 'v1', {
    rootDescriptors: new Map([
      ['value:v1', { kind: 'heap-like', baseOffset: 0, rootIdentity: { heapId: 42 } }],
    ]),
  });
  const proofB = deriveCanonicalAddressProof(ir, 'v1', {
    rootDescriptors: new Map([
      ['value:v1', { kind: 'heap-like', baseOffset: 8, rootIdentity: { heapId: 42 } }],
    ]),
  });
  const targetA = createRootDescriptorSeparatedTarget(
    { addressSpace: 'memory', rootIdentity: { heapId: 42 }, offsetRange: exactRange(0n) },
    proofA,
  );
  const targetB = createRootDescriptorSeparatedTarget(
    { addressSpace: 'memory', rootIdentity: { heapId: 42 }, offsetRange: exactRange(8n) },
    proofB,
  );
  assert.equal(targetA.rootKey, targetB.rootKey);
  const targetA0 = createRootDescriptorSeparatedTarget(
    { addressSpace: 'memory', rootIdentity: { heapId: 42 }, offsetRange: exactRange(0n) },
    proofA,
  );
  const aliasResult = alias(targetA, targetA0);
  assert.equal(aliasResult.relation, 'must');

  const joined = joinPointsTo(singleton(targetA), singleton(targetB));
  assert.equal(joined.top, false);
  assert.equal(joined.targets.length, 1);
  assert.equal(joined.targets[0].offsetRange.min, 0n);
  assert.equal(joined.targets[0].offsetRange.max, 8n);
});
