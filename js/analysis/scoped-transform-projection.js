/** Opt-in transport of actual Phase8 before/after expression views. Canonical
 * MachineEffects/SSA/MSSA remain the single owners; this runs the existing
 * presentation pass over the issued owner rather than lifting a second IR.
 */
import { decompileScopedCanonicalOwner } from './semantic-function.js';
import { createWorldScope, createAssumptionSet, worldContains } from '../core/identity/world.js';
import { deepFreeze, stableStringify } from '../core/identity/index.js';
import { snapshotContractData, recordFields, exactString, contractFail } from '../core/identity/structured.js';
import { ScopedAnalysisWork, assertScopedAnalysisWork } from '../core/budgets/scoped-work.js';
import { MEMORY_VIEW_FRAME_SCHEMA } from '../core/evidence/memory-transform-frame.js';
import { captureCanonicalMemoryTransforms } from './scoped-memory-transform-projection.js';

export const SCOPED_TRANSFORM_PROJECTION_VERSION = '1.0.0';
const copy = value => snapshotContractData(value, { allowBigInt: true, maxNodes: 65536, maxBytes: 4194304 });
function memoryFrame(pipeline, work) {
  const mssa = pipeline.memorySsa;
  // Copy the FULL records, not guessed offsets or a digest substituted for the
  // relation. AccessMetadata carries byte/bit geometry; the links and bindings
  // retain canonical aliases, versions and reaching definitions.
  const frame = { version: mssa?.buildVersion ?? null, functionId: pipeline.functionId,
    entities: [{ definitions: mssa?.definitions ?? null, uses: mssa?.uses ?? null, regions: mssa?.regions ?? null,
      reachingDefinitionLinks: mssa?.reachingDefinitionLinks ?? null, useDefLinks: mssa?.useDefLinks ?? null,
      defUseLinks: mssa?.defUseLinks ?? null, blockStates: mssa?.blockStates ?? null }],
    accesses: [{ metadata: mssa?.accessMetadata ?? null, bindings: mssa?.canonicalAccessBindings ?? null,
      byteCoverage: mssa?.byteCoverage ?? null }],
    effects: pipeline.machineEffects, control: pipeline.cfg?.blocks ?? [] };
  const result = copy(frame);
  work.charge('workUnits', pipeline.machineEffects.length + (mssa?.definitions?.length ?? 0) + (mssa?.uses?.length ?? 0) + 1);
  work.charge('residentBytes', stableStringify(result).length * 2); work.checkpoint();
  return result;
}

export async function projectScopedTransformOwners(owner, semanticResult, request, { signal = null, limits = {}, work: sharedWork = null } = {}) {
  const input = snapshotContractData(request, { maxBytes: 2 * 1024 * 1024, maxNodes: 32768 });
  recordFields(input, ['kind', 'world', 'assumptions', 'worldId', 'snapshotId', 'producerArtifactId'], 'scoped-transform-owner-fields');
  if (input.kind !== 'transforms') contractFail('scoped-transform-owner-kind');
  const world = createWorldScope(input.world), assumptions = createAssumptionSet(input.assumptions, world);
  exactString(input.snapshotId, 'scoped-transform-snapshot'); exactString(input.producerArtifactId, 'scoped-transform-artifact');
  if (input.worldId !== world.id) contractFail('scoped-transform-world');
  const work = sharedWork ? assertScopedAnalysisWork(sharedWork) : new ScopedAnalysisWork({ limits, signal, name: 'scoped-transform-worker' });
  try {
    work.checkpoint();
    const pipeline = owner?.pipeline, transported = semanticResult?.pipeline;
    const base = { schema: 'scoped-local-owner-projection/v1', version: SCOPED_TRANSFORM_PROJECTION_VERSION, kind: 'transforms',
      worldId: world.id, assumptionsId: assumptions.id, snapshotId: input.snapshotId,
      binaryId: pipeline?.binaryId ?? null, functionId: pipeline?.functionId ?? null,
      producerArtifactId: input.producerArtifactId, exact: false };
    const finish = value => { work.checkpoint(); return deepFreeze({ ...base, ...value, workerCost: work.cost() }); };
    if (!pipeline || !pipeline.legacyV1 || pipeline.instrumentation?.v2Executed !== true
      || owner.snapshotId !== input.snapshotId || pipeline.semanticIr !== transported?.semanticIr || pipeline.ssa !== transported?.ssa
      || !worldContains(world, pipeline.binaryId, pipeline.sliceId) || semanticResult.architectureId !== 'arm64'
      || semanticResult.abiId !== world.profile.abi || semanticResult.abiSemanticVersion !== world.profile.abiRevision) {
      return finish({ status: 'unsupported', reason: 'scoped-transform-canonical-owner-unbound' });
    }
    if (owner.decodedInstructions.length > 128 || pipeline.legacyV1.instructions.length > 1024
      || pipeline.semanticIr.nodes.length > 4096 || pipeline.ssa.definitions.length > 4096) {
      return finish({ status: 'unsupported', reason: 'scoped-transform-structural-budget' });
    }
    const before = memoryFrame(pipeline, work);
    let passStop = null;
    const decompiler = decompileScopedCanonicalOwner(owner, { phase8Optimize: true, scopedTransformEvidence: true,
      phase8WorkBudget: Math.min(50000, work.remaining('workUnits')),
      shouldAbort: () => { try { work.charge('workUnits'); return false; } catch (error) { passStop ??= error; return true; } } });
    if (passStop) throw passStop;
    work.checkpoint();
    const after = memoryFrame(pipeline, work);
    const unknowns = [];
    if (!pipeline.memorySsa || pipeline.memorySsa.completeness !== 'complete') unknowns.push('canonical-mssa-incomplete');
    if (pipeline.memorySsa?.unknowns?.length) unknowns.push('canonical-mssa-unknowns');
    if (pipeline.semanticIr?.unknowns?.length) unknowns.push('canonical-semantics-unknowns');
    // Any unresolved canonical event is a remaining premise, not an assertion
    // that an external call has an empty clobber set.
    if (pipeline.machineEffects.some(bundle => bundle.completeness && bundle.completeness !== 'complete')) unknowns.push('machine-effects-incomplete');
    const capture = decompiler.scopedTransforms ?? null;
    const frame = { schema: MEMORY_VIEW_FRAME_SCHEMA, worldId: world.id, snapshotId: input.snapshotId,
      functionId: pipeline.functionId, scope: 'phase8-expression-view-only', before, after, unknowns };
    const memoryTransforms = captureCanonicalMemoryTransforms(pipeline, decompiler, {
      worldId: world.id, snapshotId: input.snapshotId, concurrency: world.environment.concurrency, work });
    const body = copy({ capture, memoryFrame: frame, memoryTransforms,
      finalStatements: (decompiler.cAst?.body ?? []).slice(0, 128).map((node, index) => ({ index, kind: node.kind,
        text: node.text, source: node.source, statementKind: node.semantic?.op ?? node.kind,
        location: node.semantic?.location ?? null })),
      remaining: ['whole-function-equivalence-unproved', 'C-rendering-equivalence-unproved',
        ...(capture?.remaining ?? ['phase8-projection-not-published'])] });
    work.charge('residentBytes', stableStringify(body).length * 2);
    return finish({ status: 'completed', ...body, semanticIrVersion: pipeline.semanticIr.contractVersion,
      sourceBinding: 'existing-loader-bytes-and-decoded-word-reconciliation; no-ISA-proof' });
  } finally { if (!sharedWork) work.dispose(); }
}
