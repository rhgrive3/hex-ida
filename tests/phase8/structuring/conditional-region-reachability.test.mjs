import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../helpers/ir-fixtures.mjs';
import { identity } from '../helpers/proof-fixtures.mjs';
import { decompileSemantic, readSemanticConditionalRegions } from '../../../js/decompiler/semantic-core.js';
import { prepareConditionalRegionStructure } from '../../../js/decompiler/phase8/conditional-region-structure.js';
import { prepareConditionalRegionReachability, readConditionalRegionReachability } from '../../../js/decompiler/phase8/conditional-region-reachability.js';
import { discoverPhase8Tests } from '../run.mjs';

function example({ kind = 'cbz', predicate = 'xor', after = null, mutate = () => {} } = {}) {
  const f = fixture('reachability'); f.block(0);
  const input = f.opaque(8); input.reg = 'x0'; input.index = 0;
  const value = typeof predicate === 'function' ? predicate(f, input)
    : predicate === 'xor' ? f.binary('xor', input, input, 8) : input;
  f.conditionalBranch(value, 1, 2);
  f.block(1); const yes = f.constant(1n, 8); f.branch(3);
  f.block(2); const no = f.constant(2n, 8); f.branch(3);
  f.block(3); const merged = f.phi([[1, yes], [2, no]], 8);
  if (after === 'branch' || after === 'loop') {
    f.conditionalBranch(input, 4, 5);
    f.block(4); if (after === 'loop') f.branch(3); else f.branch(6);
    f.block(5); if (after === 'loop') f.ret(); else { f.branch(6); f.block(6); f.ret(); }
  } else { if (after === 'call') f.call(8); f.ret(); }
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => [...block.phis, ...block.insts]);
  ir.instructions.forEach((inst, index) => { inst.id = `reach_${index}`; inst.row = index; inst.address = 0x1000n + BigInt(index * 4); });
  for (const block of ir.blocks) {
    block.startRow = block.insts[0].row; block.endRow = block.insts.at(-1).row;
    const term = block.insts.at(-1);
    if (term.op === 'br' || term.op === 'cbr') {
      term.extra = { kind:block.index === 0 ? kind : 'cbnz', targetBlock:block.succ[0], target:ir.blocks[block.succ[0]].insts[0].address };
    }
    if (term.op === 'ret') term.args = [{ value:merged }];
  }
  // The loop re-enters the PHI join, so give its backedge the exact incoming value.
  if (after === 'loop') merged.def.incoming.push({ from:4, value:merged });
  mutate(ir);
  const seed = decompileSemantic({ name:'reachability', instructions:ir.instructions, calls:[] },
    { ir, deterministicTransforms:true, phase8PrepareRegionProof:true });
  const region = readSemanticConditionalRegions(seed)?.regions.find(item => item.selection.header === 0);
  const structure = prepareConditionalRegionStructure(region?.record, ir, { identity, timeoutMs:5000 });
  return { ir, region, structure, run:extra => prepareConditionalRegionReachability(structure, ir,
    { identity, addressBits:8, timeoutMs:5000, backendTier:'exhaustive', ...extra }) };
}

for (const kind of ['cbz', 'cbnz']) test(`real ${kind} branch proof binds actual emitted arms and independent solver verdicts`, async () => {
  const f = example({ kind }); assert.equal(f.structure.status, 'complete', f.structure.reason);
  const result = await f.run(); assert.equal(result.status, 'complete', result.reason);
  assert.deepEqual(result.arms.map(arm => arm.verdict), kind === 'cbz' ? ['refuted', 'proved'] : ['proved', 'refuted']);
  assert.ok(result.arms.every(arm => typeof arm.queryHash === 'string'));
  assert.equal(result.arms.find(arm => arm.verdict === 'refuted').counterexampleValidated, true);
  assert.equal(result.transformAuthorization, false); assert.equal(result.semanticRegionValidation, 'required');
  assert.equal(readConditionalRegionReachability(result, f.ir, identity), result);
  assert.equal(readConditionalRegionReachability({ ...result }, f.ir, identity), null);
  assert.equal(readConditionalRegionReachability(result, { ...f.ir }, identity), null);
  assert.equal(readConditionalRegionReachability(result, f.ir, { ...identity, queryId:'other' }), null);
});

