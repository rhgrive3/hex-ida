import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claimsConflict,
  createHardConstraint,
  createSoftEvidence,
  createTypeClaim,
} from '../../../js/analysis/types/constraints.js';
import {
  TypeConstraintGraph,
  selectedTypeIfCertain,
  reconstructStructuralType,
} from '../../../js/analysis/types/graph.js';

const machine = (entityId, widthBits, klass = 'integer') => ({
  layer: 'machine', entityId, descriptor: { widthBits, class: klass },
});

const abi = (entityId, location, passingClass, extra = {}) => ({
  layer: 'abi', entityId, descriptor: { location, passingClass, ...extra },
});

const structuralField = (entityId, offset, sizeBytes, memberType, extra = {}) => ({
  layer: 'structural', entityId, descriptor: { offset, sizeBytes, memberType, ...extra },
});

const nominal = (entityId, name, aliases = []) => ({
  layer: 'nominal', entityId, descriptor: { name, aliases },
});

function graphFor(hard = [], soft = [], options = {}) {
  const graph = new TypeConstraintGraph({ snapshotId: 'snapshot_c3_01', ...options });
  for (const constraint of hard) graph.addHardConstraint(constraint);
  for (const evidence of soft) graph.addSoftEvidence(evidence);
  return graph;
}

// 1. Positive: Finite recursive struct recovery: struct Node { Node *next; int value; }
test('C3-01 Positive: finite recursive struct recovery preserves recursive identity', () => {
  const graph = graphFor([
    {
      kind: 'debug-type',
      origin: 'debug-matched',
      claim: structuralField('entity_node', 0, 8, {
        kind: 'pointer',
        targetEntityId: 'entity_node',
      }, { fieldName: 'next', alignBytes: 8 }),
    },
    {
      kind: 'debug-type',
      origin: 'debug-matched',
      claim: structuralField('entity_node', 8, 4, {
        kind: 'integer',
        name: 'int32',
        widthBits: 32,
      }, { fieldName: 'value', alignBytes: 4 }),
    },
    {
      kind: 'debug-type',
      origin: 'debug-matched',
      claim: nominal('entity_node', 'Node'),
    },
  ]);

  const result = graph.solveEntity('entity_node');
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.layers.structural.confidence, 'certain');
  assert.equal(result.layers.structural.contradictions.length, 0);

  const selected = result.layers.structural.selected;
  assert.ok(selected, 'structural type should be selected');
  assert.equal(selected.descriptor.isRecursive, true);
  assert.equal(selected.descriptor.recursiveIdentity, 'entity_node');
  assert.equal(selected.descriptor.members.length, 2);
  assert.equal(selected.descriptor.members[0].offset, 0);
  assert.equal(selected.descriptor.members[0].memberType.kind, 'pointer');
  assert.equal(selected.descriptor.members[0].memberType.targetEntityId, 'entity_node');
  assert.equal(selected.descriptor.members[1].offset, 8);
  assert.equal(selected.descriptor.members[1].sizeBytes, 4);

  const reconstructed = reconstructStructuralType(graph, 'entity_node');
  assert.ok(reconstructed);
  assert.equal(reconstructed.isRecursive, true);
  assert.equal(reconstructed.recursiveIdentity, 'entity_node');
  assert.equal(reconstructed.sizeBytes, 16); // 8-byte pointer at 0 + 4-byte int at 8 aligned to 8
  assert.equal(reconstructed.alignBytes, 8);
});

