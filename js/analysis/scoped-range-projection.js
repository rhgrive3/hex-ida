/** Isolated read-only projection on the platform worker's canonical IR.
 * Existing SCCP owns all transfer functions/lattices. Nothing is published
 * into a decompiler context shared with a caller or another query.
 */
import { createWorldScope, createAssumptionSet, worldContains } from '../core/identity/world.js';
import { deepFreeze, stableStringify, lossyTypeWitness } from '../core/identity/index.js';
import { snapshotContractData, recordFields, exactEnum, exactInteger, exactString, contractFail } from '../core/identity/structured.js';
import { AnalysisWorkStopped, ScopedAnalysisWork } from '../core/budgets/scoped-work.js';
import { seedAnalysisState } from '../decompiler/phase8/transaction.js';
import { canonicalAnalysisIdentity } from '../decompiler/phase8/analysis-identity.js';
import { requestDemandRanges } from '../decompiler/phase8/demand-range.js';

export const SCOPED_RANGE_PROJECTION_VERSION = '1.2.0';
export async function projectScopedRangeOwner(owner, semanticResult, request, { signal = null, limits = {} } = {}) {
  const input = snapshotContractData(request, { maxBytes: 2 * 1024 * 1024, maxNodes: 32768 });
  recordFields(input, ['kind', 'snapshotId', 'worldId', 'world', 'assumptions', 'request', 'offset', 'limit', 'ownerIdentity'], 'scoped-range-owner-fields');
  const kind = exactEnum(input.kind, ['ranges', 'range-values'], 'scoped-range-owner-kind');
  const world = createWorldScope(input.world), assumptions = createAssumptionSet(input.assumptions, world);
  exactString(input.snapshotId, 'scoped-range-owner-snapshot');
  if (world.id !== input.worldId) contractFail('scoped-range-owner-world');
  if (kind === 'ranges' && (input.offset !== undefined || input.limit !== undefined)) contractFail('scoped-range-unexpected-pagination');
  if (kind === 'range-values' && (input.request !== undefined || input.ownerIdentity !== undefined)) contractFail('scoped-range-unexpected-request');
  const work = new ScopedAnalysisWork({ limits, signal, name: 'scoped-range-worker' });
  try {
    work.checkpoint();
    const pipeline = owner?.pipeline, transported = semanticResult?.pipeline;
    const base = { schema: 'scoped-local-owner-projection/v1', version: SCOPED_RANGE_PROJECTION_VERSION,
      kind, worldId: world.id, assumptionsId: assumptions.id, snapshotId: input.snapshotId,
      binaryId: pipeline?.binaryId ?? null, functionId: pipeline?.functionId ?? null,
      exact: false, authority: 'existing-phase8-owner; isolated-read-only; not-independently-verified' };
    const finish = (value) => { work.checkpoint(); return deepFreeze({ ...base, ...value, workerCost: work.cost() }); };
    if (!pipeline || pipeline.instrumentation?.v2Executed !== true || !pipeline.legacyV1
      || owner.snapshotId !== input.snapshotId || pipeline.functionId !== transported?.functionId
      || pipeline.binaryId !== transported?.binaryId || !worldContains(world, pipeline.binaryId, pipeline.sliceId)
      || semanticResult.abiId !== world.profile.abi || semanticResult.abiSemanticVersion !== world.profile.abiRevision) {
      return finish({ status: 'unsupported', reason: 'scoped-range-canonical-owner-unbound' });
    }
    const upstream = pipeline.legacyV1;
    if (!Array.isArray(upstream.values) || upstream.values.length > 16384
      || !Array.isArray(upstream.instructions) || upstream.instructions.length > 8192) {
      return finish({ status: 'unsupported', reason: 'scoped-range-structural-budget' });
    }
    // Identity metadata only; actual arrays and def-use links stay canonical.
    const ir = { ...upstream, binaryId: pipeline.binaryId, functionId: pipeline.functionId, snapshotId: input.snapshotId };
    const context = { ir, analysis: seedAnalysisState(ir), abi: owner.abiAdapter };
    const identity = canonicalAnalysisIdentity(context);
    if (!identity.valid || identity.identity.snapshotId !== input.snapshotId || identity.identity.binaryId !== pipeline.binaryId) {
      return finish({ status: 'unsupported', reason: 'scoped-range-canonical-identity-unavailable' });
    }
    if (kind === 'range-values') {
      const offset = exactInteger(input.offset ?? 0, 'scoped-range-catalog-offset', { max: 16384 });
      const limit = exactInteger(input.limit ?? 64, 'scoped-range-catalog-limit', { min: 1, max: 256 });
      const values = [], end = Math.min(upstream.values.length, offset + limit);
      for (let index = offset; index < end; index++) {
        work.charge('workUnits'); work.charge('results');
        const value = upstream.values[index];
        exactInteger(value.id, 'scoped-range-local-value-id', { max: 2147483647 });
        values.push({ localId: value.id, semanticValueId: value.semanticValueId ?? null,
          semanticSsaValueId: value.semanticSsaValueId ?? null, kind: value.kind ?? null,
          bits: value.bits ?? null, physicalRegister: value.reg ?? null,
          semanticNodeId: value.def?.extra?.semanticNodeId ?? null });
        await work.yieldIfNeeded();
      }
      return finish({ status: 'completed', catalog: { schema: 'scoped-range-values/v1', offset, limit,
        total: upstream.values.length, nextOffset: end < upstream.values.length ? end : null,
        ownerIdentity: identity.identity, values, authority: 'value-identity-navigation-only' } });
    }
    // Local integer IDs cannot be reused against another canonical owner.
    // Full identity and original types, never just a caller-chosen digest.
    if (!input.ownerIdentity || stableStringify(input.ownerIdentity) !== stableStringify(identity.identity)
      || stableStringify(lossyTypeWitness(input.ownerIdentity)) !== stableStringify(lossyTypeWitness(identity.identity))) {
      return finish({ status: 'stale', reason: 'range-value-catalog-owner-changed', ranges: {
        status: 'stale', reason: 'range-value-catalog-owner-changed', values: [], exact: false,
      } });
    }
    const ranges = await requestDemandRanges(context, input.request, { world, assumptions, work, publish: false });
    work.checkpoint();
    return finish({ status: ranges.status, reason: ranges.reason ?? null, ranges });
  } catch (error) {
    // Timer-triggered stops may not yet carry counters. Capture before dispose
    // so the existing worker protocol can preserve the typed stop and debit.
    if (error instanceof AnalysisWorkStopped && !error.cost) error.cost = work.cost();
    throw error;
  } finally { work.dispose(); }
}
