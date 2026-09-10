import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { buildSemanticSsa } from '../../../js/semantics/ssa/build.js';
import { MEMORY_SSA_BUILD_VERSION, buildMemorySsa } from '../../../js/semantics/memoryssa/build.js';
import { reachingConcreteStore } from '../../../js/semantics/memoryssa/queries.js';
import { classifySemanticMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';
import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';
import { stableDigest } from '../../../js/core/identity/index.js';
import { buildFixture } from '../corpus/fixtures.mjs';

// #5215: escape facts belong to whichever points-to map is published. When a
// refined MemorySSA candidate is rejected (stale, partial, cancelled, …), the
// solver restores the baseline map — but it used to keep the cached escape run
// computed against the *rejected* candidate. `pointsToAlias()` consumes that
// run's `nonEscapingRoots` as strong `distinct-non-escaping-allocation`
// authority, so proofs from a map that is no longer published leaked into
// alias answers computed against the baseline.

const FIXTURE = 'frame-non-escaping';
const REFINEMENT = () => {
  const built = buildFixture(FIXTURE);
  return {
    built,
    refinement: {
      snapshotId: 'snapshot-5215',
      functionId: built.ir.functionId,
      semanticIrVersion: built.ir.contractVersion,
      memorySsaBuildVersion: built.memorySsa.buildVersion,
      completeness: 'complete',
    },
  };
};

test('#5215 a rejected refinement drops the escape cache derived from it', () => {
  const { built, refinement } = REFINEMENT();
  const solver = createPhase7AliasSolver({
    ir: built.ir, cfg: built.cfg, ssa: built.ssa,
    options: { snapshotId: 'snapshot-5215' },
  });

  solver.refineMemorySsa(built.memorySsa, refinement);
  const refinedEscape = solver.escapeRun();
  assert.ok(refinedEscape, 'the publishable refinement caches an escape run');
  const refinedRoots = refinedEscape.nonEscapingRoots.size;

  const baseline = solver.pointsToRun();
  const baselineDigest = [...baseline.pointsTo.entries()].map(([id, set]) => [id, set.targets.length]).sort();

  // A second, non-publishable refinement (partial completeness) restores the
  // baseline map and must invalidate the cached escape run.
  solver.refineMemorySsa(built.memorySsa, { ...refinement, completeness: 'partial' });
  const restored = solver.pointsToRun();
  assert.deepEqual(
    [...restored.pointsTo.entries()].map(([id, set]) => [id, set.targets.length]).sort(),
    baselineDigest,
    'the baseline map is authoritative again',
  );

  const escapeAfter = solver.escapeRun();
  assert.notEqual(escapeAfter, refinedEscape, 'the escape cache must not survive the rejected swap');
});

test('#5215 the escape run is recomputed against the restored baseline map', () => {
  const { built, refinement } = REFINEMENT();
  const solver = createPhase7AliasSolver({
    ir: built.ir, cfg: built.cfg, ssa: built.ssa,
    options: { snapshotId: 'snapshot-5215' },
  });

  solver.refineMemorySsa(built.memorySsa, refinement);
  const refinedEscape = solver.escapeRun();

  solver.refineMemorySsa(built.memorySsa, { ...refinement, completeness: 'partial' });
  const escapeAfter = solver.escapeRun();
  assert.ok(escapeAfter);
  // Same fixture, same underlying facts: a recomputation against the baseline
  // map must produce the same proof set as a fresh solver's view of that map,
  // not the refined run's object.
  assert.notEqual(escapeAfter, refinedEscape);
  assert.equal(escapeAfter.status.completeness, refinedEscape.status.completeness);
});

// ---------------------------------------------------------------------------
// Consumer-level soundness regression.
//
// The fixture below makes the refined and baseline runs *disagree*: a pointer
// load that only the MemorySSA-backed run resolves feeds a store, so the
// baseline escape run sees an unresolved flow and may not prove any root
// non-escaping, while the refined run proves the frame root non-escaping.
// After a rejected refinement the stale proof must not flow back into
// `pointsToAlias()` as `distinct-non-escaping-allocation` authority.
// ---------------------------------------------------------------------------

const CONSUMER_SNAPSHOT = 'snapshot-loaded-pointer-fixture';
const ADDRESS_TYPE = Object.freeze({ kind: 'address', widthBits: 64, addressSpace: 'memory' });
const memoryAccess = (addressValueId, widthBits) => ({
  addressSpace: 'memory', addressValueId, widthBits, endian: 'little', volatility: false, atomic: false,
});

function buildConsumerFixture() {
  const functionId = 'function_loaded_pointer_recovery_5215';
  const blockId = 'entry';
  const nodes = [
    {
      id: 'node_base', kind: 'state-read', blockId, inputs: [], outputs: ['base'],
      variable: { key: 'state:sp', kind: 'physical-state', scope: 'function' }, origin: origin('node_base'),
    },
    {
      id: 'node_fp', kind: 'state-read', blockId, inputs: [], outputs: ['fp'],
      variable: { key: 'state:fp', kind: 'physical-state', scope: 'function' }, origin: origin('node_fp'),
    },
    {
      id: 'node_zero', kind: 'const', blockId, inputs: [], outputs: ['zero'],
      attributes: { constant: { value: '0', widthBits: 64 } }, origin: origin('node_zero'),
    },
    {
      id: 'node_target_offset', kind: 'const', blockId, inputs: [], outputs: ['target_offset'],
      attributes: { constant: { value: '32', widthBits: 64 } }, origin: origin('node_target_offset'),
    },
    {
      id: 'node_slot', kind: 'binary', blockId, inputs: ['base', 'zero'], outputs: ['slot'],
      operator: 'add', origin: origin('node_slot'),
    },
    {
      id: 'node_pointer', kind: 'binary', blockId, inputs: ['base', 'target_offset'], outputs: ['pointer'],
      operator: 'add', origin: origin('node_pointer'),
    },
    {
      id: 'node_store', kind: 'store', blockId, inputs: ['slot', 'pointer'], outputs: [],
      memory: memoryAccess('slot', 64), origin: origin('node_store'),
    },
    {
      id: 'node_load', kind: 'load', blockId, inputs: ['slot'], outputs: ['loaded'],
      memory: memoryAccess('slot', 64), origin: origin('node_load'),
    },
    {
      // Baseline: `loaded` is unresolved, so this store is an unresolved flow
      // and voids every non-escape proof. Refined: the load resolves and the
      // store becomes ordinary containment into the same local root.
      id: 'node_store_loaded', kind: 'store', blockId, inputs: ['slot', 'loaded'], outputs: [],
      memory: memoryAccess('slot', 64), origin: origin('node_store_loaded'),
    },
    {
      id: 'node_ret', kind: 'return', blockId, inputs: [], outputs: [], origin: origin('node_ret'),
    },
  ];
  const values = [
    { id: 'base', kind: 'definition', machineType: ADDRESS_TYPE, definitionNodeId: 'node_base', origin: origin('base') },
    { id: 'fp', kind: 'definition', machineType: ADDRESS_TYPE, definitionNodeId: 'node_fp', origin: origin('fp') },
    { id: 'zero', kind: 'definition', machineType: { kind: 'bitvector', widthBits: 64 }, definitionNodeId: 'node_zero', origin: origin('zero') },
    { id: 'target_offset', kind: 'definition', machineType: { kind: 'bitvector', widthBits: 64 }, definitionNodeId: 'node_target_offset', origin: origin('target_offset') },
    { id: 'slot', kind: 'definition', machineType: ADDRESS_TYPE, definitionNodeId: 'node_slot', origin: origin('slot') },
    { id: 'pointer', kind: 'definition', machineType: ADDRESS_TYPE, definitionNodeId: 'node_pointer', origin: origin('pointer') },
    { id: 'loaded', kind: 'definition', machineType: ADDRESS_TYPE, definitionNodeId: 'node_load', origin: origin('loaded') },
  ];
  const ir = createSemanticIrFunction({
    functionId,
    entryBlockId: blockId,
    blocks: [{ id: blockId, nodeIds: nodes.map((node) => node.id), origin: origin(blockId) }],
    values,
    nodes,
    completeness: 'complete',
    unknowns: [],
    origin: origin('function'),
  });
  const cfg = createSemanticCfg({
    functionId,
    entryBlockId: blockId,
    blocks: [{ id: blockId, successors: [] }],
  });
  const ssa = buildSemanticSsa(ir, cfg);
  const provider = createPhase7AliasSolver({ ir, cfg, ssa, options: { snapshotId: CONSUMER_SNAPSHOT } }).queryAlias;
  const resolveRegion = (memory, context) => classifySemanticMemoryRegion(ir, context.node, {
    binaryId: 'binary_5215_consumer',
    ssa,
  });
  const semanticIrDigest = stableDigest(ir);
  const scalarSsaDigest = stableDigest(ssa);
  const identity = {
    binaryId: 'binary_5215_consumer',
    sliceId: 'slice_5215_consumer',
    functionId,
    snapshotId: CONSUMER_SNAPSHOT,
    semanticIrId: `ir-${semanticIrDigest}`,
    semanticIrContractVersion: ir.contractVersion,
    semanticIrDigest,
    scalarSsaId: `ssa-${scalarSsaDigest}`,
    scalarSsaBuildVersion: '1.0.0',
    scalarSsaDigest,
    memorySsaId: 'mssa-5215-consumer',
    memorySsaBuildVersion: MEMORY_SSA_BUILD_VERSION,
    analyzerVersion: 'memoryssa-5215-consumer',
  };
  const memorySsa = buildMemorySsa(ir, cfg, {
    resolveRegion,
    queryAlias: provider,
    identity,
    snapshotId: CONSUMER_SNAPSHOT,
    canonicalIrIdentity: {
      functionId,
      semanticIrId: identity.semanticIrId,
      semanticIrContractVersion: ir.contractVersion,
      semanticIrDigest,
    },
  });
  return { ir, cfg, ssa, memorySsa };
}

function origin(id) {
  return { instructionIds: [`instruction_${id}`] };
}

const FP_REGION = Object.freeze({
  id: 'region-fp-external',
  kind: 'rooted-offset',
  rootEntityId: 'entity_fp_external_entry',
  offset: '0',
  widthBits: 64,
});
const QUERY = Object.freeze({
  leftRegion: 'node_store',
  rightRegion: FP_REGION,
  leftAccess: Object.freeze({ addressValueId: 'slot', widthBits: 64, addressSpace: 'memory' }),
  rightAccess: Object.freeze({ addressValueId: 'fp', widthBits: 64, addressSpace: 'memory' }),
});

function consumerRefinement(built, completeness = 'complete') {
  return {
    snapshotId: CONSUMER_SNAPSHOT,
    functionId: built.ir.functionId,
    semanticIrVersion: built.ir.contractVersion,
    memorySsaBuildVersion: built.memorySsa.buildVersion,
    completeness,
  };
}

test('#5215 a rejected refinement cannot mint a stale non-escaping NoAlias at the alias consumer', () => {
  const built = buildConsumerFixture();
  assert.ok(reachingConcreteStore(built.memorySsa, built.memorySsa.uses.find((use) => use.sourceEntityId === 'node_load')),
    'fixture precondition: the load has one exact reaching store');

  // Declare the frame root an allocation-site root so escape analysis can
  // prove it locally created; the fp root stays externally supplied.
  const rootKey = analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, { snapshotId: CONSUMER_SNAPSHOT })
    .pointsTo.get('slot').targets[0].rootKey;
  const options = { snapshotId: CONSUMER_SNAPSHOT, allocationRootKeys: [rootKey] };
  const solver = createPhase7AliasSolver({ ir: built.ir, cfg: built.cfg, ssa: built.ssa, options });

  // Precondition: refined and baseline escape facts actually disagree.
  const baselineEscape = solver.escapeRun();
  assert.equal(baselineEscape.status.completeness, 'partial',
    'baseline sees the unresolved load flow and proves nothing non-escaping');
  assert.equal(baselineEscape.nonEscapingRoots.size, 0);

  solver.refineMemorySsa(built.memorySsa, consumerRefinement(built));
  const refinedEscape = solver.escapeRun();
  assert.equal(refinedEscape.status.completeness, 'complete');
  assert.equal(refinedEscape.nonEscapingRoots.size, 1,
    'the refined run proves exactly the local root non-escaping');

  const refinedAlias = solver.alias(QUERY.leftRegion, QUERY.rightRegion, {
    leftAccess: QUERY.leftAccess, rightAccess: QUERY.rightAccess,
  });
  assert.equal(refinedAlias.relation, 'no',
    'precondition: the escape authority actively mints the NoAlias under the refinement');
  assert.ok(refinedAlias.reasonCodes.includes('distinct-non-escaping-allocation'));

  // A non-publishable refinement restores the baseline map.
  solver.refineMemorySsa(built.memorySsa, consumerRefinement(built, 'partial'));
  const restored = solver.pointsToRun();
  assert.equal(restored.recovery?.publicationAllowed, false);

  const escapeAfter = solver.escapeRun();
  assert.notEqual(escapeAfter, refinedEscape, 'the stale escape run must be dropped');
  assert.equal(escapeAfter.status.completeness, 'partial',
    'the recomputed run is the baseline run: unresolved flow, no non-escape proof');
  assert.equal(escapeAfter.nonEscapingRoots.size, 0);

  // The consumer must not answer from the rejected map's proofs.
  const aliasAfter = solver.alias(QUERY.leftRegion, QUERY.rightRegion, {
    leftAccess: QUERY.leftAccess, rightAccess: QUERY.rightAccess,
  });
  assert.notEqual(aliasAfter.relation, 'no',
    'a root that was non-escaping only under the rejected map cannot mint NoAlias after the fallback');
  assert.ok(!aliasAfter.reasonCodes.includes('distinct-non-escaping-allocation'));
  assert.equal(aliasAfter.relation, 'may');
  assert.ok(aliasAfter.reasonCodes.includes('escape-unproven'));
});

