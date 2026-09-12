// Navigation tests use synthetic links over canonical owner references. These
// links are never competitor evidence, ABI proof or executable-path witnesses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workFor } from './helpers.mjs';
import { pipelineResult } from './pipeline-fixture.mjs';
import { buildCanonicalQueryProjection, composeCanonicalQueryProjections } from '../../js/analysis/query/semantic/projection.js';
import { compileSemanticQuery } from '../../js/analysis/query/semantic/plan.js';
import { SemanticQueryExecution } from '../../js/analysis/query/semantic/execute.js';
import { ScopedInterproceduralProjectionBuilder } from '../../js/analysis/query/semantic/interprocedural.js';
import { assertScopedFlowClosureCurrent } from '../../js/analysis/query/semantic/balanced-flow.js';
import { enumerateBalancedFlowPaths } from './balanced-flow-reference.mjs';

async function graph(t, entryKinds = ['data', 'address']) {
  const f = fixture(), parts = [];
  for (const base of [0x1000n, 0x2000n, 0x3000n]) parts.push(await buildCanonicalQueryProjection(pipelineResult({ base }).pipeline,
    { ...f, snapshotId: 'snap', work: workFor(t), sourceStatus: 'complete' }));
  const ids = { a: parts[0].recordAt(0).id, z: parts[0].recordAt(1).id,
    b: parts[1].recordAt(0).id, r: parts[1].recordAt(1).id,
    c: parts[2].recordAt(0).id, wrong: parts[2].recordAt(1).id };
  const bridge = (id, from, to, direction, callSite, caller, callee, flowKinds) => ({ id, from: ids[from], to: ids[to],
    kind: 'call-summary', relation: 'possible-dependence', executablePathProven: false, obligations: ['test-link-unqualified'],
    ...(flowKinds ? { flowKinds } : {}), boundary: { direction, callSite,
      callerFunctionId: parts[caller].functionId, calleeFunctionId: parts[callee].functionId } });
  const edges = [bridge('ab', 'a', 'b', 'enter', 'outer', 0, 1, entryKinds),
    bridge('bc', 'b', 'c', 'enter', 'inner', 1, 2), bridge('cr', 'c', 'r', 'return', 'inner', 1, 2),
    bridge('rz', 'r', 'z', 'return', 'outer', 0, 1, ['data']),
    bridge('wrong-return', 'r', 'wrong', 'return', 'foreign-callsite', 2, 1),
    bridge('recursive-enter', 'b', 'b', 'enter', 'recursive', 1, 1),
    bridge('recursive-return', 'b', 'r', 'return', 'recursive', 1, 1, ['data']),
  ];
  const make = async () => composeCanonicalQueryProjections(parts, edges, [], { ...f, snapshotId: 'snap', work: workFor(t) });
  t.after(() => parts.forEach(part => part.release()));
  return { f, ids, edges, make };
}
async function execution(t, g, source, sink, options = {}) {
  const plan = compileSemanticQuery({ scope: { functionIds: ['explicit-scope'] }, resultLimit: 256,
    select: { op: 'eq', field: 'id', value: source },
    flow: { to: { op: 'eq', field: 'id', value: sink }, edgeKinds: ['call-summary'], maxDepth: 8, maxPaths: 128, ...options } }, g.f);
  const e = new SemanticQueryExecution({ ...g.f, plan, isCurrent: () => true, loadProjection: async () => ({ projection: await g.make() }) });
  t.after(() => e.close()); return e;
}

test('production balanced traversal agrees with independently enumerated finite recursive programs', { timeout: 20000 }, async t => {
  const g = await graph(t); let comparisons = 0;
  for (const direction of ['forward', 'backward']) for (const maxCallDepth of [0, 1, 2, 3]) {
    for (const [source, sink] of [[g.ids.a, g.ids.z], [g.ids.a, g.ids.wrong], [g.ids.z, g.ids.a]]) {
      for (const kind of ['data', 'address', 'control']) {
        const flowKinds = [kind], e = await execution(t, g, source, sink, { direction, maxCallDepth, flowKinds });
        const result = await e.step({ limits: { deadlineMs: 10000, residentBytes: 64 * 1024 * 1024 } });
        const oracle = enumerateBalancedFlowPaths({ nodes: Object.values(g.ids), edges: g.edges, source, target: sink,
          direction, maxDepth: 8, maxCallDepth, flowKinds });
        assert.equal(result.results.length > 0, oracle.reached, JSON.stringify({ direction, maxCallDepth, kind, source, sink }));
        for (const row of result.results) {
          assert.deepEqual(row.flowKinds, [kind]); assert.equal(row.callContext.everyReturnMatched, true);
          assert.ok(oracle.paths.some(path => JSON.stringify(path.edgeIds) === JSON.stringify(row.edges.map(edge => edge.id))));
          assert.equal(row.exact, false); assert.equal(row.executablePathProven, false);
        }
        assert.equal(result.existence, result.results.length ? 'POSSIBLE' : 'UNKNOWN');
        assert.equal(result.flowClosure.semanticAbsenceProven, false);
        e.close(); comparisons++;
      }
    }
  }
  assert.equal(comparisons, 72);
});

