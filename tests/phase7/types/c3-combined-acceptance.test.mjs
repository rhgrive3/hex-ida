import assert from 'node:assert/strict';
import test from 'node:test';
import { TypeConstraintGraph, reconstructStructuralType, selectedTypeIfCertain, certainConclusions } from '../../../js/analysis/types/graph.js';
import { condenseTypeGraph } from '../../../js/analysis/types/scc.js';
import { TYPE_CASES, caseConstraints, caseExpectations } from '../corpus/types.mjs';
import { collectTypeMetrics } from '../../../tools/validation/phase7/lanes/types.mjs';

const SNAPSHOT = 'user-c3-type-acceptance';
const integer = { kind:'integer', widthBits:32 };
const field = (offset, sizeBytes, memberType) => ({ offset, sizeBytes, memberType });
const pointer = targetEntityId => ({ kind:'pointer', targetEntityId });
const struct = target => ({ kind:'struct', sizeBytes:16, alignBytes:8,
  members:[field(0, 8, pointer(target)), field(8, 4, integer)] });
// Expected layout is declared, not recomputed by a second layout engine.
const SHAPES = [
  { id:'linked-list', recursive:true, size:16, entries:[['A', struct('A')]] },
  { id:'mutual', recursive:true, size:16, entries:[['A', struct('B')], ['B', struct('A')]] },
  { id:'union', recursive:true, size:8, entries:[['A', { kind:'union', sizeBytes:8, alignBytes:8,
    members:[field(0, 8, pointer('A')), field(0, 4, integer)] }]] },
  { id:'array-of-union', recursive:true, size:16, entries:[['A', { kind:'array', length:2, strideBytes:8,
    elementType:{ kind:'union', sizeBytes:8, members:[field(0, 8, pointer('A'))] } }]] },
  { id:'array', recursive:false, size:12, entries:[['A', { kind:'array', length:3, strideBytes:4,
    elementType:{ ...integer, sizeBytes:4 }, alignBytes:4 }]] },
];
const MODES = ['complete', 'hard-conflict', 'soft-only', 'soft-tie', 'cancelled', 'budget', 'stale', 'no-evidence'];

function graphFor(shape, mode, reverse = false) {
  const graph = new TypeConstraintGraph({ snapshotId:SNAPSHOT,
    ...(mode === 'budget' ? { limits:{ maxConstraintsPerLayer:1 } } : {}) });
  const entries = reverse ? [...shape.entries].reverse() : shape.entries;
  if (mode !== 'no-evidence') for (const [entityId, descriptor] of entries) {
    const claim = { layer:'structural', entityId, descriptor };
    if (mode.startsWith('soft')) graph.addSoftEvidence({ kind:'use-shape', origin:'heuristic', weight:0.8, claim });
    else graph.addHardConstraint({ kind:'debug-type', origin:'debug-matched', claim });
  }
  if (mode === 'hard-conflict' || mode === 'soft-tie') {
    const descriptor = shape.entries[0][1].kind === 'array'
      ? { kind:'array', length:99, strideBytes:8 }
      : { kind:shape.entries[0][1].kind === 'union' ? 'struct' : 'union', sizeBytes:16 };
    const claim = { layer:'structural', entityId:'A', descriptor };
    if (mode === 'soft-tie') graph.addSoftEvidence({ kind:'use-shape', origin:'heuristic', weight:0.8, claim });
    else graph.addHardConstraint({ kind:'runtime-metadata-type', origin:'runtime-verified', claim });
  }
  if (mode === 'budget') for (const widthBits of [32, 64]) graph.addHardConstraint({ kind:'access-width', origin:'binary-evidence',
    claim:{ layer:'machine', entityId:'A', descriptor:{ widthBits } } });
  return graph;
}

