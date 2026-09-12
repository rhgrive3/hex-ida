/** Query-triggered refinement using the EXISTING Phase8 SCCP/range owner. */
import { createConditionalSccpInputs } from './context-inputs.js';
import { runSccpPass, SCCP_PASS } from './sccp.js';
import { canonicalAnalysisIdentity, analysisIdentityMatches } from './analysis-identity.js';
import { forkAnalysisState, commitAnalysisState, runPassTransaction } from './transaction.js';
import { refineFactByComparison, fullFact, factFromRange } from './range.js';
import { createEntityId, deepFreeze, stableStringify, stableDigest } from '../../core/identity/index.js';
import { assertWorldScope, assertAssumptionSet, worldContains } from '../../core/identity/world.js';
import { snapshotContractData, recordFields, exactString, exactInteger, exactEnum, signedIntegerText, contractFail } from '../../core/identity/structured.js';
import { assertScopedAnalysisWork, workStopStatus } from '../../core/budgets/scoped-work.js';

export const DEMAND_RANGE_SCHEMA = 'phase8-demand-range/v1';
const GOALS = ['constant', 'known-bits', 'interval', 'congruence', 'alignment', 'pointer-offset'];
const OPERATORS = ['eq', 'ne', 'ult', 'ule', 'ugt', 'uge', 'slt', 'sle', 'sgt', 'sge'];

export function normalizeDemandRangeRequest(value) {
  const data = snapshotContractData(value, { maxBytes: 262144 });
  recordFields(data, ['schema', 'valueIds', 'goals', 'mode', 'constraints', 'maximumFunctionValues'], 'demand-range-fields');
  if (data.schema !== undefined && data.schema !== DEMAND_RANGE_SCHEMA) contractFail('demand-range-schema');
  if (!Array.isArray(data.valueIds) || !data.valueIds.length || data.valueIds.length > 256) contractFail('demand-range-values');
  const valueIds = [...new Set(data.valueIds.map((id) => exactInteger(id, 'demand-range-value-id', { max: 2147483647 })))].sort((a, b) => a - b);
  if (!Array.isArray(data.goals ?? ['interval']) || (data.goals?.length ?? 1) > GOALS.length) contractFail('demand-range-goals');
  const goals = [...new Set((data.goals ?? ['interval']).map((goal) => exactEnum(goal, GOALS, 'demand-range-goal')))];
  const constraints = data.constraints ?? [];
  if (!Array.isArray(constraints) || constraints.length > 32) contractFail('demand-range-constraint-budget');
  const normalizedConstraints = constraints.map((constraint) => {
    recordFields(constraint, ['valueId', 'operator', 'constant', 'bits', 'truth', 'assumptionId'], 'demand-range-constraint-fields');
    const valueId = exactInteger(constraint.valueId, 'demand-range-constraint-id');
    if (!valueIds.includes(valueId)) contractFail('demand-range-constraint-not-requested');
    const bits = exactInteger(constraint.bits, 'demand-range-width', { min: 1, max: 64 });
    if (typeof constraint.truth !== 'boolean') contractFail('demand-range-truth');
    return { valueId, operator: exactEnum(constraint.operator, OPERATORS, 'demand-range-comparison'), bits,
      constant: signedIntegerText(constraint.constant, 'demand-range-constant'), truth: constraint.truth,
      assumptionId: exactString(constraint.assumptionId, 'demand-range-assumption') };
  });
  return deepFreeze({ schema: DEMAND_RANGE_SCHEMA, valueIds, goals,
    mode: exactEnum(data.mode ?? 'reuse-or-refresh', ['reuse-only', 'reuse-or-refresh', 'refresh'], 'demand-range-mode'),
    constraints: normalizedConstraints, maximumFunctionValues: exactInteger(data.maximumFunctionValues ?? 16384, 'demand-range-function-budget', { min: 1, max: 65536 }) });
}

/**
 * Context is the real Phase8 owner state, never an AI-provided AST or fact map.
 * A fork and the normal transaction keep all invalidation/rollback guarantees.
 * Initial refresh is bounded per FUNCTION; value-sparse SCCP scheduling is a
 * later owner optimization, not a second evaluator hidden in this query layer.
 */
