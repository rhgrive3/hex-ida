import assert from 'node:assert/strict';
import test from 'node:test';
import { FunctionFixture, origin } from '../helpers/fixtures.mjs';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';
import { solveInterproceduralSummaries } from '../../../js/analysis/summary/interprocedural.js';
import { functionSummaryDigest, createFunctionSummary, summaryIdentityMatches } from '../../../js/analysis/summary/contract.js';
import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';

const snapshotId = 'c1-recursive-return-discovery';

// Assemble source fixture data, then run ALL canonical IR/CFG/SSA/MemorySSA
// constructors. No pre-solved return summaries or private producer brands.
function recursiveFunction(functionId, target, { baseArg = null, baseTarget = null, swap = false, returnOffset = 0,
  indirectTargets = null, incomplete = false } = {}) {
  const f = new FunctionFixture(functionId);
  const hasBase = baseArg != null || baseTarget != null;
  f.block('entry', hasBase ? ['base', 'recurse'] : []);
  const args = [0, 1].map(index => {
    const id = f.stateRead(`arg${index}`, `state:x${index}`);
    f.values.find(value => value.id === id).metadata = { argumentIndex:index };
    return id;
  });
  if (hasBase) {
    f.branch('choose', ['base', 'recurse'], { conditional:true });
    f.block('base');
    let baseValue = args[baseArg];
    if (baseTarget != null) {
      const id = f.pureCall('base_call', { calleeId:baseTarget });
      const call = f.nodes.find(node => node.id === id);
      baseValue = 'base_value'; call.outputs = [baseValue]; call.call.returns = [baseValue];
      f.values.push({ id:baseValue, kind:'definition', definitionNodeId:id,
        machineType:{ kind:'address', widthBits:64, addressSpace:'memory' }, origin:origin(baseValue) });
    }
    const ret = f.ret('base_return');
    f.nodes.find(node => node.id === ret).inputs = [baseValue];
    f.block('recurse');
  }
  const callId = f.pureCall('recursive_call', { calleeId:target });
  const call = f.nodes.find(node => node.id === callId), actuals = swap ? [...args].reverse() : args;
  call.inputs = [...actuals]; call.outputs = ['call_return'];
  call.call.arguments = [...actuals]; call.call.returns = ['call_return'];
  if (indirectTargets) {
    call.call.targetValueIds = [args[1]]; call.call.targetEntityIds = indirectTargets;
    if (incomplete) {
      call.call.completeness = 'partial'; call.completeness = 'partial';
      call.unknown = { reason:'non-exhaustive-indirect-targets', categories:['control'] };
      call.call.unknownEffects = { ...call.unknown };
    }
  }
  f.values.push({ id:'call_return', kind:'definition', definitionNodeId:callId,
    machineType:{ kind:'address', widthBits:64, addressSpace:'memory' }, origin:origin('call_return') });
  const returned = returnOffset === 0 ? 'call_return' : f.binary('shifted', 'add', 'call_return', f.constant('offset', returnOffset));
  if (returnOffset !== 0) {
    f.values.find(value => value.id === 'offset').metadata.constant.kind = 'bitvector';
    f.nodes.find(node => node.id === 'node_offset').attributes.constant.kind = 'bitvector';
  }
  const ret = f.ret('recursive_return');
  f.nodes.find(node => node.id === ret).inputs = [returned];
  return f.build();
}