// 2. Positive: Mutual recursion A <-> B (struct A { B *b; int x; }, struct B { A *a; double y; })
test('C3-01 Positive: mutually recursive finite graph converges with stable identities', () => {
  const graph = graphFor([
    // Type A: field 0 -> B*, field 8 -> int32
    {
      kind: 'debug-type',
      origin: 'debug-matched',
      claim: structuralField('entity_A', 0, 8, {
        kind: 'pointer',
        targetEntityId: 'entity_B',
      }, { fieldName: 'b_ptr', alignBytes: 8 }),
    },
    {
      kind: 'debug-type',
      origin: 'debug-matched',
      claim: structuralField('entity_A', 8, 4, {
        kind: 'integer',
        name: 'int32',
        widthBits: 32,
      }, { fieldName: 'x', alignBytes: 4 }),
    },
    // Type B: field 0 -> A*, field 8 -> double (8 bytes)
    {
      kind: 'debug-type',
      origin: 'debug-matched',
      claim: structuralField('entity_B', 0, 8, {
        kind: 'pointer',
        targetEntityId: 'entity_A',
      }, { fieldName: 'a_ptr', alignBytes: 8 }),
    },
    {
      kind: 'debug-type',
      origin: 'debug-matched',
      claim: structuralField('entity_B', 8, 8, {
        kind: 'float',
        name: 'double',
        widthBits: 64,
      }, { fieldName: 'y', alignBytes: 8 }),
    },
  ]);

  const graphResult = graph.solveGraph();
  assert.equal(graphResult.status.completeness, 'complete');
  assert.equal(graphResult.recursiveComponents.length, 1);
  assert.deepEqual([...graphResult.recursiveComponents[0]].sort(), ['entity_A', 'entity_B']);

  const resA = graphResult.results.get('entity_A');
  const resB = graphResult.results.get('entity_B');
  assert.ok(resA && resB);
  assert.equal(resA.layers.structural.selected.descriptor.isRecursive, true);
  assert.equal(resB.layers.structural.selected.descriptor.isRecursive, true);
  assert.deepEqual([...resA.layers.structural.selected.descriptor.sccMembers].sort(), ['entity_A', 'entity_B']);
});

// 3. Positive: Recursive array / pointer nesting
test('C3-01 Positive: nested array of recursive pointers solves canonically', () => {
  const graph = graphFor([
    {
      kind: 'debug-type',
      origin: 'debug-matched',
      claim: structuralField('entity_tree', 0, 32, {
        kind: 'array',
        length: 4,
        strideBytes: 8,
        elementType: {
          kind: 'pointer',
          targetEntityId: 'entity_tree',
        },
      }, { fieldName: 'children', alignBytes: 8 }),
    },
    {
      kind: 'debug-type',
      origin: 'debug-matched',
      claim: structuralField('entity_tree', 32, 4, {
        kind: 'integer',
        name: 'int32',
      }, { fieldName: 'val', alignBytes: 4 }),
    },
  ]);

  const result = graph.solveEntity('entity_tree');
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.layers.structural.selected.descriptor.isRecursive, true);
  assert.equal(result.layers.structural.selected.descriptor.members[0].memberType.kind, 'array');
  assert.equal(result.layers.structural.selected.descriptor.members[0].memberType.elementType.targetEntityId, 'entity_tree');
});

// 4. Negative: Conflicting field evidence at same offset
test('C3-01 Negative: same offset conflicting type candidates withhold selection', () => {
  const graph = graphFor([
    {
      kind: 'debug-type',
      origin: 'debug-matched',
      claim: structuralField('entity_conflict', 0, 8, { kind: 'integer', name: 'int64' }),
    },
    {
      kind: 'runtime-metadata-type',
      origin: 'runtime-verified',
      claim: structuralField('entity_conflict', 0, 8, { kind: 'float', name: 'double' }),
    },
  ]);

  const result = graph.solveEntity('entity_conflict');
  assert.equal(result.layers.structural.contradictions.length, 1);
  assert.equal(result.layers.structural.confidence, 'unknown');
  assert.equal(result.layers.structural.selected, null);
  assert.equal(selectedTypeIfCertain(result, 'structural'), null);
});