export async function requestDemandRanges(context, request, { world, assumptions, work, publish = false, resolveConstraint = null, propagateInputs = false } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  const query = normalizeDemandRangeRequest(request);
  if (typeof propagateInputs !== 'boolean' || propagateInputs && (publish || !query.constraints.length)) contractFail('demand-input-conditions-query-only');
  if (typeof publish !== 'boolean') contractFail('demand-range-publication-mode');
  const identity = canonicalAnalysisIdentity(context);
  if (!identity.valid || !worldContains(world, identity.identity.binaryId)) {
    return deepFreeze({ status: 'unsupported', reason: 'phase8-canonical-world-binding-unavailable', values: [], cost: work.cost() });
  }
  const analysis = context.analysis;
  const ssa = analysis?.get?.('ssa');
  if (!Array.isArray(ssa?.values) || ssa.values.length > query.maximumFunctionValues) {
    return deepFreeze({ status: 'unsupported', reason: 'phase8-function-work-budget', values: [], cost: work.cost() });
  }
  for (const constraint of query.constraints) if (!assumptions.predicates.includes(constraint.assumptionId)) contractFail('demand-range-condition-not-in-assumptions');
  const before = analysis.snapshot();
  if (query.constraints.length && typeof resolveConstraint !== 'function') {
    return deepFreeze({ status: 'unsupported', reason: 'conditional-range-proposition-binder-required', values: [], cost: work.cost() });
  }
  for (const constraint of query.constraints) {
    const digest = stableDigest(constraint);
    const binding = await work.await((signal) => resolveConstraint(constraint, { world, assumptions, ownerIdentity: identity.identity, signal }));
    if (binding?.worldId !== world.id || binding.assumptionsId !== assumptions.id
      || binding.constraintDigest !== digest || binding.propositionBound !== true) contractFail('demand-range-proposition-unbound');
  }
  const sourceValues = new Map(ssa.values.map((value) => [value.id, value]));
  let artifact = analysis.get('ranges');
  let refreshed = false, transaction = null, working = null;
  const reusable = () => artifact?.provenance?.producer === SCCP_PASS.id && artifact.passVersion === SCCP_PASS.version
    && !artifact.conditionalInputsId && !propagateInputs && artifact.completeness === 'complete' && analysisIdentityMatches(artifact.identity, identity.identity);
  try {
    work.charge('workUnits');
    if (query.mode === 'refresh' || !reusable()) {
      if (query.mode === 'reuse-only') return deepFreeze({ status: 'unsupported', reason: 'range-artifact-not-current', values: [], cost: work.cost() });
      work.charge('nodes', ssa.values.length); work.charge('residentBytes', ssa.values.length * 640);
      working = forkAnalysisState(analysis);
      const maximumWorkItems = Math.min(50000, work.remaining('workUnits'));
      const shouldAbort = () => {
        try { work.checkpoint(); return false; } catch { return true; }
      };
      // Existing SCCP checks this callback in its bounded loop. It is not an
      // uninterruptible remote task and never acquires an independent budget.
      const refinedContext = { ...context, analysis: working, resolvedAnalysisIdentity: identity,
        ...(propagateInputs ? { scopedInputConditions: createConditionalSccpInputs(working, identity.identity, query.constraints, assumptions) } : {}),
        sccpLimits: { maxWorkItems: maximumWorkItems, maxVisitsPerValue: 6 } };
      transaction = runPassTransaction(working, { descriptor: SCCP_PASS, run: runSccpPass }, refinedContext, { shouldAbort });
      work.checkpoint();
      if (!transaction.committed) return deepFreeze({ status: 'unsupported', reason: transaction.stopReason, values: [], cost: work.cost() });
      artifact = working.get('ranges');
      work.charge('workUnits', artifact?.workItems ?? maximumWorkItems);
      refreshed = true;
    }
    const values = [];
    for (const localId of query.valueIds) {
      work.charge('workUnits');
      const source = sourceValues.get(localId);
      const fact = artifact.facts?.get?.(localId);
      if (!source || !fact) { values.push({ localId, status: 'unknown', reason: 'canonical-value-fact-unavailable' }); continue; }
      let refined = factFromRange(fact.range, fact);
      const conditionalOn = propagateInputs ? [...new Set(query.constraints.map(row => row.assumptionId))].sort() : [];
      for (const constraint of query.constraints.filter((item) => item.valueId === localId)) {
        if (constraint.bits !== refined.bits) { refined = fullFact(refined.bits, { status: 'unknown', reason: 'constraint-width-mismatch' }); break; }
        refined = refineFactByComparison(refined, constraint.operator, BigInt(constraint.constant), constraint.truth);
        if (!conditionalOn.includes(constraint.assumptionId)) conditionalOn.push(constraint.assumptionId);
      }
      const entityId = createEntityId({ binaryId: identity.identity.binaryId, kind: 'phase8-range-value-view', identity: {
        ownerIdentity: identity.identity, worldId: world.id, assumptionsId: assumptions.id, localId, publicationDigest: artifact.publicationDigest,
        constraints: query.constraints.filter((item) => item.valueId === localId), fact: refined } });
      values.push({ entityId, localId, owner: SCCP_PASS.id, fact: refined, conditionalOn,
        // A conditional fact never replaces the canonical function-wide map.
        authority: conditionalOn.length ? 'conditional-view' : 'canonical-owner-projection',
        completeness: artifact.completeness, provenance: artifact.provenance });
      await work.yieldIfNeeded();
    }
    work.checkpoint();
    const currentIdentity = canonicalAnalysisIdentity(context);
    if (!currentIdentity.valid || !analysisIdentityMatches(currentIdentity.identity, identity.identity)
      || stableStringify(before) !== stableStringify(analysis.snapshot())) {
      return deepFreeze({ status: 'stale', reason: 'range-inputs-changed', values: [], cost: work.cost() });
    }
    let published = false;
    if (publish && refreshed) {
      // Only the unconditioned SCCP artifact enters canonical state. Constraints
      // above live in the returned query projection and cannot leak into DCE.
      published = commitAnalysisState(analysis, working, before);
      if (!published) return deepFreeze({ status: 'stale', reason: 'range-commit-conflict', values: [], cost: work.cost() });
    }
    return deepFreeze({ schema: DEMAND_RANGE_SCHEMA, status: 'completed', worldId: world.id, assumptionsId: assumptions.id,
      ownerIdentity: identity.identity, publicationDigest: artifact.publicationDigest, refreshed, published,
      completeness: artifact.completeness, conditionalInputsId: artifact.conditionalInputsId ?? null, goals: query.goals, values, cost: work.cost() });
  } catch (error) {
    const status = workStopStatus(error, work.signal);
    if (!status) throw error;
    return deepFreeze({ schema: DEMAND_RANGE_SCHEMA, status, values: [], reason: 'range-refinement-stopped-without-publication', cost: work.cost() });
  }
}
