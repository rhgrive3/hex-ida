import assert from 'node:assert/strict';
import test from 'node:test';
import { FunctionFixture, origin } from '../helpers/fixtures.mjs';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';
import { solveInterproceduralSummaries, prepareDemandSummarySession } from '../../../js/analysis/summary/interprocedural.js';
import { functionSummaryDigest, createFunctionSummary, summaryIdentityMatches } from '../../../js/analysis/summary/contract.js';
import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { callerFixture, SNAPSHOT as spillSnapshot } from '../helpers/c1-acceptance.mjs';
import { fixture as scopeFixture, workFor } from '../../scpa/helpers.mjs';
import { ScopedAnalysisWork } from '../../../js/core/budgets/scoped-work.js';
import { RETURN_ARGUMENT_LIMIT } from '../../../js/analysis/summary/return-equations.js';

import { semanticAbiAdapter, partitionDecodedFunction } from '../../../js/analysis/semantic-function.js';
import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import { RISCV_LP64_ABI } from '../../../js/targets/abi/index.js';
import { createRiscv64DecodedInstruction } from '../../../js/targets/architecture/riscv64/decoded-instruction.js';
import { buildSemanticV2CompatibilityPipeline } from '../../../js/semantics/compat/index.js';

// Reuse df98376ae's production-producer fixtures and 12b873ca's 96-cell
// denominator, adapted to the ZIP's native-SSA-aware producer and wire v2.
const snapshotId = 'c1-recursive-return-discovery';