// 5. Negative: Size and alignment conflict
test('C3-01 Negative: size and alignment conflict on structural aggregate withholds selection', () => {
  const graph = graphFor([
    {
      kind: 'debug-type',
      origin: 'debug-matched',
      claim: {
        layer: 'structural',
        entityId: 'entity_bad_align',
        descriptor: { kind: 'struct', sizeBytes: 16, alignBytes: 8 },
      },
    },
    {
      kind: 'abi-location',
      origin: 'abi-boundary',
      claim: {
        layer: 'structural',
        entityId: 'entity_bad_align',
        descriptor: { kind: 'struct', sizeBytes: 24, alignBytes: 4 },
      },
    },
  ]);

  const result = graph.solveEntity('entity_bad_align');
  assert.equal(result.layers.structural.contradictions.length, 1);
  assert.equal(result.layers.structural.selected, null);
  assert.equal(selectedTypeIfCertain(result, 'structural'), null);
});

// 6. Negative: Metadata vs ABI conflict
test('C3-01 Negative: metadata vs ABI conflicting structural layout withholds selection', () => {
  const graph = graphFor([
    {
      kind: 'runtime-metadata-type',
      origin: 'runtime-verified',
      claim: structuralField('entity_meta_abi', 0, 4, { name: 'int32' }),
    },
    {
      kind: 'abi-location',
      origin: 'abi-boundary',
      claim: structuralField('entity_meta_abi', 0, 8, { name: 'int64' }),
    },
  ]);

  const result = graph.solveEntity('entity_meta_abi');
  assert.equal(result.layers.structural.contradictions.length, 1);
  assert.equal(result.layers.structural.selected, null);
});

// 7. Negative: Two equally valid structural candidates (tied soft ranking)
test('C3-01 Negative: two equally valid soft structural candidates preserve ambiguity', () => {
  const graph = graphFor([], [
    {
      kind: 'signature-candidate',
      origin: 'heuristic',
      weight: 0.5,
      claim: structuralField('entity_tied_struct', 0, 4, { name: 'int32' }),
    },
    {
      kind: 'decompiler-hint',
      origin: 'heuristic',
      weight: 0.5,
      claim: structuralField('entity_tied_struct', 0, 4, { name: 'float' }),
    },
  ]);

  const result = graph.solveEntity('entity_tied_struct');
  assert.equal(result.layers.structural.confidence, 'unknown');
  assert.equal(result.layers.structural.selected, null);
  assert.equal(result.layers.structural.candidates.length, 2);
});

// 8. Negative: Cycle that does not converge within budget
test('C3-01 Negative: cycle that does not converge publishes truncated status', () => {
  const graph = new TypeConstraintGraph({
    snapshotId: 'snapshot_cycle_test',
    limits: { maxIterationsPerComponent: 1 },
  });

  graph.addHardConstraint({
    kind: 'debug-type',
    origin: 'debug-matched',
    claim: structuralField('entity_cyc_1', 0, 8, { kind: 'pointer', targetEntityId: 'entity_cyc_2' }),
  });
  graph.addHardConstraint({
    kind: 'debug-type',
    origin: 'debug-matched',
    claim: structuralField('entity_cyc_2', 0, 8, { kind: 'pointer', targetEntityId: 'entity_cyc_1' }),
  });

  const graphResult = graph.solveGraph({ maxIterationsPerComponent: 1 });
  assert.equal(graphResult.status.completeness, 'truncated');
  assert.equal(graphResult.status.stopReason, 'iteration-limit');
});

// 9. Negative: Budget overflow fails closed
test('C3-01 Negative: constraint admission and comparison budgets fail closed', () => {
  const graph = new TypeConstraintGraph({
    snapshotId: 'snapshot_budget',
    limits: { maxConstraintsPerLayer: 2, maxComparisonsPerLayer: 10 },
  });

  graph.addHardConstraint({ kind: 'debug-type', origin: 'debug-matched', claim: structuralField('entity_overflow', 0, 4, { name: 'int32' }) });
  graph.addHardConstraint({ kind: 'debug-type', origin: 'debug-matched', claim: structuralField('entity_overflow', 4, 4, { name: 'int32' }) });
  graph.addHardConstraint({ kind: 'debug-type', origin: 'debug-matched', claim: structuralField('entity_overflow', 8, 4, { name: 'int32' }) }); // Truncated admission

  const result = graph.solveEntity('entity_overflow');
  assert.equal(result.status.completeness, 'truncated');
  assert.equal(result.status.stopReason, 'budget-exhausted');
  assert.equal(result.layers.structural.selected, null);
  assert.equal(selectedTypeIfCertain(result, 'structural'), null);
});

