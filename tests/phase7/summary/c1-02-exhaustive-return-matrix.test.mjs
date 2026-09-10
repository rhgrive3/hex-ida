import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { createFunctionSummary, functionSummaryDigest, RETURN_SUMMARY_CANDIDATE_LIMIT } from '../../../js/analysis/summary/contract.js';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';
import { solveInterproceduralSummaries } from '../../../js/analysis/summary/interprocedural.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { buildSemanticSsa } from '../../../js/semantics/ssa/build.js';

const snapshotId = 'c1-exhaustive-return-matrix';
const origin = id => ({ instructionIds:[`instruction_${id}`] });
const status = { snapshotId, analyzerId:'finite-return-fixture', analyzerVersion:'1', completeness:'complete' };
const KINDS = ['arg', 'root', 'allocation'];
const TOPOLOGIES = ['leaf', 'wrapper-chain', 'self-recursive', 'mutual-recursive'];
const MODES = ['direct', 'exhaustive', 'nonexhaustive', 'missing', 'stale', 'unknown'];

function caller(functionId, targets, { indirect = false, partial = false } = {}) {
  const ids = indirect ? ['arg0', 'arg1', 'callee_pointer'] : ['arg0', 'arg1'];
  const values = ids.map((id, index) => ({ id, kind:'definition', definitionNodeId:`read_${id}`,
    machineType:{ kind:'bitvector', widthBits:64 }, ...(index < 2 ? { metadata:{ argumentIndex:index } } : {}), origin:origin(id) }));
  const nodes = ids.map((id, index) => ({ id:`read_${id}`, kind:'state-read', blockId:'entry', inputs:[], outputs:[id],
    variable:{ key:`state:x${index}`, kind:'physical-state', scope:'function' }, origin:origin(id) }));
  values.push({ id:'ret', kind:'definition', definitionNodeId:'call', machineType:{ kind:'bitvector', widthBits:64 }, origin:origin('ret') });
  nodes.push({ id:'call', kind:'call', blockId:'entry', inputs:['arg0', 'arg1'], outputs:['ret'],
    call:{ targetValueIds:indirect ? ['callee_pointer'] : [], targetEntityIds:targets,
      arguments:['arg0', 'arg1'], returns:['ret'], memoryRead:{ scope:'none' }, memoryWrite:{ scope:'none' },
      stateReads:[], stateWrites:[], controlEffects:[], determinism:'deterministic', noreturn:false, mayThrow:false,
      summarySource:'finite-return-fixture', completeness:partial ? 'partial' : 'complete',
      ...(partial ? { unknownEffects:{ reason:'non-exhaustive-indirect-targets', categories:['control'] } } : {}) },
    ...(partial ? { completeness:'partial', unknown:{ reason:'non-exhaustive-indirect-targets', categories:['control'] } } : {}), origin:origin('call') });
  nodes.push({ id:'return', kind:'return', blockId:'entry', inputs:['ret'], outputs:[], origin:origin('return') });
  const ir = createSemanticIrFunction({ functionId, entryBlockId:'entry', origin:origin(functionId), values, nodes,
    completeness:partial ? 'partial' : 'complete', unknowns:partial ? [{ reason:'non-exhaustive-indirect-targets', categories:['control'] }] : [],
    blocks:[{ id:'entry', nodeIds:nodes.map(node => node.id), origin:origin('entry') }] });
  const cfg = createSemanticCfg({ functionId, entryBlockId:'entry', blocks:[{ id:'entry', successors:[] }] });
  return { ir, cfg, ssa:buildSemanticSsa(ir, cfg) };
}

function finiteFact(kind, index) {
  const common = { kind, returnIndex:0, offset:String(8 * (index + 1)) };
  return kind === 'arg' ? { ...common, argIndex:index }
    : kind === 'root' ? { ...common, rootEntityId:`object_${index}` }
      : { ...common, allocationSiteId:`allocation_${index}` };
}

