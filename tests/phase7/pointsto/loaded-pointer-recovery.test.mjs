import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { buildSemanticSsa } from '../../../js/semantics/ssa/build.js';
import { buildMemorySsa } from '../../../js/semantics/memoryssa/build.js';
import { reachingConcreteStore } from '../../../js/semantics/memoryssa/queries.js';
import { classifySemanticMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';
import { A2_ANALYZER_VERSION, analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import {
  PHASE7_ALIAS_SOLVER_VERSION,
  createPhase7AliasSolver,
} from '../../../js/analysis/alias/solver.js';
import { pointsToDigest } from '../../../js/analysis/pointsto/lattice.js';
import {
  PHASE7_ANALYSIS_CONTRACT_VERSION,
  createAnalysisSurface,
} from '../../../js/analysis/index.js';

const origin = (id) => ({ instructionIds: [`instruction_${id}`] });

function loadedPointerFixture({ unknownCall = false } = {}) {
  const functionId = 'function_loaded_pointer_recovery';
  const blockId = 'entry';
  const nodes = [
    {
      id: 'node_base',
      kind: 'state-read',
      blockId,
      inputs: [],
      outputs: ['base'],
      variable: { key: 'state:sp', kind: 'physical-state', scope: 'function' },
      origin: origin('node_base'),
    },
    {
      id: 'node_zero',
      kind: 'const',
      blockId,
      inputs: [],
      outputs: ['zero'],
      attributes: { constant: { value: '0', widthBits: 64 } },
      origin: origin('node_zero'),
    },
    {
      id: 'node_target_offset',
      kind: 'const',
      blockId,
      inputs: [],
      outputs: ['target_offset'],
      attributes: { constant: { value: '32', widthBits: 64 } },
      origin: origin('node_target_offset'),
    },
    {
      id: 'node_slot',
      kind: 'binary',
      blockId,
      inputs: ['base', 'zero'],
      outputs: ['slot'],
      operator: 'add',
      origin: origin('node_slot'),
    },
    {
      id: 'node_pointer',
      kind: 'binary',
      blockId,
      inputs: ['base', 'target_offset'],
      outputs: ['pointer'],
      operator: 'add',
      origin: origin('node_pointer'),
    },
    {
      id: 'node_store',
      kind: 'store',
      blockId,
      inputs: ['slot', 'pointer'],
      outputs: [],
      memory: {
        addressSpace: 'memory',
        addressValueId: 'slot',
        widthBits: 64,
        endian: 'little',
        volatility: false,
        atomic: false,
      },
      origin: origin('node_store'),
    },
    {
      id: 'node_load',
      kind: 'load',
      blockId,
      inputs: ['slot'],
      outputs: ['loaded'],
      memory: {
        addressSpace: 'memory',
        addressValueId: 'slot',
        widthBits: 64,
        endian: 'little',
        volatility: false,
        atomic: false,
      },
      origin: origin('node_load'),
    },
  ];
  if (unknownCall) {
    nodes.splice(nodes.findIndex((node) => node.id === 'node_load'), 0, {
      id: 'node_call_unknown',
      kind: 'call',
      blockId,
      inputs: [],
      outputs: [],
      call: {
        targetValueIds: [],
        targetEntityIds: [],
        arguments: [],
        returns: [],
        stateReads: [],
        stateWrites: [],
        memoryRead: { scope: 'unknown' },
        memoryWrite: { scope: 'unknown' },
        controlEffects: [],
        determinism: 'unknown',
        noreturn: 'unknown',
        mayThrow: 'unknown',
        summarySource: 'fixture',
        completeness: 'unknown',
        unknownEffects: { reason: 'unresolved-call', categories: ['memory', 'state'] },
      },
      completeness: 'unknown',
      unknown: { reason: 'unresolved-call', categories: ['memory', 'state'] },
      origin: origin('node_call_unknown'),
    });
  }
  const addressType = { kind: 'address', widthBits: 64, addressSpace: 'memory' };
  const values = [
    { id: 'base', kind: 'definition', machineType: addressType, definitionNodeId: 'node_base', origin: origin('base') },
    { id: 'zero', kind: 'definition', machineType: { kind: 'bitvector', widthBits: 64 }, definitionNodeId: 'node_zero', origin: origin('zero') },
    { id: 'target_offset', kind: 'definition', machineType: { kind: 'bitvector', widthBits: 64 }, definitionNodeId: 'node_target_offset', origin: origin('target_offset') },
    { id: 'slot', kind: 'definition', machineType: addressType, definitionNodeId: 'node_slot', origin: origin('slot') },
    { id: 'pointer', kind: 'definition', machineType: addressType, definitionNodeId: 'node_pointer', origin: origin('pointer') },
    { id: 'loaded', kind: 'definition', machineType: addressType, definitionNodeId: 'node_load', origin: origin('loaded') },
  ];
  const ir = createSemanticIrFunction({
    functionId,
    entryBlockId: blockId,
    blocks: [{ id: blockId, nodeIds: nodes.map((node) => node.id), origin: origin(blockId) }],
    values,
    nodes,
    completeness: unknownCall ? 'partial' : 'complete',
    unknowns: unknownCall ? [{ reason: 'unresolved-call', categories: ['memory', 'state'] }] : [],
    origin: origin('function'),
  });
  const cfg = createSemanticCfg({
    functionId,
    entryBlockId: blockId,
    blocks: [{ id: blockId, successors: [] }],
  });
  const ssa = buildSemanticSsa(ir, cfg);
  const resolveRegion = (memory, context) => classifySemanticMemoryRegion(ir, context.node, {
    binaryId: 'binary_loaded_pointer_fixture',
    ssa,
  });
  const baselineSolver = createPhase7AliasSolver({
    ir,
    cfg,
    ssa,
    options: { snapshotId: 'snapshot-loaded-pointer-fixture' },
  });
  const memorySsa = buildMemorySsa(ir, cfg, {
    resolveRegion,
    queryAlias: baselineSolver.queryAlias,
  });
  const loadUse = memorySsa.uses.find((use) => use.sourceEntityId === 'node_load');
  assert.ok(loadUse, 'fixture must contain one canonical MemorySSA load use');
  if (!unknownCall) {
    const reachingStore = reachingConcreteStore(memorySsa, loadUse);
    assert.ok(reachingStore, 'fixture must contain one exact reaching store proof');
    assert.equal(reachingStore.sourceEntityId, 'node_store');
  }
  return { ir, cfg, ssa, memorySsa };
}

function cloneMemorySsa(built, mutate = () => {}) {
  const memorySsa = structuredClone(built.memorySsa);
  mutate(memorySsa);
  return memorySsa;
}

function cloneIr(built, mutate = () => {}) {
  const ir = structuredClone(built.ir);
  mutate(ir);
  return ir;
}

function runWithMemory(built, memorySsa = built.memorySsa, options = {}) {
  return analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, {
    snapshotId: 'snapshot-loaded-pointer-fixture',
    ...options,
    memorySsa,
  });
}

function loadedSet(result) {
  return result.pointsTo.get('loaded');
}

function assertUnresolved(result, reason = null) {
  const loaded = loadedSet(result);
  assert.equal(loaded.top, true);
  assert.equal(loaded.targets.length, 0);
  if (reason != null) assert.ok(loaded.lossReasons.includes(reason), `missing loss reason ${reason}`);
}

test('canonical store-pointer/load-pointer fixture recovers the stored pointer exactly', () => {
  const built = loadedPointerFixture();
  const result = analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, {
    snapshotId: 'snapshot-loaded-pointer-fixture',
    memorySsa: built.memorySsa,
  });
  const loaded = result.pointsTo.get('loaded');
  const pointer = result.pointsTo.get('pointer');
  assert.equal(loaded.top, false, 'post-fix contract expects a finite recovered loaded pointer');
  assert.deepEqual(loaded.targets, pointer.targets, 'loaded target identity/provenance must copy the stored pointer');
  assert.deepEqual(loaded.targets.map((target) => target.offsetRange), [{ min: 32n, max: 32n, exact: true }]);
  assert.equal(loaded.targets[0].widthBits, 64);
  assert.equal(result.status.completeness, 'complete');
  assert.equal(A2_ANALYZER_VERSION, '1.1.1');
  assert.equal(result.status.analyzerVersion, A2_ANALYZER_VERSION);
  assert.equal(result.recovery?.proofs?.loaded?.storeNodeId, 'node_store');
});

