/** Deterministic, read-only planning. A cost estimate never grants authority,
 * executes a tool, discharges a proposition, or changes the existing job.
 */
import { stableDigest, lossyTypeWitness, deepFreeze } from '../../core/identity/index.js';
import { recordFields, snapshotContractData, exactString, exactInteger, stringSet, compareIdentity, contractFail } from '../../core/identity/structured.js';
const COST_KEYS = Object.freeze(['workUnits', 'bytesRead', 'residentBytes', 'toolCalls']);
const CAPS = Object.freeze({ workUnits: 10000000, bytesRead: 1073741824, residentBytes: 1073741824, toolCalls: 128 });
const digest = value => stableDigest({ value, typed: lossyTypeWitness(value) });
const percentile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]; };
function costs(value, prefix) {
  recordFields(value, COST_KEYS, `${prefix}-fields`);
  return Object.fromEntries(COST_KEYS.map(key => [key, exactInteger(value[key], `${prefix}-${key}`, { max: CAPS[key] })]));
}
export function normalizeInvestigationPlanningBudget(value = null) {
  return value == null ? null : deepFreeze(costs(snapshotContractData(value), 'investigation-planning-budget'));
}
/** Samples belong to the captured first-party inventory, never tool arguments.
 * Descriptive p75 costs rank inspection proposals; they are not hard bounds.
 */
export function calibrateInvestigationCosts(rows, samples, ownerRevision, work) {
  if (!Array.isArray(samples) || samples.length > 256) contractFail('investigation-cost-sample-cap');
  const byCapability = new Map(), known = new Map(rows.map(row => [row.id, row]));
  const ids = new Set();
  for (const sample of samples) {
    work.charge('workUnits');
    recordFields(sample, ['id', 'ownerRevision', 'requiredCapability', 'cost', 'elapsedMs', 'resolvedObligationIds'], 'investigation-cost-sample-fields');
    exactString(sample.id, 'investigation-cost-sample-id');
    if (ids.has(sample.id) || sample.ownerRevision !== ownerRevision) contractFail('investigation-cost-sample-binding');
    ids.add(sample.id); exactString(sample.requiredCapability, 'investigation-cost-sample-capability');
    if (!Number.isFinite(sample.elapsedMs) || sample.elapsedMs < 0 || sample.elapsedMs > 3600000) contractFail('investigation-cost-sample-duration');
    const observed = costs(sample.cost, 'investigation-observed-cost');
    const resolved = stringSet(sample.resolvedObligationIds, 'investigation-cost-sample-resolved', 256);
    // The historical sample may request an unknown/changed proposition. That
    // never counts as a current discharged obligation, even for calibration.
    const admitted = resolved.filter(id => known.get(id)?.discharge?.status === 'discharged');
    let bucket = byCapability.get(sample.requiredCapability);
    if (!bucket) byCapability.set(sample.requiredCapability, bucket = []);
    bucket.push({ cost: observed, elapsedMs: sample.elapsedMs, declaredResolved: resolved.length, currentlyAdmitted: admitted.length });
  }
  const models = [...byCapability].sort(([a], [b]) => compareIdentity(a, b)).map(([requiredCapability, bucket]) => ({
    requiredCapability, sampleCount: bucket.length,
    costEstimate: Object.fromEntries(COST_KEYS.map(key => [key, percentile(bucket.map(x => x.cost[key]), .75)])),
    elapsedMsP75: percentile(bucket.map(x => x.elapsedMs), .75),
    declaredResolutions: bucket.reduce((sum, x) => sum + x.declaredResolved, 0),
    currentlyAdmittedReferences: bucket.reduce((sum, x) => sum + x.currentlyAdmitted, 0),
    authority: 'descriptive-host-measurements; not-proof-or-guaranteed-cost' }));
  return deepFreeze({ schema: 'investigation-cost-calibration/v1', version: '1.0.0', ownerRevision,
    sampleCount: samples.length, models, probabilisticCorrectness: null, semanticAuthority: false });
}
/** The whole source inventory must match the fixed declared denominator. New,
 * missing, cyclic, contradicted or ownerless obligations block completion.
 */