test('#5215 a publishable refinement recomputes escape evidence against the new map', () => {
  const built = buildConsumerFixture();
  const rootKey = analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, { snapshotId: CONSUMER_SNAPSHOT })
    .pointsTo.get('slot').targets[0].rootKey;
  const options = { snapshotId: CONSUMER_SNAPSHOT, allocationRootKeys: [rootKey] };
  const solver = createPhase7AliasSolver({ ir: built.ir, cfg: built.cfg, ssa: built.ssa, options });

  solver.refineMemorySsa(built.memorySsa, consumerRefinement(built));
  const firstEscape = solver.escapeRun();
  assert.equal(firstEscape.status.completeness, 'complete');
  assert.equal(firstEscape.nonEscapingRoots.size, 1);

  // A second publishable refinement whose MemorySSA lost the reaching store:
  // the load no longer resolves, so the published map is weaker and the proof
  // must be recomputed — not inherited from the first run.
  const weakerMemorySsa = structuredClone(built.memorySsa);
  const definitionIndex = weakerMemorySsa.definitions.findIndex(
    (definition) => definition.kind === 'memory-def' && definition.sourceEntityId === 'node_store',
  );
  assert.ok(definitionIndex >= 0, 'fixture precondition: the store defines the load region');
  weakerMemorySsa.definitions.splice(definitionIndex, 1);
  solver.refineMemorySsa(weakerMemorySsa, consumerRefinement(built));

  const published = solver.pointsToRun();
  assert.equal(published.recovery?.bindingState, 'current');
  assert.equal(published.recovery?.publicationAllowed, true, 'the weaker refinement is still publishable');

  const secondEscape = solver.escapeRun();
  assert.notEqual(secondEscape, firstEscape, 'escape evidence belongs to the newly published map');
  assert.equal(secondEscape.status.completeness, 'partial');
  assert.equal(secondEscape.nonEscapingRoots.size, 0, 'the withdrawn load resolution voids the proof set');

  const alias = solver.alias(QUERY.leftRegion, QUERY.rightRegion, {
    leftAccess: QUERY.leftAccess, rightAccess: QUERY.rightAccess,
  });
  assert.equal(alias.relation, 'may');
  assert.ok(alias.reasonCodes.includes('escape-unproven'));
});

