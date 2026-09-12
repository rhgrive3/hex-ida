import assert from 'node:assert/strict';
import test from 'node:test';
import { conditionalRegionFixture as example, textRowConditionalRegionFixture } from '../helpers/conditional-region-fixture.mjs';
import { readCanonicalRegisterStateBinding, prepareCanonicalRegisterStateBindings } from '../../../js/ir-core.js';
import { buildSemanticV2CompatibilityPipeline, projectedRegisterStateContext, projectedRegisterStateBindingCandidate } from '../../../js/semantics/compat/index.js';
import { createMachineEffectBundle } from '../../../js/semantics/effects/index.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { decompileSemantic, readSemanticConditionalRegions } from '../../../js/decompiler/semantic-core.js';
import { prepareConditionalRegionStructure } from '../../../js/decompiler/phase8/conditional-region-structure.js';
import { identity } from '../helpers/proof-fixtures.mjs';
import { prepareConditionalRegionReachability, readConditionalRegionReachability } from '../../../js/decompiler/phase8/conditional-region-reachability.js';
import { discoverPhase8Tests } from '../run.mjs';

test('actual production state reads and writes bind the original canonical SSA assignments', () => {
  const { ir, identity:context } = textRowConditionalRegionFixture();
  assert.ok(projectedRegisterStateContext(ir));
  const states = ir.instructions.filter(inst => inst.extra?.stateRead || inst.extra?.stateWrite);
  assert.equal(states.length, 13);
  for (const source of states) {
    const binding = readCanonicalRegisterStateBinding(ir, source, context);
    assert.ok(binding, `${source.id}: ${source.extra.publicStateIdentity}`);
    assert.equal(binding.source, source);
    assert.equal(binding.input, source.args[0].value);
    assert.equal(binding.output, source.dst);
    assert.equal(binding.input.bits, binding.output.bits);
    assert.equal(binding.canonicalNode.kind, binding.kind);
    assert.equal(binding.state.physicalIdentity.kind, 'register');
    assert.equal(readCanonicalRegisterStateBinding({ ...ir }, source), null);
    assert.equal(readCanonicalRegisterStateBinding(ir, { ...source }), null);
    for (const key of ['binaryId','functionId','snapshotId','architecture','semanticsVersion']) {
      assert.equal(readCanonicalRegisterStateBinding(ir, source, { ...context, [key]:'foreign' }), null);
    }
    assert.equal(readCanonicalRegisterStateBinding(ir, source, null), null);
  }
});

test('state assignment authority is revoked by changed operands, upstream values, metadata and accessors', () => {
  for (const mutate of [
    source => { source.args[0].value = { ...source.args[0].value }; },
    source => { source.args[0].value.bits = 32; },
    source => { source.dst.def = { ...source }; },
    source => { source.extra.stateRead = { ...source.extra.stateRead }; },
    source => { source.extra.stateReadProof = { ...source.extra.stateReadProof }; },
    source => { delete source.extra.stateRead; delete source.extra.publicStateIdentity; },
    source => { source.extra.stateRead = false; source.extra.publicStateIdentity = false; },
    source => { source.extra.unknownEffects = true; },
    source => { Object.defineProperty(source, 'args', { get() { assert.fail('must not invoke accessor'); } }); },
  ]) {
    const { ir } = textRowConditionalRegionFixture();
    const source = ir.instructions.find(inst => inst.extra?.stateRead);
    assert.ok(readCanonicalRegisterStateBinding(ir, source));
    mutate(source);
    assert.equal(readCanonicalRegisterStateBinding(ir, source), null);
  }
});

test('batch state currentness observes the shared graph once and retains hidden state obligations', () => {
  const { ir, identity:context } = textRowConditionalRegionFixture();
  const batch = prepareCanonicalRegisterStateBindings(ir, context);
  assert.equal(batch.size, 13);
  assert.equal(batch.observationCount, 1);
  assert.ok(Number.isSafeInteger(batch.workItems) && batch.workItems > batch.size);
  const source = ir.instructions.find(inst => inst.extra?.stateRead);
  const descriptor = Object.getOwnPropertyDescriptor;
  const count = check => {
    let visits = 0;
    Object.getOwnPropertyDescriptor = (object, key) => {
      if (object === source) visits++;
      return descriptor(object, key);
    };
    try { assert.ok(check()); return visits; }
    finally { Object.getOwnPropertyDescriptor = descriptor; }
  };
  const singleVisits = count(() => readCanonicalRegisterStateBinding(ir, source, context));
  assert.ok(singleVisits > 0);
  assert.equal(count(() => batch.isCurrent()), singleVisits,
    'all assignments must share one graph observation per lifecycle check');
  delete source.extra.stateRead;
  delete source.extra.publicStateIdentity;
  assert.equal(batch.isCurrent(), false);
  assert.equal(prepareCanonicalRegisterStateBindings(ir, { ...context, snapshotId:'foreign' }).status, 'unavailable');
});

