import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeEscape } from '../../../js/analysis/summary/escape.js';

const completeStatus = Object.freeze({ completeness: 'complete' });

function value(id, kind) {
  return {
    id,
    kind: 'definition',
    machineType: kind === 'address'
      ? { kind, widthBits: 64, addressSpace: 'memory' }
      : kind === 'float'
        ? { kind, widthBits: 64, format: 'binary64' }
        : kind === 'vector'
          ? { kind, laneCount: 2, elementType: { kind: 'bitvector', widthBits: 32 } }
          : { kind, widthBits: kind === 'predicate' ? 1 : 64 },
  };
}

function localTarget(rootKey = 'local-A') {
  return { rootKey, rootKind: 'stack-like' };
}

function run(ir, pointsTo, options = {}) {
  return analyzeEscape(ir, null, null, {
    status: completeStatus,
    pointsTo: new Map(pointsTo),
  }, { snapshotId: 'snapshot-issue-4773', ...options });
}

test('known scalar stores do not become unresolved pointer flows (#4773)', () => {
  for (const kind of ['bitvector', 'float', 'vector', 'predicate']) {
    const result = run({
      values: [value('addr', 'address'), value('scalar', kind)],
      nodes: [{
        id: `store-${kind}`,
        kind: 'store',
        inputs: ['addr', 'scalar'],
        memory: { addressExpr: { valueId: 'addr' } },
        origin: { instructionIds: [`i-${kind}`] },
      }],
    }, [['addr', { top: false, targets: [localTarget()] }]]);

    assert.equal(result.sawUnresolvedFlow, false, kind);
    assert.equal(result.status.completeness, 'complete', kind);
    assert.deepEqual([...result.nonEscapingRoots], ['local-A'], kind);
    assert.deepEqual(result.escapes, [], kind);
  }
});

test('known scalar returns and complete-call arguments do not degrade escape completeness (#4773)', () => {
  const values = [value('scalar', 'bitvector')];
  const scalarReturn = run({
    values,
    nodes: [{ id: 'ret', kind: 'return', inputs: ['scalar'], origin: { instructionIds: ['i-ret'] } }],
  }, []);
  assert.equal(scalarReturn.sawUnresolvedFlow, false);
  assert.equal(scalarReturn.status.completeness, 'complete');

  const scalarCall = run({
    values,
    nodes: [{
      id: 'call', kind: 'call', inputs: ['scalar'],
      call: { completeness: 'complete', arguments: ['scalar'], targetValueIds: [] },
      origin: { instructionIds: ['i-call'] },
    }],
  }, []);
  assert.equal(scalarCall.sawUnresolvedFlow, false);
  assert.equal(scalarCall.status.completeness, 'complete');
  assert.deepEqual(scalarCall.escapes, []);
});

test('missing or TOP points-to evidence for typed pointers still fails closed (#4773)', () => {
  const pointer = value('ptr', 'address');
  for (const [name, pointsTo] of [
    ['missing', []],
    ['top', [['ptr', { top: true, targets: [] }]]],
  ]) {
    const returned = run({
      values: [pointer],
      nodes: [{ id: `ret-${name}`, kind: 'return', inputs: ['ptr'], origin: { instructionIds: [`i-ret-${name}`] } }],
    }, pointsTo);
    assert.equal(returned.sawUnresolvedFlow, true, `return/${name}`);
    assert.equal(returned.status.completeness, 'partial', `return/${name}`);

    const called = run({
      values: [pointer],
      nodes: [{
        id: `call-${name}`, kind: 'call', inputs: ['ptr'],
        call: { completeness: 'complete', arguments: ['ptr'], targetValueIds: [] },
        origin: { instructionIds: [`i-call-${name}`] },
      }],
    }, pointsTo);
    assert.equal(called.sawUnresolvedFlow, true, `call/${name}`);
    assert.equal(called.status.completeness, 'partial', `call/${name}`);

    const stored = run({
      values: [value('addr', 'address'), pointer],
      nodes: [{
        id: `store-${name}`, kind: 'store', inputs: ['addr', 'ptr'],
        memory: { addressExpr: { valueId: 'addr' } },
        origin: { instructionIds: [`i-store-${name}`] },
      }],
    }, [['addr', { top: false, targets: [localTarget()] }], ...pointsTo]);
    assert.equal(stored.sawUnresolvedFlow, true, `store/${name}`);
    assert.equal(stored.status.completeness, 'partial', `store/${name}`);
  }
});

test('unknown or malformed value typing remains conservative (#4773)', () => {
  for (const values of [
    [],
    [{ id: 'mystery', machineType: { kind: 'future-kind' } }],
    [{ id: 'mystery', machineType: { kind: 'bitvector' } }],
  ]) {
    const result = run({
      values,
      nodes: [{ id: 'ret-unknown', kind: 'return', inputs: ['mystery'], origin: { instructionIds: ['i-unknown'] } }],
    }, []);
    assert.equal(result.sawUnresolvedFlow, true);
    assert.equal(result.status.completeness, 'partial');
  }
});