for (const topology of ['self', 'self-swapped', 'mutual-swapped']) {
  test(`FR-C1-02 discovers ${topology} recursive returns from actual local producers`, () => {
    const mutual = topology === 'mutual-swapped';
    const functions = new Map([['recursive_a', recursiveFunction('recursive_a', mutual ? 'recursive_b' : 'recursive_a',
      { baseArg:0, swap:topology === 'self-swapped' })]]);
    if (mutual) functions.set('recursive_b', recursiveFunction('recursive_b', 'recursive_a', { swap:true }));
    const originalIrs = [...functions].map(([id, built]) => [id, structuredClone(built.ir)]);
    const locals = new Map([...functions].map(([id, built]) => [id,
      buildLocalFunctionSummary(built.ir, built.cfg, built.ssa, built.memorySsa, { snapshotId }).summary]));
    assert.ok([...locals.values()].every(summary => summary.status.completeness === 'complete'));
    assert.ok(locals.get('recursive_a').returnProvenance.some(fact => fact.kind === 'unknown'),
      'the recursive call really begins unresolved; do not seed the answer in a hand-built summary');
    const before = [...locals].map(([id, summary]) => [id, functionSummaryDigest(summary)]);
    const outer = recursiveFunction('outer_caller', 'recursive_a');
    const baseline = analyzeLocalPointsTo(outer.ir, outer.cfg, outer.ssa, { snapshotId, summaries:locals });
    assert.equal(baseline.pointsTo.get('call_return').top, true);

    // Recursive transfer is a real wire contract, not a private object brand.
    const wireLocals = new Map([...locals].map(([id, summary]) => [id, JSON.parse(JSON.stringify(summary))]));
    assert.ok([...wireLocals.values()].every(summary => summaryIdentityMatches(summary, { snapshotId })));
    const solved = solveInterproceduralSummaries({ roots:['recursive_a'], localSummaries:wireLocals, snapshotId });
    assert.equal(solved.status.completeness, 'complete');
    assert.equal(solved.components.length, 1);
    assert.equal(solved.components[0].length, mutual ? 2 : 1);
    const summary = solved.summaries.get('recursive_a');
    assert.ok(!summary.returnProvenance.some(fact => fact.kind === 'unknown'),
      'the converged SCC must reconstruct recursive call returns, not just preserve the local unknown');
    const expectedArgs = topology === 'self' ? [0] : [0, 1];
    assert.deepEqual(summary.returnProvenance.map(fact => fact.argIndex).sort(), expectedArgs);
    assert.ok(summary.returnProvenance.every(fact => fact.kind === 'arg' && fact.returnIndex === 0 && fact.offset === '0'));
    const result = analyzeLocalPointsTo(outer.ir, outer.cfg, outer.ssa, { snapshotId, summaries:solved.summaries });
    assert.equal(result.pointsTo.get('call_return').top, false, 'precision must reach the real outer points-to consumer');
    const roots = expectedArgs.map(index => result.pointsTo.get(`arg${index}`).targets[0].rootEntityId).sort();
    assert.deepEqual(result.pointsTo.get('call_return').targets.map(target => target.rootEntityId).sort(), roots);
    assert.deepEqual([...locals].map(([id, value]) => [id, functionSummaryDigest(value)]), before);
    for (const [id, ir] of originalIrs) assert.deepEqual(structuredClone(functions.get(id).ir), ir);
  });
}

test('FR-C1-02 unseeded recursive return is public unknown, never a noreturn proof', () => {
  const f = recursiveFunction('unseeded', 'unseeded');
  const local = buildLocalFunctionSummary(f.ir, f.cfg, f.ssa, f.memorySsa, { snapshotId }).summary;
  const solved = solveInterproceduralSummaries({ roots:['unseeded'], localSummaries:new Map([['unseeded', local]]), snapshotId });
  assert.deepEqual(solved.summaries.get('unseeded').returnProvenance.map(fact => fact.kind), ['unknown']);
  assert.notEqual(solved.summaries.get('unseeded').noreturn, true);
});

for (const boundary of ['missing', 'stale', 'partial', 'iteration-limit']) {
  test(`FR-C1-02 recursive transfer retains unknown at ${boundary} boundary`, () => {
    const f = recursiveFunction('guarded', boundary === 'missing' ? 'absent' : 'guarded', { baseArg:0 });
    let local = buildLocalFunctionSummary(f.ir, f.cfg, f.ssa, f.memorySsa, { snapshotId }).summary;
    if (boundary === 'stale' || boundary === 'partial') local = createFunctionSummary({ ...local,
      status:{ ...local.status, ...(boundary === 'stale' ? { snapshotId:'other' }
        : { completeness:'partial', stopReason:'evidence-missing' }) } });
    const solved = solveInterproceduralSummaries({ roots:['guarded'], localSummaries:new Map([['guarded', local]]), snapshotId,
      ...(boundary === 'iteration-limit' ? { budget:{ maxIterationsPerComponent:1 } } : {}) });
    const outer = recursiveFunction('consumer', 'guarded');
    const result = analyzeLocalPointsTo(outer.ir, outer.cfg, outer.ssa, { snapshotId, summaries:solved.summaries });
    assert.equal(result.pointsTo.get('call_return').top, true);
  });
}