test('loaded-pointer recovery is deterministic across identical replays', () => {
  const firstFixture = loadedPointerFixture();
  const secondFixture = loadedPointerFixture();
  const options = { snapshotId: 'snapshot-loaded-pointer-fixture' };
  const first = analyzeLocalPointsTo(firstFixture.ir, firstFixture.cfg, firstFixture.ssa, {
    ...options,
    memorySsa: firstFixture.memorySsa,
  });
  const second = analyzeLocalPointsTo(secondFixture.ir, secondFixture.cfg, secondFixture.ssa, {
    ...options,
    memorySsa: secondFixture.memorySsa,
  });
  assert.deepEqual(
    [...first.pointsTo.entries()].map(([id, set]) => [id, pointsToDigest(set)]),
    [...second.pointsTo.entries()].map(([id, set]) => [id, pointsToDigest(set)]),
  );
  assert.deepEqual(first.recovery, second.recovery);
  assert.deepEqual(first.status, second.status);
});

test('provider proof identity changes without changing recovered target semantics', () => {
  const built = loadedPointerFixture();
  const baseline = runWithMemory(built);
  const changedMemory = cloneMemorySsa(built, (memorySsa) => {
    const use = memorySsa.uses.find((item) => item.sourceEntityId === 'node_load');
    const definition = memorySsa.definitions.find((item) => item.id === use.reachingDefinitionId);
    const alternative = definition.proof.providerProof.alternatives[0];
    alternative.proof = {
      ...alternative.proof,
      evidenceIds: ['provider-evidence-replayed'],
      proof: {
        ...alternative.proof.proof,
        analyzerVersion: 'provider-proof-replayed',
      },
    };
  });
  const changedFirst = runWithMemory(built, changedMemory);
  const changedSecond = runWithMemory(built, cloneMemorySsa(built, (memorySsa) => {
    const use = memorySsa.uses.find((item) => item.sourceEntityId === 'node_load');
    const definition = memorySsa.definitions.find((item) => item.id === use.reachingDefinitionId);
    const alternative = definition.proof.providerProof.alternatives[0];
    alternative.proof = {
      ...alternative.proof,
      evidenceIds: ['provider-evidence-replayed'],
      proof: {
        ...alternative.proof.proof,
        analyzerVersion: 'provider-proof-replayed',
      },
    };
  }));
  assert.deepEqual(changedFirst.pointsTo.get('loaded').targets, baseline.pointsTo.get('loaded').targets);
  assert.equal(changedFirst.pointsTo.get('loaded').top, false);
  assert.notEqual(
    changedFirst.recovery.proofs.loaded.proofIdentity,
    baseline.recovery.proofs.loaded.proofIdentity,
  );
  assert.equal(
    changedFirst.recovery.proofs.loaded.proofIdentity,
    changedSecond.recovery.proofs.loaded.proofIdentity,
  );
});