test('adding scalar boundary flows does not withdraw an unrelated local non-escape proof (#4773)', () => {
  const values = [value('local-ptr', 'address'), value('scalar', 'bitvector')];
  const pointsTo = [['local-ptr', { top: false, targets: [localTarget('unrelated-local')] }]];
  const observeLocal = { id: 'copy-local', kind: 'copy', inputs: ['local-ptr'], origin: { instructionIds: ['i-copy'] } };

  const baseline = run({ values, nodes: [observeLocal] }, pointsTo);
  const withScalarFlows = run({
    values,
    nodes: [
      observeLocal,
      { id: 'ret-scalar', kind: 'return', inputs: ['scalar'], origin: { instructionIds: ['i-ret-scalar'] } },
      {
        id: 'call-scalar', kind: 'call', inputs: ['scalar'],
        call: { completeness: 'complete', arguments: ['scalar'], targetValueIds: [] },
        origin: { instructionIds: ['i-call-scalar'] },
      },
    ],
  }, pointsTo);

  assert.deepEqual([...baseline.nonEscapingRoots], ['unrelated-local']);
  assert.deepEqual([...withScalarFlows.nonEscapingRoots], [...baseline.nonEscapingRoots]);
  assert.equal(withScalarFlows.sawUnresolvedFlow, false);
  assert.equal(withScalarFlows.status.completeness, 'complete');
});

test('a forged points-to set on a typed scalar cannot create escape or non-escape roots (#4773)', () => {
  const result = run({
    values: [value('scalar', 'bitvector')],
    nodes: [{ id: 'ret-scalar', kind: 'return', inputs: ['scalar'], origin: { instructionIds: ['i-ret'] } }],
  }, [['scalar', { top: false, targets: [localTarget('forged-scalar-root')] }]]);

  assert.deepEqual(result.escapes, []);
  assert.deepEqual([...result.rootOrigins], []);
  assert.deepEqual([...result.nonEscapingRoots], []);
  assert.equal(result.sawUnresolvedFlow, false);
  assert.equal(result.status.completeness, 'complete');
});

test('typed pointer stores retain boundary escape records and containment propagation (#4773)', () => {
  const values = [value('dest', 'address'), value('ptr', 'address')];
  for (const [rootKind, expectedReason] of [
    ['absolute', 'stored-to-global'],
    ['rooted', 'stored-through-argument'],
    ['opaque', 'stored-through-unknown-pointer'],
  ]) {
    const result = run({
      values,
      nodes: [{
        id: `store-${rootKind}`, kind: 'store', inputs: ['dest', 'ptr'],
        memory: { addressExpr: { valueId: 'dest' } },
        origin: { instructionIds: [`i-${rootKind}`] },
      }],
    }, [
      ['dest', { top: false, targets: [{ rootKey: `dest-${rootKind}`, rootKind }] }],
      ['ptr', { top: false, targets: [localTarget('published-child')] }],
    ]);
    assert.ok(result.escapes.some((record) => record.rootKey === 'published-child' && record.reason === expectedReason), rootKind);
    assert.equal(result.sawUnresolvedFlow, false, rootKind);
  }

  const contained = run({
    values: [value('outer', 'address'), value('inner', 'address')],
    nodes: [
      {
        id: 'store-inner', kind: 'store', inputs: ['outer', 'inner'],
        memory: { addressExpr: { valueId: 'outer' } },
        origin: { instructionIds: ['i-store-inner'] },
      },
      { id: 'ret-outer', kind: 'return', inputs: ['outer'], origin: { instructionIds: ['i-ret-outer'] } },
    ],
  }, [
    ['outer', { top: false, targets: [localTarget('outer-root')] }],
    ['inner', { top: false, targets: [localTarget('inner-root')] }],
  ]);
  assert.deepEqual(new Set(contained.escapes.map((record) => record.rootKey)), new Set(['outer-root', 'inner-root']));
  assert.equal(contained.nonEscapingRoots.has('inner-root'), false);
});

test('duplicate semantic value ids cannot make an ambiguous flow look scalar (#4773)', () => {
  const result = run({
    values: [value('ambiguous', 'bitvector'), value('ambiguous', 'address')],
    nodes: [{ id: 'ret-ambiguous', kind: 'return', inputs: ['ambiguous'], origin: { instructionIds: ['i-ambiguous'] } }],
  }, []);

  assert.equal(result.sawUnresolvedFlow, true);
  assert.equal(result.status.completeness, 'partial');
  assert.deepEqual(result.escapes, []);
});