test('flow kinds are retained across a neutral edge instead of changing address into data', async t => {
  const g = await graph(t), e = await execution(t, g, g.ids.a, g.ids.z, { flowKinds: ['address', 'data'], maxCallDepth: 2 });
  const result = await e.step({ limits: { deadlineMs: 10000 } });
  assert.equal(result.results.length, 1); assert.deepEqual(result.results[0].flowKinds, ['data']);
  assert.ok(result.flowClosure.cuts.includes('call-context-depth-cut'));
});

test('default navigation preserves mixed data/address paths and reports the selector semantics', async t => {
  const g = await graph(t, ['address']), mixed = await execution(t, g, g.ids.a, g.ids.z, { maxCallDepth: 2 });
  const answer = await mixed.step({ limits: { deadlineMs: 10000 } });
  const reference = enumerateBalancedFlowPaths({ nodes: Object.values(g.ids), edges: g.edges,
    source: g.ids.a, target: g.ids.z, maxDepth: 8, maxCallDepth: 2, flowKinds: null });
  assert.equal(reference.reached, true);
  assert.equal(answer.results.length, 1);
  assert.ok(reference.paths.some(path => JSON.stringify(path.edgeIds) === JSON.stringify(answer.results[0].edges.map(edge => edge.id))));
  assert.equal(answer.results[0].flowKinds, null);
  assert.equal(answer.results[0].flowKindPolicy, 'mixed-dependence-navigation');
  assert.ok(answer.results[0].edges.some(edge => edge.flowKinds?.includes('address')));
  assert.ok(answer.results[0].edges.some(edge => edge.flowKinds?.includes('data')));
  const selected = await execution(t, g, g.ids.a, g.ids.z, { maxCallDepth: 2, flowKinds: ['data', 'address'] });
  const homogeneous = await selected.step({ limits: { deadlineMs: 10000 } });
  assert.equal(homogeneous.results.length, 0);
  assert.equal(homogeneous.flowClosure.flowKindPolicy, 'homogeneous-kind-selection');
  assert.equal(homogeneous.flowClosure.semanticAbsenceProven, false);
});

test('small work pages resume the same typed balanced search without replaying or dropping paths', async t => {
  const g = await graph(t), full = await execution(t, g, g.ids.a, g.ids.z, { flowKinds: ['data'], maxCallDepth: 3 });
  const expected = await full.step({ limits: { deadlineMs: 10000 } });
  const paged = await execution(t, g, g.ids.a, g.ids.z, { flowKinds: ['data'], maxCallDepth: 3 });
  const rows = []; let result;
  for (let step = 0; step < 100; step++) {
    result = await paged.step({ limits: { deadlineMs: 10000, workUnits: 128 } }); rows.push(...result.results);
    if (!result.resumable) break;
  }
  assert.equal(result.enumerationComplete, true); assert.equal(result.resumable, false);
  assert.deepEqual(rows, expected.results);
  assert.deepEqual(result.flowClosure.searches, expected.flowClosure.searches);
  assert.equal(new Set(rows.map(row => row.sink + JSON.stringify(row.flowKinds))).size, rows.length);
});

test('simultaneous path and call-context limits retain an open boundary cut', async t => {
  const g = await graph(t), e = await execution(t, g, g.ids.a, g.ids.z,
    { flowKinds: ['data'], maxDepth: 1, maxCallDepth: 1 });
  const result = await e.step({ limits: { deadlineMs: 10000 } });
  assert.equal(result.results.length, 0);
  assert.ok(result.flowClosure.cuts.includes('call-context-depth-cut'));
  assert.equal(result.flowClosure.relationClosure, 'open');
  assert.equal(result.flowClosure.absence, 'UNKNOWN');
});