function summaryGraph(kind, topology) {
  const locals = new Map();
  const leaves = ['leaf_a', 'leaf_b'];
  for (const [index, functionId] of leaves.entries()) {
    const targets = topology === 'self-recursive' ? [functionId]
      : topology === 'mutual-recursive' ? [leaves[1 - index]] : [];
    // Finite local return facts are the existing SCC solver's input contract.
    // Recursive calls here do not feed the local return expression: this pins
    // preservation/consumption of known facts, not recursive-value discovery.
    locals.set(functionId, createFunctionSummary({ functionId, inputs:['arg0', 'arg1'], returnValues:['ret'],
      returnProvenance:[finiteFact(kind, index)], directCalls:targets.map(target => ({
        callSiteId:`call_${functionId}`, targetEntityIds:[target], effectSource:'abi-rule' })),
      noreturn:false, mayThrow:false, status }));
  }
  let solved = solveInterproceduralSummaries({ roots:leaves, localSummaries:locals, snapshotId });
  assert.equal(solved.status.completeness, 'complete', JSON.stringify(solved.status));
  let targets = leaves;
  if (topology === 'wrapper-chain') for (let depth = 0; depth < 2; depth++) {
    const next = [];
    for (const [index, target] of targets.entries()) {
      const id = `wrapper_${depth}_${index}`, f = caller(id, [target]);
      const local = buildLocalFunctionSummary(f.ir, f.cfg, f.ssa, null, { snapshotId, calleeSummaries:solved.summaries }).summary;
      assert.ok(!local.returnProvenance.some(fact => fact.kind === 'unknown'));
      locals.set(id, local); next.push(id);
    }
    targets = next;
    solved = solveInterproceduralSummaries({ roots:targets, localSummaries:locals, snapshotId });
    assert.equal(solved.status.completeness, 'complete');
  }
  return { targets, summaries:solved.summaries };
}

function expectedTargets(kind, indices, result) {
  return indices.map(index => ({ root:kind === 'arg' ? result.pointsTo.get(`arg${index}`).targets[0].rootEntityId
    : kind === 'root' ? `object_${index}` : `allocation_${index}`, min:BigInt(8 * (index + 1)), max:BigInt(8 * (index + 1)) }));
}
const targetView = set => set.targets.map(target => ({ root:target.rootEntityId, min:target.offsetRange.min, max:target.offsetRange.max }))
  .sort((a, b) => a.root.localeCompare(b.root));

test('FR-C1-02 complete candidate unions improve actual callers across finite roots and summary graph shapes', t => {
  const rows = [], failures = [];
  for (const kind of KINDS) for (const topology of TOPOLOGIES) for (const mode of MODES) {
    const cell = `${kind}/${topology}/${mode}`;
    try {
      const graph = summaryGraph(kind, topology), summaries = new Map(graph.summaries);
      const targets = mode === 'direct' ? graph.targets.slice(0, 1) : graph.targets;
      const last = targets.at(-1), originalSummary = summaries.get(last);
      if (mode === 'missing') summaries.delete(last);
      if (mode === 'stale') summaries.set(last, createFunctionSummary({ ...originalSummary,
        status:{ ...originalSummary.status, snapshotId:'stale' } }));
      if (mode === 'unknown') summaries.set(last, createFunctionSummary({ ...originalSummary,
        returnProvenance:[{ kind:'unknown', returnIndex:0 }] }));
      const f = caller('outer_caller', targets, { indirect:mode !== 'direct', partial:mode === 'nonexhaustive' });
      const before = structuredClone(f), summaryBytes = [...summaries].map(([id, summary]) => [id, functionSummaryDigest(summary)]);
      const baseline = analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, { snapshotId });
      assert.equal(baseline.pointsTo.get('ret').top, true, 'precision comparison must begin with an unresolved call');
      const result = analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, { snapshotId, summaries });
      const set = result.pointsTo.get('ret'), positive = mode === 'direct' || mode === 'exhaustive';
      assert.equal(set.top, !positive, 'all complete alternatives must join; any incomplete alternative must retain unknown');
      if (positive) {
        assert.deepEqual(targetView(set), expectedTargets(kind, mode === 'direct' ? [0] : [0, 1], result).sort((a, b) => a.root.localeCompare(b.root)));
        for (const target of targets) assert.ok(result.calleeSummaryIds.includes(`summary:${functionSummaryDigest(summaries.get(target))}`), 'every consumed candidate digest must invalidate the caller');
      }
      const wrapper = buildLocalFunctionSummary(f.ir, f.cfg, f.ssa, null, { snapshotId, calleeSummaries:summaries }).summary;
      assert.equal(wrapper.returnProvenance.some(fact => fact.kind === 'unknown'), !positive, 'the real wrapper producer must retain the same candidate universe');
      if (positive) {
        assert.equal(wrapper.returnProvenance.length, targets.length);
        const outer = caller('outermost', [wrapper.functionId]);
        const consumed = analyzeLocalPointsTo(outer.ir, outer.cfg, outer.ssa, { snapshotId, summaries:new Map([[wrapper.functionId, wrapper]]) });
        assert.equal(consumed.pointsTo.get('ret').top, false, 'wrapper facts must reach another real caller, not just its summary object');
        assert.deepEqual(targetView(consumed.pointsTo.get('ret')), expectedTargets(kind, mode === 'direct' ? [0] : [0, 1], consumed).sort((a, b) => a.root.localeCompare(b.root)));
      }
      assert.deepEqual(structuredClone(f), before);
      assert.deepEqual([...summaries].map(([id, summary]) => [id, functionSummaryDigest(summary)]), summaryBytes);
      const replay = analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, { snapshotId, summaries });
      assert.deepEqual(replay.pointsTo.get('ret'), set); assert.deepEqual(replay.calleeSummaryIds, result.calleeSummaryIds);
      rows.push({ kind, topology, mode, positive, targetCount:set.targets.length, unresolved:set.top });
    } catch (error) { failures.push({ cell, message:error.message }); }
  }
  assert.equal(rows.length + failures.length, 72, 'never drop a later matrix cell after an early failure');
  t.diagnostic(JSON.stringify({ schema:'c1-exhaustive-return-v1', rows, failures }));
  assert.deepEqual(failures, []);
  assert.equal(rows.filter(row => row.positive).length, 24);
});