test('FR-C1-02 return equations participate in digest and reject incomplete or ambiguous wire data', () => {
  const f = recursiveFunction('wire', 'wire', { baseArg:0 });
  const local = buildLocalFunctionSummary(f.ir, f.cfg, f.ssa, f.memorySsa, { snapshotId }).summary;
  const modified = structuredClone(local);
  modified.returnEquations.rows.find(row => row.kind === 'call').arguments.reverse();
  assert.notEqual(functionSummaryDigest(createFunctionSummary(modified)), functionSummaryDigest(local));
  for (const mutate of [
    value => { value.returnEquations.version = 2; },
    value => { value.returnEquations.rows.pop(); },
    value => { value.returnEquations.rows[0].returnIndex = '0'; },
    value => { value.returnEquations.rows.find(row => row.kind === 'call').callSiteId = 'absent'; },
    value => { delete value.returnEquations.rows.find(row => row.kind === 'call').arguments[0]; },
    value => { value.directCalls.push(value.directCalls[0]); },
  ]) {
    const invalid = structuredClone(local); mutate(invalid);
    assert.throws(() => createFunctionSummary(invalid), /return-equations/);
    assert.equal(summaryIdentityMatches(invalid, { snapshotId }), false);
  }
  const legacy = createFunctionSummary({ ...local, returnEquations:null });
  const solved = solveInterproceduralSummaries({ roots:['wire'], localSummaries:new Map([['wire', legacy]]), snapshotId });
  assert.ok(solved.summaries.get('wire').returnProvenance.some(fact => fact.kind === 'unknown'));
});

test('FR-C1-02 offset-growing recursion is bounded and never publishes optimistic finite facts', () => {
  const f = recursiveFunction('growing', 'growing', { baseArg:0, returnOffset:8 });
  const local = buildLocalFunctionSummary(f.ir, f.cfg, f.ssa, f.memorySsa, { snapshotId }).summary;
  const solved = solveInterproceduralSummaries({ roots:['growing'], localSummaries:new Map([['growing', local]]), snapshotId });
  assert.equal(solved.status.completeness, 'truncated');
  assert.equal(solved.status.stopReason, 'iteration-limit');
  assert.equal(solved.iterations, 16);
  assert.equal(solved.summaries.get('growing').returnProvenance.length, 0);
});

for (const kind of ['root', 'allocation']) {
  test(`FR-C1-02 recursive ${kind} returns retain leaf storage identity through actual local equations`, () => {
    const f = recursiveFunction('rooted', 'rooted', { baseTarget:'leaf' });
    const local = buildLocalFunctionSummary(f.ir, f.cfg, f.ssa, f.memorySsa, { snapshotId }).summary;
    assert.ok(local.returnProvenance.every(fact => fact.kind === 'unknown'));
    // Only the nonrecursive leaf has an existing finite summary. The recursive
    // function's answer is discovered from its actual source IR, not preseeded.
    const leaf = createFunctionSummary({ functionId:'leaf', returnProvenance:[{ kind, rootEntityId:'shared-name',
      ...(kind === 'allocation' ? { allocationSiteId:'site:leaf' } : {}), addressSpace:'io', offset:'24', returnIndex:0 }],
    noreturn:false, mayThrow:false, status:local.status });
    const solved = solveInterproceduralSummaries({ roots:['rooted'], localSummaries:new Map([['rooted', local], ['leaf', leaf]]), snapshotId });
    const facts = solved.summaries.get('rooted').returnProvenance;
    assert.deepEqual(facts, leaf.returnProvenance);
    const outer = recursiveFunction('outer_root', 'rooted');
    const result = analyzeLocalPointsTo(outer.ir, outer.cfg, outer.ssa, { snapshotId, summaries:solved.summaries });
    assert.equal(result.pointsTo.get('call_return').top, false);
    assert.equal(result.pointsTo.get('call_return').targets[0].addressSpace, 'io');
  });
}