test('#5215 the post-fallback alias answer matches a never-refined baseline solver', () => {
  const built = buildConsumerFixture();
  const rootKey = analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, { snapshotId: CONSUMER_SNAPSHOT })
    .pointsTo.get('slot').targets[0].rootKey;
  const options = { snapshotId: CONSUMER_SNAPSHOT, allocationRootKeys: [rootKey] };

  const refinedThenRejected = createPhase7AliasSolver({ ir: built.ir, cfg: built.cfg, ssa: built.ssa, options });
  refinedThenRejected.refineMemorySsa(built.memorySsa, consumerRefinement(built));
  refinedThenRejected.escapeRun();
  refinedThenRejected.refineMemorySsa(built.memorySsa, consumerRefinement(built, 'partial'));

  const baselineOnly = createPhase7AliasSolver({ ir: built.ir, cfg: built.cfg, ssa: built.ssa, options });

  const after = refinedThenRejected.alias(QUERY.leftRegion, QUERY.rightRegion, {
    leftAccess: QUERY.leftAccess, rightAccess: QUERY.rightAccess,
  });
  const control = baselineOnly.alias(QUERY.leftRegion, QUERY.rightRegion, {
    leftAccess: QUERY.leftAccess, rightAccess: QUERY.rightAccess,
  });
  assert.equal(after.relation, control.relation,
    'refine → reject must land exactly on the baseline-only answer');
  assert.deepEqual([...after.reasonCodes].sort(), [...control.reasonCodes].sort());
  assert.equal(after.reasonCodes.includes('distinct-non-escaping-allocation'), false);
});