function mixedSummaries() {
  return new Map(KINDS.map((kind, index) => [kind, createFunctionSummary({ functionId:kind,
    returnProvenance:[finiteFact(kind, kind === 'arg' ? 0 : index)], noreturn:false, mayThrow:false, status })]));
}

test('exhaustive mixed roots are order invariant and every candidate digest tracks semantic changes', () => {
  const summaries = mixedSummaries();
  let reference;
  for (const targets of [KINDS, [...KINDS].reverse(), ['root', 'arg', 'allocation', 'root']]) {
    const f = caller('mixed', targets, { indirect:true });
    const result = analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, { snapshotId, summaries });
    assert.equal(result.pointsTo.get('ret').top, false);
    assert.equal(result.pointsTo.get('ret').targets.length, 3);
    assert.deepEqual(result.calleeSummaryIds, [...summaries.values()].map(summary => `summary:${functionSummaryDigest(summary)}`).sort());
    const wrapper = buildLocalFunctionSummary(f.ir, f.cfg, f.ssa, null, { snapshotId, calleeSummaries:summaries }).summary;
    const view = { targets:targetView(result.pointsTo.get('ret')), returns:wrapper.returnProvenance, dependencies:result.calleeSummaryIds };
    if (reference) assert.deepEqual(view, reference);
    reference = view;
  }
  for (const target of KINDS) {
    const changed = new Map(summaries), old = summaries.get(target);
    changed.set(target, createFunctionSummary({ ...old, returnProvenance:old.returnProvenance.map(fact => ({ ...fact, offset:'40' })) }));
    const f = caller('mixed', KINDS, { indirect:true });
    const result = analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, { snapshotId, summaries:changed });
    assert.equal(result.pointsTo.get('ret').top, false);
    assert.notDeepEqual(result.calleeSummaryIds, reference.dependencies);
    assert.notDeepEqual(targetView(result.pointsTo.get('ret')), reference.targets);
    assert.ok(!result.calleeSummaryIds.includes(`summary:${functionSummaryDigest(old)}`));
  }
});

test('each position retains unknown for missing, partial, incompatible or absent-return summaries', () => {
  const mutations = [
    () => null,
    summary => ({ ...summary, schemaVersion:999 }),
    summary => ({ ...summary, contractVersion:'stale' }),
    summary => createFunctionSummary({ ...summary, functionId:'wrong' }),
    summary => createFunctionSummary({ ...summary, status:{ ...status, snapshotId:'stale' } }),
    summary => createFunctionSummary({ ...summary, status:{ ...status, completeness:'partial', stopReason:'evidence-missing' } }),
    summary => createFunctionSummary({ ...summary, returnProvenance:[] }),
    summary => createFunctionSummary({ ...summary, returnProvenance:[...summary.returnProvenance, { kind:'unknown', returnIndex:0 }] }),
    summary => createFunctionSummary({ ...summary, returnProvenance:summary.returnProvenance.map(fact => ({ ...fact, returnIndex:1 })) }),
  ];
  for (const target of KINDS) for (const mutate of mutations) {
    const summaries = mixedSummaries(), changed = mutate(summaries.get(target));
    if (changed == null) summaries.delete(target); else summaries.set(target, changed);
    const f = caller('negative', KINDS, { indirect:true });
    const result = analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, { snapshotId, summaries });
    assert.equal(result.pointsTo.get('ret').top, true, `${target}: ${mutate}`);
    const wrapper = buildLocalFunctionSummary(f.ir, f.cfg, f.ssa, null, { snapshotId, calleeSummaries:summaries }).summary;
    assert.ok(wrapper.returnProvenance.some(fact => fact.kind === 'unknown'), `${target}: ${mutate}`);
  }
});