for (const shape of SHAPES) for (const mode of MODES) {
  test(`C3-01 recursive/layout ${shape.id}/${mode}`, () => {
    const before = structuredClone(shape);
    const graph = graphFor(shape, mode);
    const signal = mode === 'cancelled' ? AbortSignal.abort() : null;
    const whole = graph.solveGraph({ signal });
    const result = whole.results.get('A') ?? graph.solveEntity('A', { signal });
    if (mode === 'stale') {
      assert.equal(reconstructStructuralType(result, 'A', { snapshotId:'different-snapshot' }), null);
      assert.equal(reconstructStructuralType(result, 'different-entity'), null);
    } else {
      const reconstructed = reconstructStructuralType(result, 'A', { snapshotId:SNAPSHOT, signal });
      if (mode === 'complete') {
        assert.equal(whole.status.completeness, 'complete');
        assert.ok(selectedTypeIfCertain(result, 'structural'));
        assert.equal(reconstructed.kind, shape.entries[0][1].kind);
        assert.equal(reconstructed.sizeBytes, shape.size);
        assert.equal(reconstructed.isRecursive, shape.recursive);
        if (shape.recursive) {
          assert.equal(reconstructed.recursiveIdentity, 'A');
          assert.equal(whole.recursiveComponents.length, 1);
          assert.deepEqual([...whole.recursiveComponents[0]].sort(), shape.entries.map(([id]) => id).sort());
        }
        if (shape.id === 'union') assert.equal(reconstructed.members.length, 2, 'overlapping alternatives must both survive');
        if (shape.id === 'array-of-union') assert.equal(reconstructed.elementType.kind, 'union');
        if (shape.id === 'array') { assert.equal(reconstructed.length, 3); assert.equal(reconstructed.strideBytes, 4); }
        const replay = graphFor(shape, mode, true).solveGraph().results.get('A');
        assert.deepEqual(replay, result, 'insertion order and replay cannot change certain layout');
      } else {
        assert.equal(selectedTypeIfCertain(result, 'structural'), null);
        assert.notEqual(reconstructed?.confidence, 'certain');
        if (mode === 'hard-conflict') assert.ok(result.layers.structural.contradictions.length > 0);
        if (mode === 'soft-tie') {
          assert.equal(result.layers.structural.selected, null);
          assert.ok(result.layers.structural.candidates.length >= 2);
        }
        if (mode === 'soft-only') assert.equal(result.layers.structural.confidence, 'probable');
        if (mode === 'cancelled') assert.equal(result.status.stopReason, 'cancelled');
        if (mode === 'budget') assert.equal(result.status.stopReason, 'budget-exhausted');
        if (mode === 'no-evidence') assert.equal(result.status.completeness, 'unsupported');
      }
    }
    assert.deepEqual(shape, before);
  });
}

for (const shape of SHAPES.filter(item => item.recursive)) {
  test(`C3-01 one-iteration ${shape.id} cannot publish its partial SCC as certain`, () => {
    const result = graphFor(shape, 'complete').solveGraph({ maxIterationsPerComponent:1 });
    assert.equal(result.status.stopReason, 'iteration-limit');
    for (const [id, entity] of result.results) {
      assert.deepEqual(certainConclusions(entity), []);
      assert.equal(reconstructStructuralType(entity, id).kind, 'unknown');
    }
  });
}

test('C3-01 frozen debug/no-debug corpus keeps certainty, contradictions and ambiguity separate', () => {
  assert.equal(TYPE_CASES.length, 10);
  for (const example of TYPE_CASES) for (const withDebug of [false, true]) {
    const graph = new TypeConstraintGraph({ snapshotId:SNAPSHOT });
    const constraints = caseConstraints(example, { withDebug });
    for (const hard of constraints.hard) graph.addHardConstraint(hard);
    for (const soft of constraints.soft) graph.addSoftEvidence(soft);
    const result = graph.solveEntity(example.entityId);
    const expected = caseExpectations(example, { withDebug });
    assert.deepEqual(certainConclusions(result).map(item => item.layer).sort(), [...expected.expectCertain].sort(), `${example.id}/${withDebug}`);
    for (const layer of expected.expectContradiction) {
      assert.ok(result.layers[layer].contradictions.length > 0);
      assert.equal(selectedTypeIfCertain(result, layer), null);
    }
    for (const layer of expected.expectAmbiguous) assert.equal(result.layers[layer].selected, null);
  }
  const metrics = collectTypeMetrics();
  assert.equal(metrics.candidate.falseCertainty, 0);
  assert.equal(metrics.debugAssisted.falseCertainty, 0);
  assert.equal(metrics.noDebug.falseCertainty, 0);
  assert.equal(metrics.candidate.missedContradictions, 0);
  assert.equal(metrics.guardHolds, true);
});