for (const incomplete of [false, true]) {
  test(`FR-C1-02 ${incomplete ? 'incomplete' : 'exhaustive'} indirect recursive union reaches actual caller`, () => {
    const a = recursiveFunction('indirect_a', 'indirect_a', { baseArg:0, indirectTargets:['indirect_a', 'indirect_b'], incomplete });
    const b = recursiveFunction('indirect_b', 'indirect_a', { baseArg:1 });
    const locals = new Map([['indirect_a', a], ['indirect_b', b]].map(([id, f]) => [id,
      buildLocalFunctionSummary(f.ir, f.cfg, f.ssa, f.memorySsa, { snapshotId }).summary]));
    const solved = solveInterproceduralSummaries({ roots:['indirect_a'], localSummaries:locals, snapshotId });
    const outer = recursiveFunction('outer_indirect', 'indirect_a');
    const result = analyzeLocalPointsTo(outer.ir, outer.cfg, outer.ssa, { snapshotId, summaries:solved.summaries });
    assert.equal(result.pointsTo.get('call_return').top, incomplete);
    if (!incomplete) assert.deepEqual(solved.summaries.get('indirect_a').returnProvenance.map(fact => fact.argIndex), [0, 1]);
  });
}

const DISCOVERY_KINDS = ['arg', 'root', 'allocation'];
const DISCOVERY_TOPOLOGIES = ['self', 'mutual'];
const DISCOVERY_MODES = ['direct', 'exhaustive', 'nonexhaustive', 'missing', 'stale', 'partial', 'schema', 'unknown'];
const DISCOVERY_WRAPPER_DEPTHS = [0, 2];
const view = set => set.targets.map(target => ({ root:target.rootEntityId, space:target.addressSpace,
  min:String(target.offsetRange.min), max:String(target.offsetRange.max) }))
  .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);

function discoveryCell(kind, topology, mode, wrapperDepth) {
  const functions = new Map(), locals = new Map(), ids = ['cycle_a', 'cycle_b'];
  const produce = (id, f) => {
    functions.set(id, f);
    locals.set(id, buildLocalFunctionSummary(f.ir, f.cfg, f.ssa, f.memorySsa, { snapshotId }).summary);
  };
  for (const [index, id] of ids.entries()) {
    const unknownSeed = mode === 'unknown' && index === 1;
    const leaf = `leaf_${index}`, peer = `peer_${index}`;
    produce(id, recursiveFunction(id, topology === 'self' ? id : peer,
      kind === 'arg' && !unknownSeed ? { baseArg:index } : { baseTarget:leaf }));
    if (topology === 'mutual') produce(peer, recursiveFunction(peer, id));
    if (kind !== 'arg' || unknownSeed) {
      const finite = { kind, rootEntityId:`storage_${index}`, addressSpace:index === 0 ? 'memory' : 'io',
        offset:String(8 * (index + 1)), returnIndex:0,
        ...(kind === 'allocation' ? { allocationSiteId:`allocation_${index}` } : {}) };
      locals.set(leaf, createFunctionSummary({ functionId:leaf,
        returnProvenance:[unknownSeed ? { kind:'unknown', returnIndex:0 } : finite],
        noreturn:false, mayThrow:false, status:locals.get(id).status }));
    }
    assert.ok(locals.get(id).returnProvenance.some(fact => fact.kind === 'unknown'),
      'the real recursive producer must begin unresolved in every matrix cell');
  }
  const modified = locals.get(ids[1]);
  if (mode === 'missing') locals.delete(ids[1]);
  if (mode === 'stale') locals.set(ids[1], createFunctionSummary({ ...modified, status:{ ...modified.status, snapshotId:'stale' } }));
  if (mode === 'partial') locals.set(ids[1], createFunctionSummary({ ...modified, status:{ ...modified.status,
    completeness:'partial', stopReason:'evidence-missing' } }));
  if (mode === 'schema') locals.set(ids[1], { ...modified, schemaVersion:999 });
  produce('boundary', recursiveFunction('boundary', ids[0], mode === 'direct' ? {}
    : { indirectTargets:ids, incomplete:mode === 'nonexhaustive' }));
  let root = 'boundary';
  for (let depth = 0; depth < wrapperDepth; depth++) {
    const id = `wrapper_${depth}`;
    produce(id, recursiveFunction(id, root)); root = id;
  }
  return { functions, locals, root, ids };
}