test('all candidate memory/control effects retain source authority and noreturn needs unanimous targets', () => {
  for (const allNoreturn of [false, true]) {
    const summaries = new Map(['a', 'b'].map((functionId, index) => [functionId, createFunctionSummary({ functionId,
      returnProvenance:[finiteFact('root', index)],
      memoryReadRegions:[{ regionKind:'unknown', broad:true, addressSpaces:[`read_${index}`], source:index ? 'library-model' : 'abi-rule' }],
      memoryWriteRegions:[{ regionKind:'unknown', broad:true, addressSpaces:[`write_${index}`], source:index ? 'library-model' : 'abi-rule' }],
      mayThrow:index === 1, noreturn:allNoreturn || index === 0, status })]));
    const f = caller('effect_wrapper', ['a', 'b'], { indirect:true });
    // No explicit return: check the call's noreturn knowledge, not the
    // separate rule that an observed function return defeats that fact.
    const ir = { ...f.ir, nodes:f.ir.nodes.filter(node => node.kind !== 'return') };
    const summary = buildLocalFunctionSummary(ir, f.cfg, f.ssa, null, { snapshotId, calleeSummaries:summaries }).summary;
    for (const dimension of ['memoryReadRegions', 'memoryWriteRegions']) {
      assert.equal(summary[dimension].length, 2);
      for (const callee of summaries.values()) for (const effect of callee[dimension]) assert.ok(summary[dimension].some(actual => actual.source === effect.source && actual.addressSpaces[0] === effect.addressSpaces[0]));
    }
    assert.equal(summary.mayThrow, true);
    assert.equal(summary.noreturn, allNoreturn);
    assert.equal(summary.indirectCallSets[0].exhaustive, true);
    assert.deepEqual(summary.indirectCallSets[0].candidateEntityIds, ['a', 'b']);
  }
});

test('candidate universe and target-set budgets remain separate and never publish a truncated union', () => {
  for (const count of [RETURN_SUMMARY_CANDIDATE_LIMIT, RETURN_SUMMARY_CANDIDATE_LIMIT + 1]) {
    const targets = Array.from({ length:count }, (_, index) => `candidate_${index}`);
    const summaries = new Map(targets.map(functionId => [functionId, createFunctionSummary({ functionId,
      returnProvenance:[finiteFact('root', 0)], noreturn:false, mayThrow:false, status })]));
    const f = caller('cap', targets, { indirect:true });
    let providerCalls = 0;
    const result = analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, { snapshotId, budget:{ maxTargetsPerSet:1 },
      summaryProvider(id) { providerCalls++; return summaries.get(id); } });
    const exceeded = count > RETURN_SUMMARY_CANDIDATE_LIMIT;
    assert.equal(result.pointsTo.get('ret').top, exceeded);
    if (exceeded) assert.equal(providerCalls, 0, 'over-budget universes must be rejected before invoking providers');
    else assert.equal(result.pointsTo.get('ret').targets.length, 1, 'many callees can share one proven root');
    const wrapper = buildLocalFunctionSummary(f.ir, f.cfg, f.ssa, null, { snapshotId, calleeSummaries:summaries }).summary;
    assert.equal(wrapper.returnProvenance.some(fact => fact.kind === 'unknown'), exceeded);
  }
  const f = caller('root_cap', KINDS, { indirect:true });
  const result = analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, { snapshotId, summaries:mixedSummaries(), budget:{ maxTargetsPerSet:1 } });
  assert.equal(result.pointsTo.get('ret').top, true);
});

test('cancellation from a candidate provider withholds finite returns', () => {
  const summaries = mixedSummaries();
  for (const cancelledTarget of [...KINDS].sort()) {
    const controller = new AbortController(), visited = [];
    const f = caller('cancel', KINDS, { indirect:true });
    const result = analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, { snapshotId, signal:controller.signal,
      summaryProvider(id) { visited.push(id); if (id === cancelledTarget) controller.abort(); return summaries.get(id); } });
    assert.equal(result.status.stopReason, 'cancelled');
    assert.equal(result.pointsTo.get('ret').top, true);
    assert.equal(visited.at(-1), cancelledTarget);
  }
});