test('MayAlias and unknown-clobber evidence never forwards a pointer', () => {
  const built = loadedPointerFixture();
  const mayAlias = cloneMemorySsa(built, (memorySsa) => {
    const use = memorySsa.uses.find((item) => item.sourceEntityId === 'node_load');
    use.aliasRelation = 'may';
  });
  assertUnresolved(runWithMemory(built, mayAlias), 'unresolved-load');

  const unknownClobber = cloneMemorySsa(built, (memorySsa) => {
    const use = memorySsa.uses.find((item) => item.sourceEntityId === 'node_load');
    const definition = memorySsa.definitions.find((item) => item.id === use.reachingDefinitionId);
    definition.kind = 'unknown-clobber';
    definition.aliasRelation = 'unknown';
    definition.proof = { kind: 'conservative-memory-clobber', aliasRelation: 'unknown' };
  });
  assertUnresolved(runWithMemory(built, unknownClobber), 'unresolved-load');

  const callFixture = loadedPointerFixture({ unknownCall: true });
  const callUse = callFixture.memorySsa.uses.find((item) => item.sourceEntityId === 'node_load');
  const callDefinition = callFixture.memorySsa.definitions.find((item) => item.id === callUse.reachingDefinitionId);
  assert.equal(callDefinition.kind, 'call-clobber');
  assertUnresolved(runWithMemory(callFixture), 'unresolved-load');
});