// Source fixture data enters ALL canonical IR/CFG/SSA/MemorySSA constructors.
// No pre-solved recursive return summary or private producer brand is injected.
function recursiveFunction(functionId, target, { baseArg = null, baseTarget = null, baseUnknown = false, swap = false, returnOffset = 0,
  indirectTargets = null, incomplete = false, edit = null } = {}) {
  const f = new FunctionFixture(functionId);
  const hasBase = baseArg != null || baseTarget != null || baseUnknown;
  f.block('entry', hasBase ? ['base', 'recurse'] : []);
  const args = [0, 1].map(index => {
    const id = f.stateRead(`arg${index}`, `state:x${index}`);
    f.values.find(value => value.id === id).metadata = { argumentIndex:index };
    return id;
  });
  if (hasBase) {
    f.branch('choose', ['base', 'recurse'], { conditional:true });
    f.block('base');
    let baseValue = baseUnknown ? f.entryValue('unknown_base') : args[baseArg];
    if (baseTarget != null) {
      const id = f.pureCall('base_call', { calleeId:baseTarget });
      const call = f.nodes.find(node => node.id === id);
      call.inputs = [...args]; call.call.arguments = [...args];
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
  const ret = f.ret('recursive_return');
  f.nodes.find(node => node.id === ret).inputs = [returned];
  edit?.(f, call);
  return f.build();
}
const produce = f => buildLocalFunctionSummary(f.ir, f.cfg, f.ssa, f.memorySsa, { snapshotId }).summary;
const solve = (locals, root, options = {}) => solveInterproceduralSummaries({ roots:[root], localSummaries:locals, snapshotId, ...options });
const consume = (summaries, target) => {
  const f = recursiveFunction('consumer', target);
  return analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, { snapshotId, summaries });
};

for (const topology of ['self', 'self-swapped', 'mutual-swapped']) {
  test(`C1-02 discovers ${topology} recursive returns from actual local producers`, () => {
    const mutual = topology === 'mutual-swapped';
    const functions = new Map([['recursive_a', recursiveFunction('recursive_a', mutual ? 'recursive_b' : 'recursive_a',
      { baseArg:0, swap:topology === 'self-swapped' })]]);
    if (mutual) functions.set('recursive_b', recursiveFunction('recursive_b', 'recursive_a', { swap:true }));
    const originalIrs = [...functions].map(([id, built]) => [id, structuredClone(built.ir)]);
    const locals = new Map([...functions].map(([id, built]) => [id, produce(built)]));
    assert.ok([...locals.values()].every(summary => summary.status.completeness === 'complete'));
    assert.ok(locals.get('recursive_a').returnProvenance.some(fact => fact.kind === 'unknown'));
    const before = [...locals].map(([id, summary]) => [id, functionSummaryDigest(summary)]);
    const baseline = consume(locals, 'recursive_a');
    assert.equal(baseline.pointsTo.get('call_return').top, true);
    const wireLocals = new Map([...locals].map(([id, summary]) => [id, JSON.parse(JSON.stringify(summary))]));
    assert.ok([...wireLocals.values()].every(summary => summaryIdentityMatches(summary, { snapshotId })));
    const solved = solve(wireLocals, 'recursive_a');
    assert.equal(solved.status.completeness, 'complete');
    assert.equal(solved.components.length, 1);
    assert.equal(solved.components[0].length, mutual ? 2 : 1);
    const summary = solved.summaries.get('recursive_a');
    assert.ok(!summary.returnProvenance.some(fact => fact.kind === 'unknown'),
      'the converged SCC must discover call returns, not republish the local unknown');
    const expectedArgs = topology === 'self' ? [0] : [0, 1];
    assert.deepEqual(summary.returnProvenance.map(fact => fact.argIndex).sort(), expectedArgs);
    assert.ok(summary.returnProvenance.every(fact => fact.kind === 'arg' && fact.returnIndex === 0 && fact.offset === '0'));
    const result = consume(solved.summaries, 'recursive_a');
    assert.equal(result.pointsTo.get('call_return').top, false);
    const roots = expectedArgs.map(index => result.pointsTo.get(`arg${index}`).targets[0].rootEntityId).sort();
    assert.deepEqual(result.pointsTo.get('call_return').targets.map(target => target.rootEntityId).sort(), roots);
    assert.deepEqual([...locals].map(([id, value]) => [id, functionSummaryDigest(value)]), before);
    for (const [id, ir] of originalIrs) assert.deepEqual(structuredClone(functions.get(id).ir), ir);
  });
}

for (const mutual of [false, true]) {
  test(`C1-02 unseeded ${mutual ? 'mutual' : 'self'} cycle publishes unknown, never a noreturn proof`, () => {
    const locals = new Map([['unseeded', produce(recursiveFunction('unseeded', mutual ? 'peer' : 'unseeded'))]]);
    if (mutual) locals.set('peer', produce(recursiveFunction('peer', 'unseeded')));
    const solved = solve(locals, 'unseeded');
    assert.deepEqual(solved.summaries.get('unseeded').returnProvenance.map(fact => fact.kind), ['unknown']);
    assert.notEqual(solved.summaries.get('unseeded').noreturn, true);
    assert.equal(consume(solved.summaries, 'unseeded').pointsTo.get('call_return').top, true);
  });
}

for (const boundary of ['missing', 'stale', 'partial', 'cancelled', 'iteration-limit']) {
  test(`C1-02 recursive transfer stays conservative at ${boundary} boundary`, () => {
    let local = produce(recursiveFunction('guarded', boundary === 'missing' ? 'absent' : 'guarded', { baseArg:0 }));
    if (['stale', 'partial', 'cancelled'].includes(boundary)) {
      local = structuredClone(local);
      Object.assign(local.status, boundary === 'stale' ? { snapshotId:'other' }
        : { completeness:'partial', stopReason:boundary === 'cancelled' ? 'cancelled' : 'evidence-missing' });
    }
    const solved = solve(new Map([['guarded', local]]), 'guarded',
      boundary === 'iteration-limit' ? { budget:{ maxIterationsPerComponent:1 } } : {});
    assert.equal(consume(solved.summaries, 'guarded').pointsTo.get('call_return').top, true);
  });
}

test('C1-02 equations affect digest and reject incomplete or ambiguous wire data', () => {
  const local = produce(recursiveFunction('wire', 'wire', { baseArg:0 }));
  const modified = structuredClone(local);
  modified.returnEquations.rows.find(row => row.kind === 'call').arguments.reverse();
  assert.notEqual(functionSummaryDigest(createFunctionSummary(modified)), functionSummaryDigest(local));
  for (const mutate of [
    value => { value.returnEquations.version = 99; },
    value => { value.returnEquations.rows.pop(); },
    value => { value.returnEquations.rows[0].returnIndex = '0'; },
    value => { value.returnEquations.rows.find(row => row.kind === 'call').callSiteId = 'absent'; },
    value => { delete value.returnEquations.rows.find(row => row.kind === 'call').arguments[0]; },
    value => { value.directCalls.push(value.directCalls[0]); },
  ]) {
    const invalid = structuredClone(local); mutate(invalid);
    assert.throws(() => createFunctionSummary(invalid), /return-equations/);
    assert.equal(summaryIdentityMatches(invalid, { snapshotId }), false);
    assert.equal(consume(solve(new Map([['wire', invalid]]), 'wire').summaries, 'wire').pointsTo.get('call_return').top, true);
  }
  for (const field of ['snapshotId', 'functionId']) {
    const invalid = structuredClone(local);
    invalid.returnEquations.source[field] = 'foreign';
    for (const stale of [invalid, createFunctionSummary(invalid)]) {
      assert.equal(summaryIdentityMatches(stale, { snapshotId }), false);
      assert.equal(consume(solve(new Map([['wire', stale]]), 'wire').summaries, 'wire').pointsTo.get('call_return').top, true);
    }
  }
  const legacy = createFunctionSummary({ ...local, returnEquations:null });
  assert.ok(solve(new Map([['wire', legacy]]), 'wire').summaries.get('wire').returnProvenance.some(fact => fact.kind === 'unknown'));
});

test('C1-02 offset-growing recursion exhausts the existing iteration cap without exact publication', () => {
  const local = produce(recursiveFunction('growing', 'growing', { baseArg:0, returnOffset:8 }));
  const solved = solve(new Map([['growing', local]]), 'growing');
  assert.equal(solved.status.completeness, 'truncated');
  assert.equal(solved.status.stopReason, 'iteration-limit');
  assert.equal(solved.iterations, 16);
  assert.equal(solved.summaries.get('growing').returnProvenance.length, 0);
});

for (const kind of ['root', 'allocation']) {
  test(`C1-02 recursive ${kind} discovery from canonical IR with an explicitly declared nonrecursive leaf`, () => {
    const local = produce(recursiveFunction('rooted', 'rooted', { baseTarget:'leaf' }));
    assert.ok(local.returnProvenance.every(fact => fact.kind === 'unknown'));
    // Fixture boundary: ONLY this nonrecursive storage leaf is declared. The
    // recursive functions, wrappers and callers use production producers.
    const leaf = createFunctionSummary({ functionId:'leaf', returnProvenance:[{ kind, rootEntityId:'shared-name',
      ...(kind === 'allocation' ? { allocationSiteId:'site:leaf' } : {}), addressSpace:'io', offset:'24', returnIndex:0 }],
    noreturn:false, mayThrow:false, status:local.status });
    const solved = solve(new Map([['rooted', local], ['leaf', leaf]]), 'rooted');
    assert.deepEqual(solved.summaries.get('rooted').returnProvenance, leaf.returnProvenance);
    const result = consume(solved.summaries, 'rooted');
    assert.equal(result.pointsTo.get('call_return').top, false);
    assert.equal(result.pointsTo.get('call_return').targets[0].addressSpace, 'io');
  });
}

for (const incomplete of [false, true]) {
  test(`C1-02 ${incomplete ? 'incomplete' : 'exhaustive'} indirect recursive union reaches the actual caller`, () => {
    const a = recursiveFunction('indirect_a', 'indirect_a', { baseArg:0, indirectTargets:['indirect_a', 'indirect_b'], incomplete });
    const b = recursiveFunction('indirect_b', 'indirect_a', { baseArg:1 });
    const locals = new Map([['indirect_a', produce(a)], ['indirect_b', produce(b)]]);
    const solved = solve(locals, 'indirect_a');
    const result = consume(solved.summaries, 'indirect_a');
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
  const add = (id, f) => { functions.set(id, f); locals.set(id, produce(f)); };
  for (const [index, id] of ids.entries()) {
    const unknownSeed = mode === 'unknown' && index === 1;
    const leaf = `leaf_${index}`, peer = `peer_${index}`;
    add(id, recursiveFunction(id, topology === 'self' ? id : peer,
      kind === 'arg' && !unknownSeed ? { baseArg:index } : { baseTarget:leaf }));
    if (topology === 'mutual') add(peer, recursiveFunction(peer, id));
    if (kind !== 'arg' || unknownSeed) {
      const finite = { kind, rootEntityId:`storage_${index}`, addressSpace:index === 0 ? 'memory' : 'io',
        offset:String(8 * (index + 1)), returnIndex:0,
        ...(kind === 'allocation' ? { allocationSiteId:`allocation_${index}` } : {}) };
      locals.set(leaf, createFunctionSummary({ functionId:leaf,
        returnProvenance:[unknownSeed ? { kind:'unknown', returnIndex:0 } : finite],
        noreturn:false, mayThrow:false, status:locals.get(id).status }));
    }
    assert.ok(locals.get(id).returnProvenance.some(fact => fact.kind === 'unknown'));
  }
  const modified = structuredClone(locals.get(ids[1]));
  if (mode === 'missing') locals.delete(ids[1]);
  if (mode === 'stale') { modified.status.snapshotId = 'stale'; locals.set(ids[1], modified); }
  if (mode === 'partial') locals.set(ids[1], createFunctionSummary({ ...modified, status:{ ...modified.status,
    completeness:'partial', stopReason:'evidence-missing' } }));
  if (mode === 'schema') locals.set(ids[1], { ...modified, schemaVersion:999 });
  add('boundary', recursiveFunction('boundary', ids[0], mode === 'direct' ? {}
    : { indirectTargets:ids, incomplete:mode === 'nonexhaustive' }));
  let root = 'boundary';
  for (let depth = 0; depth < wrapperDepth; depth++) {
    const id = `wrapper_${depth}`; add(id, recursiveFunction(id, root)); root = id;
  }
  return { functions, locals, root, ids };
}

test('C1-02 reused 96-cell recursive producer/target/wrapper matrix (root/allocation leaf is declared)', t => {
  const rows = [], failures = [];
  for (const kind of DISCOVERY_KINDS) for (const topology of DISCOVERY_TOPOLOGIES)
    for (const mode of DISCOVERY_MODES) for (const wrapperDepth of DISCOVERY_WRAPPER_DEPTHS) {
      const cell = `${kind}/${topology}/${mode}/wrappers:${wrapperDepth}`;
      try {
        const { functions, locals, root, ids } = discoveryCell(kind, topology, mode, wrapperDepth);
        const original = [...functions].map(([id, f]) => [id, structuredClone(f.ir)]);
        const digests = [...locals].map(([id, summary]) => [id, functionSummaryDigest(summary)]);
        assert.equal(consume(locals, root).pointsTo.get('call_return').top, true);
        const wire = new Map([...locals].map(([id, summary]) => [id, JSON.parse(JSON.stringify(summary))]));
        const solved = solve(wire, root);
        assert.ok(solved.components.some(component => component.includes(ids[0]) && component.length === (topology === 'self' ? 1 : 2)));
        const result = consume(solved.summaries, root);
        const positive = mode === 'direct' || mode === 'exhaustive', set = result.pointsTo.get('call_return');
        assert.equal(set.top, !positive, 'uncertain candidates must keep the actual caller unknown');
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
        const replay = solve(new Map([...wire].reverse()), root);
        assert.deepEqual(replay.summaries.get(root), solved.summaries.get(root));
        assert.deepEqual(consume(replay.summaries, root).pointsTo.get('call_return'), set);
        for (const [id, ir] of original) assert.deepEqual(structuredClone(functions.get(id).ir), ir);
        assert.deepEqual([...locals].map(([id, summary]) => [id, functionSummaryDigest(summary)]), digests);
        rows.push({ cell, positive, top:set.top, targetCount:set.targets.length });
      } catch (error) { failures.push({ cell, message:error.message }); }
    }
  assert.equal(rows.length + failures.length, 96);
  t.diagnostic(JSON.stringify({ schema:'c1-recursive-discovery-matrix-v1', denominator:96, rows, failures }));
  assert.deepEqual(failures, []);
  assert.equal(rows.filter(row => row.positive).length, 24);
});


for (const targets of [['a'], ['a', 'b']]) for (const same of [true, false]) {
  test(`C1-02 exhaustive ${targets.length}-candidate ${same ? 'same' : 'different'} returned roots`, () => {
    const locals = new Map(['a', 'b'].map((id, i) => [id,
      produce(recursiveFunction(id, id, { baseArg:same ? 0 : i }))]));
    locals.set('boundary', produce(recursiveFunction('boundary', 'a', { indirectTargets:targets })));
    const solved = solve(locals, 'boundary');
    const facts = solved.summaries.get('boundary').returnProvenance;
    const expected = same || targets.length === 1 ? [0] : [0, 1];
    assert.deepEqual(facts.map(fact => fact.argIndex), expected);
    const result = consume(solved.summaries, 'boundary');
    assert.equal(result.pointsTo.get('call_return').top, false);
    assert.equal(result.pointsTo.get('call_return').targets.length, expected.length);
  });
}

test('C1-02 contradictory mutual return paths remain a safe union, never an arbitrary singleton', () => {
  const locals = new Map(['a', 'b'].map((id, i) => [id,
    produce(recursiveFunction(id, i ? 'a' : 'b', { baseArg:i }))]));
  const result = solve(locals, 'a');
  for (const id of locals.keys()) {
    assert.deepEqual(result.summaries.get(id).returnProvenance.map(fact => fact.argIndex), [0, 1]);
    const set = consume(result.summaries, id).pointsTo.get('call_return');
    assert.equal(set.top, false); assert.equal(set.targets.length, 2);
  }
});

test('C1-02 adding one unknown reachable return alternative cannot improve exactness', () => {
  const positive = produce(recursiveFunction('a', 'a', { baseArg:0, swap:true }));
  const negative = produce(recursiveFunction('a', 'a', { baseArg:0, swap:true,
    edit:f => { delete f.values.find(value => value.id === 'arg1').metadata.argumentIndex; } }));
  const good = solve(new Map([['a', positive]]), 'a');
  const bad = solve(new Map([['a', negative]]), 'a');
  assert.equal(consume(good.summaries, 'a').pointsTo.get('call_return').top, false);
  assert.ok(bad.summaries.get('a').returnProvenance.some(fact => fact.kind === 'unknown'));
  assert.equal(consume(bad.summaries, 'a').pointsTo.get('call_return').top, true);
});

test('C1-02 changed recursive return evidence invalidates the actual caller dependency identity', () => {
  const a = produce(recursiveFunction('a', 'a', { baseArg:0 }));
  const b = produce(recursiveFunction('a', 'a', { baseArg:1 }));
  const oldDigest = functionSummaryDigest(a), newDigest = functionSummaryDigest(b);
  assert.notEqual(oldDigest, newDigest);
  const old = solve(new Map([['a', a]]), 'a');
  const changed = solve(new Map([['a', b]]), 'a');
  assert.notEqual(functionSummaryDigest(old.summaries.get('a')), functionSummaryDigest(changed.summaries.get('a')));
  const first = consume(old.summaries, 'a'), second = consume(changed.summaries, 'a');
  assert.notDeepEqual(first.calleeSummaryIds, second.calleeSummaryIds);
  assert.equal(first.pointsTo.get('call_return').targets[0].rootEntityId, first.pointsTo.get('arg0').targets[0].rootEntityId);
  assert.equal(second.pointsTo.get('call_return').targets[0].rootEntityId, second.pointsTo.get('arg1').targets[0].rootEntityId);
  const stale = solve(new Map([['a', b]]), 'a', { expectedSummaryDigests:new Map([['a', oldDigest]]) });
  assert.equal(consume(stale.summaries, 'a').pointsTo.get('call_return').top, true);
  assert.equal(summaryIdentityMatches(b, { snapshotId, digest:oldDigest }), false);
  assert.equal(summaryIdentityMatches(b, { snapshotId, digest:newDigest }), true);
});

for (const boundary of ['digest', 'snapshot', 'cancelled', 'unknown-effects', 'schema', 'version', 'versionless', 'source']) {
  test(`C1-02 one poisoned exhaustive recursive candidate stays unknown: ${boundary}`, () => {
    const locals = new Map(['a', 'b'].map((id, i) => [id, produce(recursiveFunction(id, id, { baseArg:i }))]));
    locals.set('boundary', produce(recursiveFunction('boundary', 'a', { indirectTargets:['a', 'b'] })));
    const original = locals.get('b'), bad = structuredClone(original), options = {};
    if (boundary === 'digest') options.expectedSummaryDigests = new Map([['b', 'stale-digest']]);
    if (boundary === 'snapshot') bad.status.snapshotId = 'old';
    if (boundary === 'cancelled') { bad.status.completeness = 'partial'; bad.status.stopReason = 'cancelled'; }
    if (boundary === 'unknown-effects') {
      bad.status.completeness = 'partial'; bad.status.stopReason = 'evidence-missing';
      bad.unknownCallEffects.push({ callSiteId:'unresolved', reason:'unresolved-target', targetEntityIds:[], evidenceIds:[] });
      bad.memoryWriteRegions.push({ regionKind:'unknown', broad:true, addressSpaces:['memory'], source:'unknown-call-fallback' });
      bad.noreturn = 'unknown'; bad.mayThrow = 'unknown';
    }
    if (boundary === 'schema') bad.schemaVersion = 3;
    if (boundary === 'version') bad.contractVersion = '1.3.0';
    if (boundary === 'versionless') { delete bad.schemaVersion; delete bad.contractVersion; }
    if (boundary === 'source') bad.returnEquations.source.snapshotId = 'old';
    const materialized = boundary === 'unknown-effects' ? createFunctionSummary(bad) : bad;
    if (boundary === 'unknown-effects' || boundary === 'cancelled') {
      assert.equal(summaryIdentityMatches(materialized, { snapshotId }), true,
        'this counterexample is a valid uncertain contract, not a malformed-envelope shortcut');
    }
    locals.set('b', materialized);
    const result = solve(locals, 'boundary', options);
    assert.equal(consume(result.summaries, 'boundary').pointsTo.get('call_return').top, true);
    assert.deepEqual(original, produce(recursiveFunction('b', 'b', { baseArg:1 })));
  });
}

test('C1-02 synchronous cancellation at every observed checkpoint never publishes an active SCC', t => {
  const locals = new Map([['a', produce(recursiveFunction('a', 'b', { baseArg:0 }))],
    ['b', produce(recursiveFunction('b', 'a'))]]);
  let checkpoints = 0;
  assert.equal(solve(locals, 'a', { signal:{ get aborted() { checkpoints++; return false; } } }).status.completeness, 'complete');
  let duringScc = 0;
  for (let stop = 1; stop <= checkpoints; stop++) {
    let reads = 0;
    const result = solve(locals, 'a', { signal:{ get aborted() { return ++reads >= stop; } } });
    assert.equal(result.status.stopReason, 'cancelled', `checkpoint ${stop}`);
    assert.equal(result.summaries.size, 0, `active SCC leaked at checkpoint ${stop}`);
    if (result.iterations > 0) duringScc++;
  }
  assert.ok(duringScc > 0);
  t.diagnostic(JSON.stringify({ cancellationCheckpoints:checkpoints, duringScc, falseExactPublication:0 }));
});

test('C1-02 every insufficient synchronous work budget withholds the entire active SCC', t => {
  const locals = new Map([['a', produce(recursiveFunction('a', 'b', { baseArg:0 }))],
    ['b', produce(recursiveFunction('b', 'a'))]]);
  let exhausted = 0, complete = 0;
  for (let maxWorkItems = 0; maxWorkItems <= 96; maxWorkItems++) {
    const result = solve(locals, 'a', { budget:{ maxWorkItems } });
    if (result.status.stopReason === 'budget-exhausted') {
      exhausted++; assert.equal(result.summaries.size, 0);
    } else {
      complete++; assert.equal(result.status.completeness, 'complete');
      assert.deepEqual(result.summaries.get('a').returnProvenance.map(fact => fact.argIndex), [0]);
    }
  }
  assert.ok(exhausted > 0 && complete > 0);
  t.diagnostic(JSON.stringify({ workBudgetCells:97, exhausted, complete, falseExactPublication:0 }));
});

for (const topology of ['grounded', 'ungrounded']) {
  test(`C1-02 demand execution uses the same ${topology} SCC equations and atomic publication`, async t => {
    const locals = new Map([['a', produce(recursiveFunction('a', 'b', topology === 'grounded' ? { baseArg:0 } : {}))],
      ['b', produce(recursiveFunction('b', 'a'))]]);
    const prepared = await prepareDemandSummarySession({ roots:['a'], localSummaries:locals,
      ...scopeFixture(), snapshotId, work:workFor(t) });
    assert.equal(prepared.status, 'prepared');
    const session = prepared.session; t.after(() => session.close());
    let steps = 0, result;
    while (!session.done) {
      assert.ok(++steps < 32);
      result = await session.step(workFor(t), { maximumTransfers:1 });
      if (!session.done) {
        assert.equal(session.summary('a'), null); assert.equal(session.summary('b'), null);
        assert.equal(result.components.activePublished, false); assert.equal(result.summaries.length, 0);
      }
    }
    const sync = solve(locals, 'a');
    for (const id of locals.keys()) assert.deepEqual(session.summary(id).returnProvenance, sync.summaries.get(id).returnProvenance);
    assert.equal(consume(new Map(result.summaries.map(row => [row.functionId, row.summary])), 'a')
      .pointsTo.get('call_return').top, topology === 'ungrounded');
  });
}

for (const boundary of ['cancelled', 'budget', 'stale']) {
  test(`C1-02 paused demand SCC rejects ${boundary} work without exposing provisional returns`, async t => {
    const locals = new Map([['a', produce(recursiveFunction('a', 'b', { baseArg:0 }))],
      ['b', produce(recursiveFunction('b', 'a'))]]);
    let current = true;
    const prepared = await prepareDemandSummarySession({ roots:['a'], localSummaries:locals,
      ...scopeFixture(), snapshotId, work:workFor(t), assertCurrent:() => current });
    const session = prepared.session; t.after(() => session.close());
    assert.equal((await session.step(workFor(t), { maximumTransfers:1 })).executionStatus, 'paused');
    assert.equal(session.summary('a'), null);
    if (boundary === 'stale') {
      current = false;
      await assert.rejects(session.step(workFor(t)), /input-stale/);
      assert.throws(() => session.summary('a'), /session-closed/);
    } else {
      const work = boundary === 'budget' ? workFor(t, { workUnits:0 })
        : new ScopedAnalysisWork({ signal:AbortSignal.abort(), limits:{ deadlineMs:10000 } });
      t.after(() => work.dispose());
      const result = await session.step(work);
      assert.equal(result.executionStatus, boundary === 'budget' ? 'budget-exhausted' : 'cancelled');
      assert.equal(result.summaries.length, 0); assert.equal(session.summary('a'), null);
    }
  });
}

for (const kind of DISCOVERY_KINDS) for (const endian of ['little', 'big']) {
  test(`C1-02 recursive ${kind}/${endian}: canonical producer to SCC to wrapper to points-to to store/MemorySSA/load`, () => {
    const recursive = recursiveFunction('recursive', 'recursive', kind === 'arg' ? { baseArg:0 } : { baseTarget:'leaf' });
    const produceHere = f => buildLocalFunctionSummary(f.ir, f.cfg, f.ssa, f.memorySsa, { snapshotId:spillSnapshot }).summary;
    const locals = new Map([['recursive', produceHere(recursive)]]);
    if (kind !== 'arg') {
      // Explicit fixture boundary: nonrecursive storage leaf, never the SCC.
      locals.set('leaf', createFunctionSummary({ functionId:'leaf', returnProvenance:[{
        kind, rootEntityId:'storage', ...(kind === 'allocation' ? { allocationSiteId:'site' } : {}),
        addressSpace:'memory', returnIndex:0, offset:'16' }], noreturn:false, mayThrow:false,
      status:locals.get('recursive').status }));
    }
    const wrapper = callerFixture({ functionId:'wrapper', targets:['recursive'], spill:false, returnOffset:8 });
    locals.set('wrapper', produceHere(wrapper));
    const solved = solveInterproceduralSummaries({ roots:['wrapper'], localSummaries:locals, snapshotId:spillSnapshot });
    assert.equal(solved.status.completeness, 'complete');
    assert.equal(solved.summaries.get('wrapper').returnProvenance[0].offset, kind === 'arg' ? '8' : '24');
    for (const mode of ['ordinary', 'unknown-call', 'may-alias', 'width-conflict', 'endian-conflict', 'atomic', 'volatile', 'copied-memoryssa']) {
      const f = callerFixture({ targets:['wrapper'], memoryMode:mode, endian });
      const baseline = analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, { snapshotId:spillSnapshot, memorySsa:f.memorySsa, summaries:locals });
      assert.equal(baseline.pointsTo.get('loaded').top, true);
      const result = analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, { snapshotId:spillSnapshot, memorySsa:f.memorySsa, summaries:solved.summaries });
      assert.equal(result.pointsTo.get('loaded').top, mode !== 'ordinary', mode);
      assert.equal(result.pointsTo.get('field').top, mode !== 'ordinary', mode);
      if (mode === 'ordinary') {
        assert.equal(result.pointsTo.get('loaded').targets.length, 1);
        const target = result.pointsTo.get('loaded').targets[0];
        assert.equal(target.rootEntityId, kind === 'arg' ? result.pointsTo.get('arg').targets[0].rootEntityId : 'storage');
        assert.equal(target.offsetRange.min, kind === 'arg' ? 8n : 24n);
        assert.equal(result.pointsTo.get('field').targets[0].offsetRange.min, target.offsetRange.min + 8n);
        assert.ok(result.calleeSummaryIds.includes(`summary:${functionSummaryDigest(solved.summaries.get('wrapper'))}`));
      }
    }
  });
}

test('C1-02 local equation argument budget exhaustion cannot preserve a strong composed return', () => {
  const f = recursiveFunction('wrapper', 'leaf', { edit:(f, call) => {
    call.call.arguments = Array.from({ length:RETURN_ARGUMENT_LIMIT + 1 }, (_, i) => f.entryValue(`wide_${i}`));
    call.inputs = [...call.call.arguments];
  } });
  const leaf = createFunctionSummary({ functionId:'leaf', returnProvenance:[{ kind:'root', rootEntityId:'storage',
    addressSpace:'memory', returnIndex:0, offset:'0' }], noreturn:false, mayThrow:false,
  status:produce(recursiveFunction('sample', 'sample', { baseArg:0 })).status });
  const local = buildLocalFunctionSummary(f.ir, f.cfg, f.ssa, f.memorySsa,
    { snapshotId, calleeSummaries:new Map([['leaf', leaf]]) }).summary;
  assert.notEqual(local.status.completeness, 'complete');
  assert.equal(local.status.stopReason, 'budget-exhausted');
  assert.equal(local.returnEquations, null);
  assert.ok(local.returnProvenance.every(fact => fact.kind === 'unknown'));
  assert.equal(consume(new Map([['wrapper', local]]), 'wrapper').pointsTo.get('call_return').top, true);
});


/** Native bytes use the existing RV64 decoder/lowering/ABI/IR/SSA owners. */
function nativeArgumentLeaf({ unknown = false } = {}) {
  const architecture = architecturePluginV2('riscv64');
  const words = [unknown ? 0x00700513 : 0x00150513, 0x00008067]; // a0=7 or a0+=1; ret
  const instructions = words.map((word, index) => createRiscv64DecodedInstruction({
    address:0x7000n + BigInt(index * 4), size:4, mode:'rv64imc',
    rawBytes:Uint8Array.from([word & 255, (word >>> 8) & 255, (word >>> 16) & 255, word >>> 24]),
    instructionId:`c1-native-${index}`, origin:{ instructionIds:[`c1-native-${index}`] },
  }));
  const blocks = partitionDecodedFunction(instructions, architecture);
  const prototype = { parameters:[{ type:'int64', bits:64 }, { type:'int64', bits:64 }], returnType:'int64' };
  const adapter = semanticAbiAdapter(RISCV_LP64_ABI, { architecture:'riscv64', platform:'linux',
    binaryId:'c1-native-binary', sliceId:'0', snapshotId:spillSnapshot, functionPrototype:prototype });
  return buildSemanticV2CompatibilityPipeline({ architecturePlugin:architecture, decoderSemanticVersion:'c1-rv64',
    binaryId:'c1-native-binary', sliceId:'0', addressWidthBits:64, mode:'rv64imc', entryBlockKey:blocks[0].key,
    blocks, abiAdapter:adapter, functionPrototype:prototype }, { snapshotId:spillSnapshot });
}

for (const unknown of [false, true]) {
  test(`C1-02 native decoded ${unknown ? 'unknown' : 'argument'} leaf through inner wrapper, recursive SCC, outer wrapper and actual spill`, () => {
    const native = nativeArgumentLeaf({ unknown });
    const leaf = buildLocalFunctionSummary(native.semanticIr, native.cfg, native.ssa, native.memorySsa, { snapshotId:spillSnapshot }).summary;
    assert.equal(leaf.status.completeness, 'complete');
    assert.deepEqual(leaf.returnProvenance.map(fact => fact.kind), [unknown ? 'unknown' : 'arg']);
    const functions = new Map([
      ['inner', recursiveFunction('inner', native.functionId)],
      ['a', recursiveFunction('a', 'b', { baseTarget:'inner' })],
      ['b', recursiveFunction('b', 'a')],
      ['outer', callerFixture({ functionId:'outer', targets:['a'], spill:false, returnOffset:8 })],
    ]);
    const locals = new Map([[native.functionId, leaf], ...[...functions].map(([id, f]) => [id,
      buildLocalFunctionSummary(f.ir, f.cfg, f.ssa, f.memorySsa, { snapshotId:spillSnapshot }).summary])]);
    assert.ok(locals.get('outer').returnProvenance.some(fact => fact.kind === 'unknown'));
    const solved = solveInterproceduralSummaries({ roots:['outer'], localSummaries:locals, snapshotId:spillSnapshot });
    assert.ok(solved.components.some(component => component.join(',') === 'a,b'));
    assert.equal(solved.status.completeness, 'complete');
    const caller = callerFixture({ functionId:'native-chain-consumer', targets:['outer'], spill:true });
    const before = analyzeLocalPointsTo(caller.ir, caller.cfg, caller.ssa,
      { snapshotId:spillSnapshot, memorySsa:caller.memorySsa, summaries:locals });
    const after = analyzeLocalPointsTo(caller.ir, caller.cfg, caller.ssa,
      { snapshotId:spillSnapshot, memorySsa:caller.memorySsa, summaries:solved.summaries });
    assert.equal(before.pointsTo.get('loaded').top, true);
    assert.equal(after.pointsTo.get('loaded').top, unknown);
    assert.equal(after.pointsTo.get('field').top, unknown);
    if (!unknown) {
      assert.equal(after.pointsTo.get('loaded').targets[0].offsetRange.min, 9n);
      assert.equal(after.pointsTo.get('field').targets[0].offsetRange.min, 17n);
    }
  });
}

for (const indirectTargets of [null, ['a', 'leaf']]) test(`C1-02 ${indirectTargets ? 'indirect' : 'direct'} source node/SSA/wire/candidate/map order permutations preserve the canonical digest`, () => {
  const f = recursiveFunction('a', 'a', { baseTarget:'leaf', indirectTargets });
  const local = produce(f), permuted = structuredClone({ ir:f.ir, cfg:f.cfg, ssa:f.ssa, memorySsa:f.memorySsa });
  permuted.ir.nodes.reverse(); permuted.ir.values.reverse();
  permuted.ssa.definitions.reverse(); permuted.ssa.uses.reverse();
  for (const node of permuted.ir.nodes) if (node.kind === 'call') node.call.targetEntityIds.reverse();
  const reordered = produce(permuted);
  assert.deepEqual(reordered.returnProvenance, local.returnProvenance);
  assert.equal(functionSummaryDigest(reordered), functionSummaryDigest(local));
  const leaf = createFunctionSummary({ functionId:'leaf', returnProvenance:[{ kind:'arg', argIndex:0, returnIndex:0, offset:'0' }],
    noreturn:false, mayThrow:false, status:local.status });
  const raw = JSON.parse(JSON.stringify(local));
  raw.returnEquations.sites.reverse(); raw.returnEquations.rows.reverse(); raw.directCalls.reverse();
  const canonical = createFunctionSummary(raw);
  assert.equal(functionSummaryDigest(canonical), functionSummaryDigest(local));
  const first = solve(new Map([['a', local], ['leaf', leaf]]), 'a');
  const second = solve(new Map([['leaf', leaf], ['a', reordered]]), 'a');
  assert.equal(functionSummaryDigest(first.summaries.get('a')), functionSummaryDigest(second.summaries.get('a')));
});

test('C1-02 independent finite source-path enumeration checks 256 recursive argument/unknown graphs', t => {
  const seeds = [null, 0, 1, 'unknown'];
  let cells = 0, positives = 0, negatives = 0;
  for (const targetA of [0, 1]) for (const targetB of [0, 1])
    for (const seedA of seeds) for (const seedB of seeds) for (const swapA of [false, true]) for (const swapB of [false, true]) {
      const sources = [{ target:targetA, seed:seedA, swap:swapA }, { target:targetB, seed:seedB, swap:swapB }];
      const names = ['a', 'b'];
      const locals = new Map(sources.map((source, index) => [names[index], produce(recursiveFunction(names[index], names[source.target],
        { baseArg:typeof source.seed === 'number' ? source.seed : null, baseUnknown:source.seed === 'unknown', swap:source.swap }))]));
      const solved = solveInterproceduralSummaries({ roots:names, localSummaries:locals, snapshotId });
      const replay = solveInterproceduralSummaries({ roots:[...names].reverse(), localSummaries:new Map([...locals].reverse()), snapshotId });
      for (const root of [0, 1]) {
        // Test-only enumeration of the finite (function, argument permutation)
        // source paths. It never reads production summary facts as an oracle.
        const visited = new Map(), path = [], argumentsReturned = new Set();
        let current = root, reversed = false, unknown = false;
        while (!visited.has(`${current}/${reversed}`)) {
          visited.set(`${current}/${reversed}`, path.length);
          const source = sources[current]; path.push(source);
          if (source.seed === 'unknown') unknown = true;
          else if (source.seed != null) argumentsReturned.add(reversed ? 1 - source.seed : source.seed);
          reversed = source.swap ? !reversed : reversed; current = source.target;
        }
        // A downstream cycle without a grounding return is deliberately
        // unknown, not a proof of noreturn that an upstream seed can erase.
        const cycle = path.slice(visited.get(`${current}/${reversed}`));
        const expectedTop = unknown || cycle.every(source => source.seed == null) || argumentsReturned.size === 0;
        const result = consume(solved.summaries, names[root]).pointsTo.get('call_return');
        assert.equal(result.top, expectedTop, JSON.stringify({ sources, root }));
        if (!expectedTop) {
          assert.deepEqual(solved.summaries.get(names[root]).returnProvenance.map(fact => fact.argIndex), [...argumentsReturned].sort());
          positives++;
        } else { assert.equal(result.targets.length, 0); negatives++; }
        assert.equal(functionSummaryDigest(solved.summaries.get(names[root])), functionSummaryDigest(replay.summaries.get(names[root])));
      }
      cells++;
    }
  assert.equal(cells, 256); assert.equal(positives + negatives, 512);
  t.diagnostic(JSON.stringify({ sourceGraphs:cells, checkedRoots:512, positives, negatives, falseExactPublication:0 }));
});

test('C1-02 same-function same-snapshot stale equations cannot replace the current producer source', () => {
  const old = produce(recursiveFunction('fresh', 'fresh', { baseArg:0 }));
  const current = produce(recursiveFunction('fresh', 'fresh', { baseArg:0, swap:true }));
  assert.deepEqual(old.returnProvenance, current.returnProvenance, 'local facts alone cannot distinguish the changed recursive arguments');
  assert.notEqual(functionSummaryDigest(old), functionSummaryDigest(current));
  const stale = createFunctionSummary({ ...current, returnEquations:old.returnEquations });
  assert.equal(summaryIdentityMatches(stale, { snapshotId }), false);
  assert.equal(consume(solve(new Map([['fresh', stale]]), 'fresh').summaries, 'fresh').pointsTo.get('call_return').top, true);
});

for (const missingSecond of [false, true]) {
  test(`C1-02 recursive multiple return positions ${missingSecond ? 'keep a missing callee position unknown' : 'compose the corresponding position without conflation'}`, () => {
    const twoResults = (f, call) => {
      call.outputs.push('call_return_1'); call.call.returns.push('call_return_1');
      f.values.push({ id:'call_return_1', kind:'definition', definitionNodeId:call.id,
        machineType:{ kind:'address', widthBits:64, addressSpace:'memory' }, origin:origin('call_return_1') });
      f.nodes.find(node => node.id === 'node_recursive_return').inputs.push('call_return_1');
      const base = f.nodes.find(node => node.id === 'node_base_return');
      if (base) base.inputs.push('arg1');
    };
    const inner = produce(recursiveFunction('multi', 'multi', { baseArg:0, edit:missingSecond ? null : twoResults }));
    const outer = produce(recursiveFunction('outer_multi', 'multi', { edit:twoResults }));
    const result = solve(new Map([['multi', inner], ['outer_multi', outer]]), 'outer_multi');
    const facts = result.summaries.get('outer_multi').returnProvenance;
    assert.deepEqual(facts.filter(fact => fact.returnIndex === 0).map(fact => [fact.kind, fact.argIndex]), [['arg', 0]]);
    assert.deepEqual(facts.filter(fact => fact.returnIndex === 1).map(fact => [fact.kind, fact.argIndex]),
      missingSecond ? [['unknown', null]] : [['arg', 1]]);
    const caller = recursiveFunction('multi_consumer', 'outer_multi', { edit:twoResults });
    const consumed = analyzeLocalPointsTo(caller.ir, caller.cfg, caller.ssa, { snapshotId, summaries:result.summaries });
    assert.equal(consumed.pointsTo.get('call_return').top, false);
    assert.equal(consumed.pointsTo.get('call_return_1').top, missingSecond);
    if (!missingSecond) assert.equal(consumed.pointsTo.get('call_return_1').targets[0].rootEntityId,
      consumed.pointsTo.get('arg1').targets[0].rootEntityId);
  });
}

test('C1-02 source identity is mandatory for equations and participates independently in dependency identity', () => {
  const current = produce(recursiveFunction('source_bound', 'source_bound', { baseArg:0 }));
  const modified = createFunctionSummary({ ...current, returnSourceDigest:'different-producer-input' });
  assert.notEqual(functionSummaryDigest(current), functionSummaryDigest(modified));
  assert.equal(summaryIdentityMatches(modified, { snapshotId }), false);
  assert.equal(summaryIdentityMatches(JSON.parse(JSON.stringify(modified)), { snapshotId }), false);
  for (const mutate of [
    value => { delete value.returnSourceDigest; },
    value => { value.returnSourceDigest = null; },
    value => { value.returnEquations.source.digest = 'stale-source'; },
  ]) {
    const invalid = structuredClone(current); mutate(invalid);
    assert.equal(summaryIdentityMatches(invalid, { snapshotId }), false);
    assert.equal(consume(solve(new Map([['source_bound', invalid]]), 'source_bound').summaries, 'source_bound')
      .pointsTo.get('call_return').top, true);
  }
  const missing = structuredClone(current); delete missing.returnEquations.source.digest;
  assert.throws(() => createFunctionSummary(missing), /return-equations/);
  assert.equal(summaryIdentityMatches(missing, { snapshotId }), false);
});

for (const allVoid of [false, true]) {
  test(`C1-02 ${allVoid ? 'all-void returns are not pointer or noreturn evidence' : 'a reachable void return cannot disappear from mixed-arity return coverage'}`, () => {
    const f = recursiveFunction('return_coverage', 'return_coverage', { baseArg:0, edit(f) {
      f.nodes.find(node => node.id === 'node_recursive_return').inputs = [];
      if (allVoid) f.nodes.find(node => node.id === 'node_base_return').inputs = [];
    } });
    const local = produce(f);
    assert.equal(local.status.completeness, allVoid ? 'complete' : 'partial');
    assert.equal(local.returnEquations, null);
    if (!allVoid) {
      assert.equal(local.status.stopReason, 'evidence-missing');
      assert.ok(local.returnProvenance.every(fact => fact.kind === 'unknown'));
    }
    const result = solve(new Map([['return_coverage', local]]), 'return_coverage');
    assert.notEqual(result.summaries.get('return_coverage').noreturn, true);
    assert.equal(consume(result.summaries, 'return_coverage').pointsTo.get('call_return').top, true);
  });
}