test('reachability refuses hidden canonical state markers and unavailable state context', async () => {
  for (const change of ['delete', 'false', 'proof', 'context']) {
    const f = textRowConditionalRegionFixture();
    const source = f.ir.instructions.find(inst => inst.extra?.stateRead);
    if (change === 'delete') { delete source.extra.stateRead; delete source.extra.publicStateIdentity; }
    if (change === 'false') { source.extra.stateRead = false; source.extra.publicStateIdentity = false; }
    if (change === 'proof') delete source.extra.stateReadProof;
    const context = change === 'context' ? { ...f.identity, snapshotId:'foreign' } : f.identity;
    const seed = decompileSemantic(f.model, { ...f.options, ir:f.ir,
      deterministicTransforms:true, phase8PrepareRegionProof:true });
    const region = readSemanticConditionalRegions(seed)?.regions.find(item => item.selection.header === 0);
    const structure = prepareConditionalRegionStructure(region?.record, f.ir, { identity:context, timeoutMs:5000 });
    assert.equal(structure.status, 'complete', `${change}: ${structure.reason}`);
    const result = await prepareConditionalRegionReachability(structure, f.ir, {
      identity:context, timeoutMs:5000, backendTier:'tiered',
    });
    assert.equal(result.reason, 'unproved-state-effects', change);
    assert.equal(result.status, 'partial');
    assert.equal(readConditionalRegionReachability(result, f.ir, context), null);
  }
});

test('state bindings retain actual reaching definitions and graph membership after facade writes', () => {
  for (const mutate of [
    (ir, write) => { write.args[0].value.def.sub = 'foreign'; },
    (ir, write) => { write.args[0].value.const = 123n; },
    (ir, write) => { ir.instructions[ir.instructions.indexOf(write)] = { ...write }; },
    (ir, write) => { const block = ir.blocks.find(block => block.index === write.block);
      block.insts[block.insts.indexOf(write)] = { ...write }; },
    (ir, write) => { write.extra.attributes = { ...write.extra.attributes, machineEffects:{
      ...write.extra.attributes.machineEffects, possibleFaults:['injected-fault'],
    } }; },
  ]) {
    const { ir, identity:context } = textRowConditionalRegionFixture();
    const write = ir.instructions.find(inst => inst.extra?.stateWrite && inst.extra.publicStateIdentity === 'x1');
    const read = ir.instructions.find(inst => inst.extra?.stateRead && inst.extra.publicStateIdentity === 'x1');
    assert.ok(write && read);
    const binding = readCanonicalRegisterStateBinding(ir, read, context);
    assert.ok(binding);
    assert.equal(binding.input, write.dst, 'canonical reaching definition supplies the real register read');
    assert.ok(readCanonicalRegisterStateBinding(ir, write, context));
    // This fixture's facade issues a new observer through its actual write log.
    assert.notEqual(binding, projectedRegisterStateBindingCandidate(ir, read));
    mutate(ir, write);
    assert.equal(readCanonicalRegisterStateBinding(ir, read, context), null);
    assert.equal(readCanonicalRegisterStateBinding(ir, write, context), null);
  }
});

test('public projection of identical canonical or copied SSA cannot mint state assignment authority', () => {
  // A synthetic plugin isolates the issuer boundary; the ARM64 fixture above
  // separately verifies the real producer. Both use the canonical SSA builder.
  const plugin = { id:'state-binding-test', semanticVersion:'1', fixedInstructionSize:4,
    liftExact(decoded) {
      const register = { kind:'register', registerId:'state0', widthBits:32 };
      return createMachineEffectBundle({ instructionId:decoded.instructionId,
        architectureId:this.id, mode:decoded.mode, origin:decoded.origin,
        operations:[
          { id:`${decoded.instructionId}:write`, kind:'register-write', register,
            value:{ kind:'bitvector', widthBits:32, value:'7' } },
          { id:`${decoded.instructionId}:read`, kind:'register-read', register,
            value:{ kind:'bitvector', widthBits:32 } },
        ], controlEffect:{ kind:'return' }, possibleFaults:[], completeness:'exact' });
    } };
  const result = buildSemanticV2CompatibilityPipeline({ architecturePlugin:plugin,
    decoderSemanticVersion:'test-1', binaryId:'state-binding-binary', sliceId:'state-binding-slice',
    addressWidthBits:64, entryBlockKey:'entry', blocks:[{ key:'entry', startAddress:0x1000n,
      instructions:[{ decoded:{ address:0x1000n, mode:'test' } }], successors:[] }] });
  const context = projectedRegisterStateContext(result.legacyV1);
  assert.ok(context);
  const states = result.legacyV1.instructions.filter(inst => inst.extra?.stateRead || inst.extra?.stateWrite);
  assert.equal(states.length, 2);
  for (const inst of states) assert.ok(readCanonicalRegisterStateBinding(result.legacyV1, inst, context));
  for (const ssa of [result.ssa, structuredClone(result.ssa)]) {
    const projected = projectSemanticIrV2ToLegacyV1(result.semanticIr, { cfg:result.cfg, ssa, memorySsa:result.memorySsa });
    const copies = projected.instructions.filter(inst => inst.extra?.stateRead || inst.extra?.stateWrite);
    assert.equal(copies.length, states.length);
    assert.equal(projectedRegisterStateContext(projected), null);
    for (const inst of copies) {
      const proofKey = inst.extra.stateRead ? 'stateReadProof' : 'stateWriteProof';
      assert.deepEqual(inst.extra[proofKey], states.find(source => source.semanticNodeId === inst.semanticNodeId).extra[proofKey]);
      assert.equal(readCanonicalRegisterStateBinding(projected, inst, context), null);
    }
  }
});


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