test('both live arms stay feasible and downstream branches cannot hide a reachable arm', async () => {
  const f = example({ predicate:'input', after:'branch' });
  assert.equal(f.structure.status, 'complete', f.structure.reason);
  const result = await f.run(); assert.equal(result.status, 'complete', result.reason);
  assert.equal(result.terminalPathCount, 4);
  assert.deepEqual(result.arms.map(arm => arm.verdict), ['refuted', 'refuted']);
  assert.deepEqual(result.arms.map(arm => arm.terminalPaths.length), [2, 2]);
});

test('forged input, injected state, or canonical target disagreement cannot issue proof', async () => {
  const f = example();
  assert.equal((await prepareConditionalRegionReachability({ ...f.structure }, f.ir, { identity })).status, 'partial');
  for (const extra of [{ preconditions:[] }, { argumentExpressions:new Map() }, { executionSnapshot:{} }, { backend:{} }, { session:{} }]) {
    const result = await f.run(extra); assert.equal(result.reason, 'unsupported-reachability-option');
  }
  const other = example({ mutate:ir => { ir.blocks[0].insts.at(-1).extra.target = ir.blocks[2].insts[0].address; } });
  assert.equal(other.structure.status, 'complete', other.structure.reason);
  assert.equal((await other.run()).reason, 'executor-producer-target-mismatch');
});

test('unknown calls and exploration limits never publish partial path proofs', async () => {
  const called = example({ after:'call' });
  const unknown = await called.run(); assert.equal(unknown.status, 'partial');
  assert.deepEqual(unknown.arms, []); assert.equal(readConditionalRegionReachability(unknown, called.ir, identity), null);
  for (const extra of [{ maxPaths:1 }, { maxBranches:0 }, { maxSteps:0 }, { timeoutMs:0 }, { limits:{ queries:0 } }]) {
    const f = example(), result = await f.run(extra);
    assert.equal(result.status, 'partial'); assert.equal(readConditionalRegionReachability(result, f.ir, identity), null);
  }
});

test('cancelled and stale source results lose authority before and after asynchronous proof', async () => {
  const controller = new AbortController(), f = example(), result = await f.run({ signal:controller.signal });
  assert.equal(result.status, 'complete', result.reason); controller.abort();
  assert.equal(readConditionalRegionReachability(result, f.ir, identity), null);
  const g = example(), pending = g.run(); g.region.close.text = '// changed';
  assert.equal((await pending).status, 'partial');
  const h = example(), proof = await h.run(); assert.equal(proof.status, 'complete', proof.reason);
  h.ir.blocks[0].insts.at(-1).extra.kind = 'cbnz';
  assert.equal(readConditionalRegionReachability(proof, h.ir, identity), null);
});

test('canonical Phase 8 discovery includes the reachability regressions', () => {
  assert.equal(discoverPhase8Tests().filter(path => path.endsWith('/structuring/conditional-region-reachability.test.mjs')).length, 1);
});

function memoryPredicate(f) {
  const loaded = f.load(8, { locKind:'global', locKey:'g', addressSpace:'data', volatility:false, atomic:false, addressPrecise:true });
  Object.assign(loaded.def.loc, { address:16n, size:1, addressSpace:'data' });
  loaded.def.extra.completeness = 'complete';
  loaded.def.extra.memoryAccess.endian = 'little';
  return f.binary('xor', loaded, loaded, 8);
}

function divisionPredicate(f, input) {
  const quotient = f.binary('udiv', input, f.constant(0n, 8), 8);
  quotient.def.extra = { completeness:'complete', attributes:{ machineEffects:{
    bundleCompleteness:'exact', possibleFaults:[],
    operationMetadata:{ divisionByZero:'returns-zero', widthBits:8, signedOverflow:'not-applicable' },
  } } };
  return quotient;
}

test('complete ordinary byte memory and explicit division policy preserve positive proofs', async () => {
  for (const predicate of [memoryPredicate, divisionPredicate]) {
    const f = example({ predicate }); assert.equal(f.structure.status, 'complete', f.structure.reason);
    const result = await f.run(); assert.equal(result.status, 'complete', result.reason);
    assert.deepEqual(result.arms.map(arm => arm.verdict), ['refuted', 'proved']);
    assert.equal(readConditionalRegionReachability(result, f.ir, identity), result);
  }
});

test('unproved memory qualifiers, faults, and alignment cannot supply an arm proof', async () => {
  const cases = [
    extra => { delete extra.memoryAccess; },
    extra => { delete extra.completeness; },
    extra => { extra.memoryAccess.faults = ['page-fault']; },
    extra => { extra.memoryAccess.atomic = true; },
    extra => { extra.memoryAccess.volatility = 'unknown'; },
    extra => { extra.memoryAccess.alignment = 4; },
  ];
  for (const change of cases) {
    const f = example({ predicate:memoryPredicate, mutate:ir => change(ir.instructions.find(inst => inst.op === 'load').extra) });
    assert.equal(f.structure.status, 'complete', f.structure.reason);
    const result = await f.run(); assert.equal(result.status, 'partial');
    assert.match(result.reason, /^unproved-memory-/);
    assert.equal(readConditionalRegionReachability(result, f.ir, identity), null);
  }
});