export function checkInvestigationSuccessContract(raw, { rows, binding, goalDigest, ownerRevision, missing = [], hypotheses = [], work }) {
  const unknown = reasons => ({ bound: false, met: false, denominator: null, discharged: null,
    percent: null, inventoryDigest: null, reasons, authority: 'no-goal-completeness-proof' });
  if (raw == null) return unknown(['explicit-success-contract-unbound']);
  recordFields(raw, ['schema', 'id', 'worldId', 'assumptionsId', 'snapshotId', 'jobId', 'executionScopeId',
    'goalDigest', 'ownerRevision', 'requiredObligationIds', 'contradictionObligationIds'], 'investigation-success-contract-fields');
  if (raw.schema !== 'investigation-success-contract/v1') contractFail('investigation-success-contract-schema');
  exactString(raw.id, 'investigation-success-contract-id');
  for (const key of ['worldId', 'assumptionsId', 'snapshotId', 'jobId', 'executionScopeId']) {
    if (raw[key] !== binding[key]) contractFail('investigation-success-contract-binding');
  }
  if (raw.goalDigest !== goalDigest || raw.ownerRevision !== ownerRevision) contractFail('investigation-success-contract-binding');
  const required = stringSet(raw.requiredObligationIds, 'investigation-success-required', 256);
  if (!required.length || required.length !== raw.requiredObligationIds.length) contractFail('investigation-success-nonempty-unique-denominator');
  const contradictionIds = stringSet(raw.contradictionObligationIds ?? [], 'investigation-success-contradictions', 256);
  if (contradictionIds.some(id => !required.includes(id))) contractFail('investigation-success-untracked-contradiction');
  const byId = new Map(rows.map(row => [row.id, row])), reasons = [];
  if (required.some(id => !byId.has(id))) reasons.push('success-contract-missing-required-obligation');
  if (rows.some(row => !required.includes(row.id))) reasons.push('inventory-expanded-beyond-success-contract');
  let discharged = 0;
  for (const id of required) {
    work.charge('workUnits'); const row = byId.get(id);
    if (!row) continue;
    if (row.dependencyState?.missing?.length || row.dependencyState?.unresolved?.length || row.dependencyState?.cyclicOrDependent) {
      reasons.push('success-contract-dependency-not-closed'); continue;
    }
    if (row.discharge?.status === 'discharged') discharged++;
  }
  if (discharged !== required.length) reasons.push('success-contract-propositions-not-all-discharged');
  if (missing.length) reasons.push('success-contract-missing-owner-record');
  if (hypotheses.some(hypothesis => hypothesis.reviewSignals?.includes('declared-support-and-contradiction-coexist')
    && !contradictionIds.some(id => byId.get(id)?.hypothesisIds?.includes(hypothesis.id)
      && byId.get(id)?.discharge?.status === 'discharged'))) reasons.push('success-contract-untracked-agent-contradiction');
  return deepFreeze({ bound: true, id: raw.id, met: !reasons.length, denominator: required.length, discharged,
    percent: Math.round(discharged / required.length * 10000) / 100,
    inventoryDigest: digest({ required, ownerRevision, goalDigest }), reasons: [...new Set(reasons)],
    requiredObligationIds: required, authority: 'qualified-propositions-in-explicit-host-declared-contract-only',
    wholeBinaryCoverage: 'unknown', naturalLanguageGoalEquivalence: 'host-declared-not-machine-proved' });
}
export function prepareInvestigationPlanningRows(rows, { samples, ownerRevision, planningBudget, work }) {
  const calibration = calibrateInvestigationCosts(rows, samples, ownerRevision, work);
  const models = new Map(calibration.models.map(row => [row.requiredCapability, row]));
  const budget = normalizeInvestigationPlanningBudget(planningBudget), deferred = [];
  const planned = rows.map(row => {
    const model = models.get(row.requiredCapability);
    const costEstimate = model ? { ...model.costEstimate, toolCalls: Math.max(1, model.costEstimate.toolCalls) } : row.costEstimate;
    const dimensions = budget ? COST_KEYS.filter(key => costEstimate[key] > budget[key]) : [];
    const blocked = row.readiness === 'inspectable' && dimensions.length > 0;
    if (blocked) deferred.push({ id: row.id, obligationId: row.id, requiredCapability: row.requiredCapability,
      costEstimate, dimensions, reason: 'estimated-cost-exceeds-planning-budget', executable: false, automaticDispatch: false });
    return { ...row, costEstimate, readiness: blocked ? 'budget-deferred' : row.readiness };
  });
  return { rows: planned, calibration, deferred };
}
export function planInvestigationInspection(frontier, { rows, samples = [], ownerRevision = null, planningBudget = null, success, work,
  calibration: preparedCalibration = null, deferredCandidates = [] }) {
  const budget = normalizeInvestigationPlanningBudget(planningBudget);
  const calibration = preparedCalibration ?? calibrateInvestigationCosts(rows, samples, ownerRevision, work);
  const models = new Map(calibration.models.map(row => [row.requiredCapability, row]));
  const actions = [], deferred = [...deferredCandidates];
  for (const action of frontier.actions) {
    work.charge('workUnits');
    const model = models.get(action.requiredCapability);
    // Zero-tool-call samples do not turn a one-tool inspection into free work.
    const estimate = model ? { ...model.costEstimate, toolCalls: Math.max(1, model.costEstimate.toolCalls) } : action.costEstimate;
    const exhausted = budget ? COST_KEYS.filter(key => estimate[key] > budget[key]) : [];
    const row = { ...action, costEstimate: estimate, costModel: model ? 'host-observed-p75/v1' : 'declared-owner-estimate',
      sampleCount: model?.sampleCount ?? 0, executable: false, automaticDispatch: false };
    if (exhausted.length) deferred.push({ ...row, reason: 'estimated-cost-exceeds-planning-budget', dimensions: exhausted });
    else actions.push(row);
  }
  actions.sort((a, b) => b.reason.declaredImpact - a.reason.declaredImpact || b.reason.directReuse - a.reason.directReuse
    || a.costEstimate.toolCalls - b.costEstimate.toolCalls || a.costEstimate.workUnits - b.costEstimate.workUnits || compareIdentity(a.id, b.id));
  const kind = success.met ? 'success-contract-met' : !actions.length && deferred.length ? 'budget'
    : !frontier.actions.length ? 'unsupported-frontier' : 'not-stopped';
  return deepFreeze({ frontier: { ...frontier, actions, deferred, planningBudget: budget, hardExecutionBudgetEnforcedHere: false },
    calibration, stop: { kind, automaticExecution: 'disabled', reasons: success.met ? [] : success.reasons,
      explanation: kind === 'success-contract-met' ? 'all-explicit-required-propositions-qualified-in-declared-scope'
        : kind === 'budget' ? 'inspection-estimates-exceed-remaining-budget' : 'only-read-only-proposals-emitted' } });
}