test('incomplete, ambiguous, partial, incompatible, and reordered accesses stay unresolved', () => {
  const built = loadedPointerFixture();
  const cases = [
    ['incomplete-call', (memorySsa) => {
      const metadata = memorySsa.accessMetadata.find((item) => item.entityKind === 'use');
      metadata.broad = true;
    }],
    ['multiple-definitions', (memorySsa) => {
      const use = memorySsa.uses.find((item) => item.sourceEntityId === 'node_load');
      const definition = memorySsa.definitions.find((item) => item.id === use.reachingDefinitionId);
      definition.kind = 'memory-phi';
      definition.incoming = [{ predecessorBlockId: 'entry', definitionId: definition.previousDefinitionIds[0] }];
    }],
    ['partial-bytes', (memorySsa) => {
      const metadata = memorySsa.accessMetadata.find((item) => item.entityKind === 'definition');
      metadata.memory.widthBits = 32;
    }],
    ['incompatible-endian', (memorySsa) => {
      const metadata = memorySsa.accessMetadata.find((item) => item.entityKind === 'use');
      metadata.memory.endian = 'big';
    }],
  ];
  for (const [, mutate] of cases) {
    assertUnresolved(runWithMemory(built, cloneMemorySsa(built, mutate)), 'unresolved-load');
  }

  const volatileIr = cloneIr(built, (ir) => {
    for (const node of ir.nodes.filter((item) => item.kind === 'load' || item.kind === 'store')) {
      node.memory.volatility = true;
    }
  });
  assertUnresolved(analyzeLocalPointsTo(volatileIr, built.cfg, built.ssa, {
    snapshotId: 'snapshot-loaded-pointer-fixture', memorySsa: built.memorySsa,
  }), 'unresolved-load');
  const atomicIr = cloneIr(built, (ir) => {
    for (const node of ir.nodes.filter((item) => item.kind === 'load' || item.kind === 'store')) {
      node.memory.atomic = true;
    }
  });
  assertUnresolved(analyzeLocalPointsTo(atomicIr, built.cfg, built.ssa, {
    snapshotId: 'snapshot-loaded-pointer-fixture', memorySsa: built.memorySsa,
  }), 'unresolved-load');
});

test('zero, non-integer, oversized, and invalid-endian accesses fail closed', () => {
  const built = loadedPointerFixture();
  const cases = [
    ['zero-width', (ir) => {
      for (const node of ir.nodes.filter((item) => item.kind === 'load' || item.kind === 'store')) node.memory.widthBits = 0;
    }],
    ['non-integer-width', (ir) => {
      for (const node of ir.nodes.filter((item) => item.kind === 'load' || item.kind === 'store')) node.memory.widthBits = 64.5;
    }],
    ['oversized-width', (ir) => {
      for (const node of ir.nodes.filter((item) => item.kind === 'load' || item.kind === 'store')) node.memory.widthBits = Number.MAX_SAFE_INTEGER + 1;
    }],
    ['invalid-endian', (ir) => {
      for (const node of ir.nodes.filter((item) => item.kind === 'load' || item.kind === 'store')) node.memory.endian = 'middle';
    }],
  ];
  for (const [, mutate] of cases) {
    const invalidIr = cloneIr(built, mutate);
    const result = analyzeLocalPointsTo(invalidIr, built.cfg, built.ssa, {
      snapshotId: 'snapshot-loaded-pointer-fixture',
      memorySsa: built.memorySsa,
    });
    assertUnresolved(result, 'unresolved-load');
  }
});

test('missing or incompatible provenance refuses exact recovery', () => {
  const built = loadedPointerFixture();
  const missingOrigin = cloneIr(built, (ir) => {
    const pointer = ir.values.find((value) => value.id === 'pointer');
    pointer.origin.instructionIds = [];
  });
  assertUnresolved(analyzeLocalPointsTo(missingOrigin, built.cfg, built.ssa, {
    snapshotId: 'snapshot-loaded-pointer-fixture', memorySsa: built.memorySsa,
  }), 'unresolved-load');

  const incompatibleWidth = cloneIr(built, (ir) => {
    const pointer = ir.values.find((value) => value.id === 'pointer');
    pointer.machineType.widthBits = 32;
  });
  assertUnresolved(analyzeLocalPointsTo(incompatibleWidth, built.cfg, built.ssa, {
    snapshotId: 'snapshot-loaded-pointer-fixture', memorySsa: built.memorySsa,
  }), 'unresolved-load');
});