test('division aliases, missing policies, remainder, and hidden state retain unknown', async () => {
  const cases = [
    [inst => { delete inst.extra.attributes; }, 'unproved-division-effects'],
    [inst => { delete inst.extra.attributes; delete inst.sub; inst.name = 'udiv'; }, 'unproved-division-effects'],
    [inst => { inst.sub = 'urem'; }, 'unproved-remainder-effects'],
    [inst => { inst.extra.stateWrite = { key:'opaque' }; }, 'unproved-state-effects'],
    [inst => { inst.extra.attributes.machineEffects.possibleFaults = ['arithmetic']; }, 'unproved-machine-effects'],
    [inst => { inst.possibleFaults = ['arithmetic']; }, 'unproved-machine-effects'],
    [inst => { inst.extra.faults = ['arithmetic']; }, 'unproved-machine-effects'],
    [inst => { inst.extra.attributes.machineEffects.undefinedResult = { reason:'architectural' }; }, 'unproved-undefined-result'],
  ];
  for (const [change, reason] of cases) {
    const f = example({ predicate:divisionPredicate, mutate:ir => change(ir.instructions.find(inst => inst.sub === 'udiv')) });
    assert.equal(f.structure.status, 'complete', f.structure.reason);
    const result = await f.run(); assert.equal(result.reason, reason);
    assert.equal(readConditionalRegionReachability(result, f.ir, identity), null);
  }
});

test('whole-function edges and downstream branch endpoints are checked beyond the emitted region', async () => {
  for (const [mutate, reason] of [
    [ir => { ir.blocks[4].successorEdges[0].kind = 'exception'; }, 'nonordinary-function-edge'],
    [ir => { ir.blocks[4].isEntry = true; }, 'multiple-function-entries'],
    [ir => { ir.blocks[3].insts.at(-1).extra.fallthroughBlock = 4; }, 'inconsistent-branch-endpoints'],
  ]) {
    const f = example({ after:'branch', mutate });
    assert.equal(f.structure.status, 'complete', f.structure.reason);
    const result = await f.run(); assert.equal(result.reason, reason);
    assert.equal(readConditionalRegionReachability(result, f.ir, identity), null);
  }
});

test('a downstream loop requires a loop proof despite a complete initial region census', async () => {
  const f = example({ after:'loop' });
  assert.equal(f.structure.status, 'complete', f.structure.reason);
  const result = await f.run(); assert.equal(result.reason, 'loop-reachability-proof-required');
  assert.equal(readConditionalRegionReachability(result, f.ir, identity), null);
});

test('child execution cannot overdraw the shared work or allocation budget', async () => {
  for (const limits of [{ workItems:0 }, { workItems:4096 }, { allocationUnits:0 }, { allocationUnits:4096 }]) {
    const f = example(), result = await f.run({ limits });
    assert.equal(result.status, 'partial');
    assert.equal(readConditionalRegionReachability(result, f.ir, identity), null);
  }
});

test('branch trace identity normalizes Number and BigInt addresses before rejecting duplicates', async () => {
  const f = example({ after:'branch', mutate:ir => {
    const first = ir.blocks[0].insts.at(-1), later = ir.blocks[3].insts.at(-1);
    later.row = first.row; later.address = Number(first.address);
    // The address is still a distinct block entry, but the trace pair collides.
    ir.blocks[1].insts.at(-1).extra.target = later.address;
    ir.blocks[2].insts.at(-1).extra.target = later.address;
  } });
  assert.equal(f.structure.status, 'complete', f.structure.reason);
  assert.equal((await f.run()).reason, 'ambiguous-branch-trace-identity');
});

test('identity observers revoke issued results and cannot substitute a new query during proof', async () => {
  let current = identity;
  const f = example(), result = await f.run({ getCurrentIdentity:() => current });
  assert.equal(result.status, 'complete', result.reason);
  current = { ...identity, snapshotId:'new-snapshot' };
  assert.equal(readConditionalRegionReachability(result, f.ir, identity), null);
  const g = example(), pending = g.run({ getCurrentIdentity:() => current });
  assert.equal((await pending).reason, 'stale-identity');
});