test('FR-C1-02 actual recursive discovery covers the full root/topology/target/wrapper cross product', t => {
  const rows = [], failures = [];
  for (const kind of DISCOVERY_KINDS) for (const topology of DISCOVERY_TOPOLOGIES)
    for (const mode of DISCOVERY_MODES) for (const wrapperDepth of DISCOVERY_WRAPPER_DEPTHS) {
      const cell = `${kind}/${topology}/${mode}/wrappers:${wrapperDepth}`;
      try {
        const { functions, locals, root, ids } = discoveryCell(kind, topology, mode, wrapperDepth);
        const original = [...functions].map(([id, f]) => [id, structuredClone(f.ir)]);
        const digests = [...locals].map(([id, summary]) => [id, functionSummaryDigest(summary)]);
        const caller = recursiveFunction('matrix_consumer', root);
        assert.equal(analyzeLocalPointsTo(caller.ir, caller.cfg, caller.ssa, { snapshotId, summaries:locals })
          .pointsTo.get('call_return').top, true);
        const wire = new Map([...locals].map(([id, summary]) => [id, JSON.parse(JSON.stringify(summary))]));
        const solved = solveInterproceduralSummaries({ roots:[root], localSummaries:wire, snapshotId });
        assert.ok(solved.components.some(component => component.includes(ids[0]) && component.length === (topology === 'self' ? 1 : 2)));
        const result = analyzeLocalPointsTo(caller.ir, caller.cfg, caller.ssa, { snapshotId, summaries:solved.summaries });
        const positive = mode === 'direct' || mode === 'exhaustive', set = result.pointsTo.get('call_return');
        assert.equal(set.top, !positive, 'every uncertain candidate must keep the actual caller unknown');
        if (positive) {
          assert.equal(solved.status.completeness, 'complete');
          const expected = (mode === 'direct' ? [0] : [0, 1]).map(index => ({
            root:kind === 'arg' ? result.pointsTo.get(`arg${index}`).targets[0].rootEntityId : `storage_${index}`,
            space:kind === 'arg' ? 'memory' : index === 0 ? 'memory' : 'io',
            min:kind === 'arg' ? '0' : String(8 * (index + 1)), max:kind === 'arg' ? '0' : String(8 * (index + 1)),
          })).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
          assert.deepEqual(view(set), expected);
          assert.ok(result.calleeSummaryIds.includes(`summary:${functionSummaryDigest(solved.summaries.get(root))}`));
        }
        const replay = solveInterproceduralSummaries({ roots:[root], localSummaries:new Map([...wire].reverse()), snapshotId });
        assert.deepEqual(replay.summaries.get(root).returnProvenance, solved.summaries.get(root).returnProvenance);
        assert.deepEqual(analyzeLocalPointsTo(caller.ir, caller.cfg, caller.ssa, { snapshotId, summaries:replay.summaries })
          .pointsTo.get('call_return'), set);
        for (const [id, ir] of original) assert.deepEqual(structuredClone(functions.get(id).ir), ir);
        assert.deepEqual([...locals].map(([id, summary]) => [id, functionSummaryDigest(summary)]), digests);
        rows.push({ cell, positive, top:set.top, targetCount:set.targets.length });
      } catch (error) { failures.push({ cell, message:error.message }); }
    }
  assert.equal(rows.length + failures.length, 96, 'every declared cell must have a terminal result');
  t.diagnostic(JSON.stringify({ schema:'c1-recursive-discovery-matrix-v1', denominator:96, rows, failures }));
  assert.deepEqual(failures, []);
  assert.equal(rows.filter(row => row.positive).length, 24);
});