test('C3-01 pointer/integer hard conflict cannot be decided by a name or an unrelated clean type', () => {
  const graph = graphFor(SHAPES[0], 'complete');
  for (const [kind, origin, klass] of [['access-width', 'binary-evidence', 'pointer'], ['debug-type', 'debug-matched', 'integer']]) {
    graph.addHardConstraint({ kind, origin, claim:{ entityId:'A', layer:'machine', descriptor:{ class:klass, widthBits:64 } } });
  }
  graph.addSoftEvidence({ kind:'symbol-spelling', origin:'heuristic', weight:1,
    claim:{ entityId:'A', layer:'machine', descriptor:{ class:'pointer', widthBits:64 } } });
  graph.addHardConstraint({ kind:'access-width', origin:'binary-evidence',
    claim:{ entityId:'unrelated', layer:'machine', descriptor:{ class:'integer', widthBits:32 } } });
  const result = graph.solveGraph();
  assert.equal(selectedTypeIfCertain(result.results.get('A'), 'machine'), null);
  assert.ok(result.results.get('A').layers.machine.contradictions.length);
  assert.ok(selectedTypeIfCertain(result.results.get('A'), 'structural'), 'machine contradiction cannot destroy separate structural evidence');
  assert.ok(selectedTypeIfCertain(result.results.get('unrelated'), 'machine'));
});

test('C3-01 partial member and aggregate extents retain canonical unknown fields', () => {
  for (const descriptor of [
    { kind:'struct' },
    { kind:'struct', sizeBytes:8, members:[{ offset:0, memberType:{ kind:'unknown' } }] },
    { kind:'struct', members:[{ offset:8, memberType:{ kind:'integer', widthBits:32 } }] },
  ]) {
    const graph = new TypeConstraintGraph({ snapshotId:SNAPSHOT });
    graph.addHardConstraint({ kind:'debug-type', origin:'debug-matched',
      claim:{ layer:'structural', entityId:'Incomplete', descriptor } });
    const result = reconstructStructuralType(graph, 'Incomplete');
    assert.equal(result.kind, 'struct', 'declared aggregate identity does not imply complete layout');
    assert.equal(result.sizeBytes, descriptor.sizeBytes ?? null);
    for (const member of result.members) assert.equal(member.sizeBytes, null, 'missing extent is never zero or inferred from a type name');
    // #5190 retains its minimum alignment convention; this is not evidence
    // for a profile-specific ABI placement, which still needs explicit layout.
    assert.equal(result.alignBytes, 1);
  }
});

test('C3-01 bounded SCC traversal caches self edges and observes first-enumeration failure', () => {
  for (const mode of ['acyclic', 'self-recursive', 'first-failure']) {
    let calls = 0;
    const result = condenseTypeGraph(['A'], () => {
      calls++;
      if (calls > 1 || mode === 'first-failure') throw new Error('dependency enumeration failed');
      return mode === 'self-recursive' ? ['A'] : [];
    });
    assert.equal(calls, 1, 'no unbudgeted second self-edge probe');
    assert.equal(result.truncated, mode === 'first-failure');
    assert.equal(result.isRecursiveMap.get('A'), mode === 'self-recursive');
    assert.deepEqual(result.components, [['A']]);
  }
});