// 10. Negative: Cancellation during solve
test('C3-01 Negative: cancellation during solve produces partial cancelled status', () => {
  const graph = graphFor([
    { kind: 'debug-type', origin: 'debug-matched', claim: structuralField('entity_cancel', 0, 8, { kind: 'pointer', targetEntityId: 'entity_cancel' }) },
  ]);

  const controller = new AbortController();
  controller.abort();

  const result = graph.solveEntity('entity_cancel', { signal: controller.signal });
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.stopReason, 'cancelled');
  assert.equal(selectedTypeIfCertain(result, 'structural'), null);
});

// 11. Negative: Unknown size and alignment must not be guessed
test('C3-01 Negative: unknown size or alignment is not guessed as 0 or pointer size', () => {
  assert.throws(() => {
    createHardConstraint({
      kind: 'debug-type',
      origin: 'debug-matched',
      claim: {
        layer: 'structural',
        entityId: 'entity_invalid_size',
        descriptor: { offset: 0, sizeBytes: -4, memberType: { name: 'bad' } },
      },
    });
  }, /structural-size-invalid/);

  assert.throws(() => {
    createHardConstraint({
      kind: 'debug-type',
      origin: 'debug-matched',
      claim: {
        layer: 'structural',
        entityId: 'entity_invalid_offset',
        descriptor: { offset: -8, sizeBytes: 4, memberType: { name: 'bad' } },
      },
    });
  }, /structural-offset-invalid/);
});

// 12. Negative: Unsupported ABI profile must not default to host ABI
test('C3-01 Negative: unsupported ABI profile does not fallback to host ABI', () => {
  assert.throws(() => {
    createHardConstraint({
      kind: 'abi-location',
      origin: 'abi-boundary',
      claim: abi('entity_abi_unsupported', 'custom-reg', 'unknown-class', { abiProfile: 'unsupported-foreign-abi-v99' }),
      abiProfile: 'unsupported-foreign-abi-v99',
    });
  }, /abi-profile-unsupported/);
});

// 13. Determinism: Repeated solves produce identical digests
test('C3-01 Positive: repeated solve is deterministic and digest-stable', () => {
  const build = () => graphFor([
    { kind: 'debug-type', origin: 'debug-matched', claim: structuralField('e_det', 0, 8, { kind: 'pointer', targetEntityId: 'e_det' }) },
    { kind: 'debug-type', origin: 'debug-matched', claim: structuralField('e_det', 8, 4, { name: 'int32' }) },
    { kind: 'debug-type', origin: 'debug-matched', claim: nominal('e_det', 'DeterministicNode') },
  ]).solveEntity('e_det');

  const run1 = build();
  const run2 = build();
  assert.deepEqual(run1, run2);
});

// 14. C2-01 Dependency-gated fixture: Unresolved memory evidence is not promoted to exact type
test('C3-01 Dependency Boundary: unresolved C2-01 memory evidence remains conservative', () => {
  // Gated fixture representing upstream partial memory facts
  const graph = graphFor([], [
    {
      kind: 'use-shape',
      origin: 'heuristic',
      weight: 0.4,
      claim: structuralField('entity_c2_gated', 0, 4, { name: 'int32', source: 'c2-01-partial-reaching-store' }),
    },
  ]);

  const result = graph.solveEntity('entity_c2_gated');
  // Partial unverified memory evidence cannot reach 'certain' or complete structural selection
  assert.notEqual(result.layers.structural?.confidence, 'certain');
  assert.equal(selectedTypeIfCertain(result, 'structural'), null);
});