for (const [edgeKind, closed] of [['ssa-use-def', true], ['call-summary', false]]) test(`scoped negative ${edgeKind} closure requires owners and is invalidated by a late edge`, async t => {
  const f = fixture(), raw = structuredClone(pipelineResult().pipeline);
  // An explicitly empty synthetic owner graph tests relation closure only. It
  // is not evidence that an actual function or binary has no instructions.
  raw.semanticIr.nodes = []; raw.semanticIr.values = []; raw.semanticIr.blocks = [];
  raw.semanticIr.completeness = 'complete'; raw.semanticIr.unknowns = [];
  raw.ssa.definitions = []; raw.ssa.uses = []; raw.ssa.useDefLinks = [];
  raw.memorySsa.definitions = []; raw.memorySsa.uses = []; raw.memorySsa.regions = []; raw.memorySsa.blockStates = [];
  const p = await buildCanonicalQueryProjection(raw, { ...f, snapshotId: 'snap', work: workFor(t), sourceStatus: 'complete' });
  const plan = compileSemanticQuery({ scope: { functionIds: ['empty-fixture'], expectClosed: true }, select: { op: 'all' },
    flow: { to: { op: 'all' }, edgeKinds: [edgeKind], flowKinds: ['data'] } }, f);
  let revision = 0;
  const e = new SemanticQueryExecution({ ...f, plan, isCurrent: () => true,
    loadProjection: () => ({ projection: p, isCurrent: () => revision === 0 }) });
  t.after(() => e.close());
  const result = await e.step({ limits: { deadlineMs: 10000 } });
  assert.equal(result.flowClosure.relationClosure, closed ? 'closed' : 'open');
  assert.equal(result.flowClosure.absence, closed ? 'NO_PATH_IN_BOUND_RELATION_GRAPH' : 'UNKNOWN');
  if (!closed) assert.ok(result.flowClosure.cuts.includes('interprocedural-flow-owner-not-bound'));
  assert.equal(result.existence, 'UNKNOWN'); assert.equal(result.flowClosure.semanticAbsenceProven, false);
  assertScopedFlowClosureCurrent(result.flowClosure);
  assert.throws(() => assertScopedFlowClosureCurrent(structuredClone(result.flowClosure)), /owned-report/);
  revision++;
  assert.throws(() => assertScopedFlowClosureCurrent(result.flowClosure), /stale/);
  await assert.rejects(e.step(), /stale/);
});

test('canonical role tags distinguish address and stored value inputs; memory block ports bind owner digests', async t => {
  const f = fixture(), raw = pipelineResult().pipeline;
  const p = await buildCanonicalQueryProjection(raw, { ...f, snapshotId: 'snap', work: workFor(t) });
  t.after(() => p.release());
  const store = raw.semanticIr.nodes.find(node => node.kind === 'store'), reference = p.entityReference('semantic-ir', store.id);
  const inputs = p.adjacent(reference, 'backward').map(id => p.edge(id)).filter(edge => edge.kind === 'operation-input');
  assert.ok(inputs.some(edge => edge.flowKinds?.length === 1 && edge.flowKinds[0] === 'address'));
  assert.ok(inputs.some(edge => edge.flowKinds?.includes('data') && !edge.flowKinds.includes('address')));
  const block = raw.memorySsa.blockStates[0]; assert.deepEqual(p.canonicalMemoryBlockState(block.blockId), block);
  assert.deepEqual(p.canonicalMemoryRegion(block.exit[0].regionId), raw.memorySsa.regions.find(row => row.id === block.exit[0].regionId));
  const changed = structuredClone(raw); changed.memorySsa.blockStates[0].exit = [];
  const next = await buildCanonicalQueryProjection(changed, { ...f, snapshotId: 'snap', work: workFor(t) });
  t.after(() => next.release()); assert.notEqual(next.inputIdentity.ownerDigests.memoryssa, p.inputIdentity.ownerDigests.memoryssa);
});

test('releasing completed interprocedural navigation keeps dependency freshness and late owner invalidation', async t => {
  const f = fixture(); let revision = 0;
  const scopeBuilder = new ScopedInterproceduralProjectionBuilder({ ...f, snapshotId: 'snap', functionIds: ['f'],
    isCurrent: () => true, loadProjection: async (_locator, { work }) => ({
      projection: await buildCanonicalQueryProjection(pipelineResult().pipeline, { ...f, snapshotId: 'snap', work }),
      isCurrent: () => revision === 0,
    }) });
  const plan = compileSemanticQuery({ scope: { functionIds: ['f'] }, select: { op: 'eq', field: 'id', value: 'absent-fixture-ref' },
    flow: { to: { op: 'all' }, flowKinds: ['data'] } }, f);
  const e = new SemanticQueryExecution({ ...f, plan, scopeBuilder, isCurrent: () => true,
    loadProjection: () => assert.fail('scope builder owns loading') });
  t.after(() => e.close()); let result;
  for (let page = 0; page < 4; page++) { result = await e.step({ limits: { deadlineMs: 10000 } }); if (!result.resumable) break; }
  assert.equal(result.enumerationComplete, true);
  e.close(); assertScopedFlowClosureCurrent(result.flowClosure);
  revision++;
  assert.throws(() => assertScopedFlowClosureCurrent(result.flowClosure), /stale/);
});

for (const kinds of [[], ['imaginary'], ['data', 1]]) test('unrecognized or empty flow kind selectors are rejected', () => {
  const f = fixture(); assert.throws(() => compileSemanticQuery({ scope: { functionIds: ['f'] },
    flow: { to: { op: 'all' }, flowKinds: kinds } }, f));
});