test('stale identities and malformed metadata fail closed', () => {
  const built = loadedPointerFixture();
  const staleSnapshot = runWithMemory(built, built.memorySsa, {
    memorySsaBinding: { snapshotId: 'snapshot-stale' },
  });
  assertUnresolved(staleSnapshot, 'unresolved-load');
  assert.equal(staleSnapshot.recovery.bindingState, 'stale');

  const staleFunction = cloneMemorySsa(built, (memorySsa) => { memorySsa.functionId = 'function-other'; });
  const staleFunctionResult = runWithMemory(built, staleFunction);
  assertUnresolved(staleFunctionResult, 'unresolved-load');
  assert.equal(staleFunctionResult.recovery.bindingState, 'stale');

  const staleBuild = cloneMemorySsa(built, (memorySsa) => { memorySsa.buildVersion = '0.0.0'; });
  assertUnresolved(runWithMemory(built, staleBuild), 'unresolved-load');

  const staleSource = cloneMemorySsa(built, (memorySsa) => {
    const use = memorySsa.uses.find((item) => item.sourceEntityId === 'node_load');
    use.sourceEntityId = 'node_missing';
  });
  assertUnresolved(runWithMemory(built, staleSource), 'unresolved-load');

  const malformedMetadata = cloneMemorySsa(built, (memorySsa) => {
    memorySsa.accessMetadata = memorySsa.accessMetadata.filter((item) => item.entityKind !== 'use');
  });
  const malformed = runWithMemory(built, malformedMetadata);
  assertUnresolved(malformed, 'unresolved-load');
  assert.equal(malformed.recovery.bindingState, 'current');
  assert.equal(malformed.recovery.publicationAllowed, true);
  assert.ok(malformed.recovery.diagnostics.some((item) => item.reason === 'load-access-metadata-mismatch'));
});

test('cancellation, iteration, value, and target limits publish no refined pointer', () => {
  const built = loadedPointerFixture();
  const cancelledController = new AbortController();
  cancelledController.abort();
  const cancelled = runWithMemory(built, built.memorySsa, { signal: cancelledController.signal });
  assertUnresolved(cancelled, 'unsupported-operation');
  assert.equal(cancelled.status.completeness, 'partial');
  assert.equal(cancelled.recovery.bindingState, 'partial');
  assert.equal(cancelled.recovery.publicationAllowed, false);
  const cancelledReplayController = new AbortController();
  cancelledReplayController.abort();
  const cancelledReplay = runWithMemory(built, built.memorySsa, { signal: cancelledReplayController.signal });
  assert.deepEqual(cancelled.status, cancelledReplay.status);
  assert.deepEqual(cancelled.recovery, cancelledReplay.recovery);
  assert.deepEqual(
    [...cancelled.pointsTo.entries()].map(([id, set]) => [id, pointsToDigest(set)]),
    [...cancelledReplay.pointsTo.entries()].map(([id, set]) => [id, pointsToDigest(set)]),
  );

  const iterationLimited = runWithMemory(built, built.memorySsa, { budget: { maxIterations: 1 } });
  assertUnresolved(iterationLimited, 'unsupported-operation');
  assert.equal(iterationLimited.status.completeness, 'truncated');
  assert.equal(iterationLimited.recovery.publicationAllowed, false);
  const iterationReplay = runWithMemory(built, built.memorySsa, { budget: { maxIterations: 1 } });
  assert.deepEqual(iterationLimited.status, iterationReplay.status);
  assert.deepEqual(iterationLimited.recovery, iterationReplay.recovery);
  assert.deepEqual(
    [...iterationLimited.pointsTo.entries()].map(([id, set]) => [id, pointsToDigest(set)]),
    [...iterationReplay.pointsTo.entries()].map(([id, set]) => [id, pointsToDigest(set)]),
  );

  const valueLimited = runWithMemory(built, built.memorySsa, { budget: { maxValues: 1 } });
  assert.equal(valueLimited.status.completeness, 'unsupported');
  assert.equal(valueLimited.pointsTo.size, 0);

  const targetLimited = runWithMemory(built, built.memorySsa, { budget: { maxTargetsPerSet: 0 } });
  assertUnresolved(targetLimited, 'unresolved-load');
  assert.ok(targetLimited.pointsTo.get('pointer').lossReasons.includes('target-cap'));
  assert.ok(targetLimited.pointsTo.get('loaded').lossReasons.includes('target-cap'));
  assert.equal(targetLimited.recovery.publicationAllowed, true);
});

test('the solver stages a refinement atomically and invalidates escape evidence', () => {
  const built = loadedPointerFixture();
  const solver = createPhase7AliasSolver({
    ir: built.ir,
    cfg: built.cfg,
    ssa: built.ssa,
    options: { snapshotId: 'snapshot-loaded-pointer-fixture' },
  });
  assert.equal(PHASE7_ALIAS_SOLVER_VERSION, '1.1.0');
  assert.equal(solver.analyzerVersion, PHASE7_ALIAS_SOLVER_VERSION);
  const baseline = solver.pointsToRun();
  assertUnresolved(baseline, 'unresolved-load');
  const escapeBefore = solver.escapeRun();
  solver.refineMemorySsa(built.memorySsa, {
    snapshotId: 'snapshot-loaded-pointer-fixture',
    functionId: built.ir.functionId,
    semanticIrVersion: built.ir.contractVersion,
    memorySsaBuildVersion: built.memorySsa.buildVersion,
    completeness: 'complete',
  });
  const refined = solver.pointsToRun();
  assert.equal(refined.pointsTo.get('loaded').top, false);
  assert.notEqual(solver.escapeRun(), escapeBefore);

  const guardedController = new AbortController();
  const guardedSolver = createPhase7AliasSolver({
    ir: built.ir,
    cfg: built.cfg,
    ssa: built.ssa,
    options: { snapshotId: 'snapshot-loaded-pointer-fixture', signal: guardedController.signal },
  });
  const guardedBaseline = guardedSolver.pointsToRun();
  guardedController.abort();
  const guardedAfter = guardedSolver.refineMemorySsa(built.memorySsa, {
    snapshotId: 'snapshot-loaded-pointer-fixture',
    functionId: built.ir.functionId,
    semanticIrVersion: built.ir.contractVersion,
    memorySsaBuildVersion: built.memorySsa.buildVersion,
    completeness: 'complete',
  });
  assert.deepEqual(
    [...guardedBaseline.pointsTo.entries()].map(([id, set]) => [id, pointsToDigest(set)]),
    [...guardedAfter.pointsTo.entries()].map(([id, set]) => [id, pointsToDigest(set)]),
  );
  assertUnresolved(guardedAfter, 'unresolved-load');
  assert.equal(guardedAfter.recovery.publicationAllowed, false);
});

test('the public analysis surface observes exact and conservative loaded pointers', () => {
  const built = loadedPointerFixture();
  const positive = createAnalysisSurface({
    ir: built.ir,
    cfg: built.cfg,
    ssa: built.ssa,
    memorySsa: built.memorySsa,
    snapshotId: 'snapshot-loaded-pointer-fixture',
  });
  assert.equal(positive.contractVersion, PHASE7_ANALYSIS_CONTRACT_VERSION);
  const positiveRun = positive.pointsTo();
  assert.equal(positiveRun.pointsTo.get('loaded').top, false);
  assert.deepEqual(positiveRun.pointsTo.get('loaded').targets, positiveRun.pointsTo.get('pointer').targets);

  const mayAlias = cloneMemorySsa(built, (memorySsa) => {
    const use = memorySsa.uses.find((item) => item.sourceEntityId === 'node_load');
    use.aliasRelation = 'may';
  });
  const negative = createAnalysisSurface({
    ir: built.ir,
    cfg: built.cfg,
    ssa: built.ssa,
    memorySsa: mayAlias,
    snapshotId: 'snapshot-loaded-pointer-fixture',
  });
  assertUnresolved(negative.pointsTo(), 'unresolved-load');
});