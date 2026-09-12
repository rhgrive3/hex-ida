/**
 * Read-only, evidence-linked investigation inventory and deterministic frontier.
 * The existing job/hypothesis/evidence stores own agent state. Canonical owners
 * alone discharge formal obligations. This module neither interprets goal text
 * into actions nor executes tools, probes, solver jobs or offensive workflows.
 */
import { checkInvestigationSuccessContract, planInvestigationInspection, normalizeInvestigationPlanningBudget, prepareInvestigationPlanningRows } from './scoped-policy.js';
import { EvidenceStore } from '../evidence.js';
import { HypothesisStore } from '../hypothesis.js';
import { assertQualifiedJudgment } from '../../core/evidence/scoped.js';
import { assertWorldScope, assertAssumptionSet } from '../../core/identity/world.js';
import { createEntityId, deepFreeze, stableDigest, stableStringify, lossyTypeWitness } from '../../core/identity/index.js';
import { assertScopedAnalysisWork } from '../../core/budgets/scoped-work.js';
import { snapshotContractData, recordFields, exactString, exactInteger, exactEnum, stringSet, compareIdentity, contractFail } from '../../core/identity/structured.js';

export const INVESTIGATION_FRONTIER_SCHEMA = 'scoped-investigation-frontier/v1';
export const INVESTIGATION_FRONTIER_VERSION = '1.1.0';
const MAX_OBLIGATIONS = 256, MAX_LINKS = 8192, MAX_EVIDENCE = 1024;
const VIEWS = new WeakSet();
const CAPABILITIES = Object.freeze(['inspect-canonical-evidence', 'inspect-byte-binding', 'inspect-world-closure',
  'inspect-call-targets', 'inspect-memory-object', 'inspect-physical-types', 'inspect-abi-placement',
  'inspect-transform-receipts', 'inspect-captured-runtime-events', 'inspect-recognition-collisions', 'owner-unavailable']);
const digest = (value) => stableDigest({ value, typed: lossyTypeWitness(value) });
const sameData = (a, b) => stableStringify(a) === stableStringify(b)
  && stableStringify(lossyTypeWitness(a)) === stableStringify(lossyTypeWitness(b));
const LIMITS = Object.freeze({ maxBytes: 1048576, maxNodes: 32768, maxStringLength: 8192 });

function obligationRecord(raw, boundHypotheses) {
  recordFields(raw, ['id', 'propositionId', 'producerArtifactId', 'ownerRevision', 'hypothesisIds', 'dependencies',
    'evidenceIds', 'requiredCapability', 'declaredImpact', 'costEstimate'], 'investigation-obligation-fields');
  const hypothesisIds = stringSet(raw.hypothesisIds, 'investigation-obligation-hypotheses', 128);
  if (hypothesisIds.some((id) => !boundHypotheses.has(id))) contractFail('investigation-obligation-foreign-hypothesis');
  recordFields(raw.costEstimate, ['workUnits', 'bytesRead', 'residentBytes', 'toolCalls'], 'investigation-cost-fields');
  const costEstimate = Object.fromEntries(Object.entries({ workUnits: 10000000, bytesRead: 1073741824,
    residentBytes: 1073741824, toolCalls: 128 }).map(([key, max]) => [key,
    exactInteger(raw.costEstimate[key], `investigation-cost-${key}`, { min: key === 'toolCalls' ? 1 : 0, max })]));
  return deepFreeze({ id: exactString(raw.id, 'investigation-obligation-id'),
    propositionId: exactString(raw.propositionId, 'investigation-obligation-proposition'),
    producerArtifactId: exactString(raw.producerArtifactId, 'investigation-obligation-producer'),
    ownerRevision: exactString(raw.ownerRevision, 'investigation-obligation-revision'),
    hypothesisIds, dependencies: stringSet(raw.dependencies, 'investigation-obligation-dependencies', MAX_OBLIGATIONS),
    evidenceIds: stringSet(raw.evidenceIds, 'investigation-obligation-evidence', 64),
    requiredCapability: exactEnum(raw.requiredCapability, CAPABILITIES, 'investigation-obligation-capability'),
    declaredImpact: exactInteger(raw.declaredImpact, 'investigation-declared-impact', { min: 1, max: 5 }),
    costEstimate, authority: 'owner-reference; estimates-are-not-proof-or-calibrated-probability' });
}

/** Proposition binding expected from an independently admitted owner judgment. */
export function investigationDischargeProposition(obligation) {
  return deepFreeze({ schema: 'investigation-obligation-discharge/v1', obligationId: obligation.id,
    propositionId: obligation.propositionId, producerArtifactId: obligation.producerArtifactId,
    ownerRevision: obligation.ownerRevision, discharged: true });
}

function evidenceHeader(record) {
  // Do not copy sourceData or dereference persisted observation payloads here.
  // A header count/status is NOT semantic support for the hypothesis text.
  return snapshotContractData({ id: record.id, kind: record.kind, title: record.title,
    recordedStatus: record.status, sourceTool: record.sourceTool, sourceBinding: record.sourceBinding ?? null,
    sourceRef: record.sourceRef ?? null, functionAddress: record.functionAddress ?? null,
    timestamp: record.timestamp ?? null, currentWorldQualification: 'not-established' }, LIMITS);
}

async function dependencyFrontier(obligations, judgments, work) {
  const rows = new Map(obligations.map((row) => [row.id, row]));
  const incoming = new Map(), outgoing = new Map(), indegree = new Map();
  let links = 0;
  for (const row of obligations) {
    work.charge('workUnits'); indegree.set(row.id, 0);
    incoming.set(row.id, []); outgoing.set(row.id, []);
  }
  for (const row of obligations) for (const dependency of row.dependencies) {
    if (++links > MAX_LINKS) contractFail('investigation-dependency-budget');
    work.charge('edges'); work.charge('workUnits');
    incoming.get(row.id).push(dependency);
    if (rows.has(dependency)) {
      outgoing.get(dependency).push(row.id); indegree.set(row.id, indegree.get(row.id) + 1);
    }
    await work.yieldIfNeeded();
  }
  const queue = [...indegree.keys()].filter((id) => indegree.get(id) === 0).sort(compareIdentity);
  const visited = new Set();
  for (let i = 0; i < queue.length; i++) {
    work.charge('queueOperations'); work.charge('workUnits');
    const id = queue[i]; visited.add(id);
    for (const next of outgoing.get(id)) {
      indegree.set(next, indegree.get(next) - 1); if (!indegree.get(next)) queue.push(next);
    }
    await work.yieldIfNeeded();
  }
  return obligations.map((row) => {
    const missing = incoming.get(row.id).filter((id) => !rows.has(id));
    const unresolved = incoming.get(row.id).filter((id) => rows.has(id) && judgments.get(id)?.status !== 'discharged');
    const cyclicOrDependent = !visited.has(row.id);
    const discharged = judgments.get(row.id)?.status === 'discharged';
    return { ...row, discharge: judgments.get(row.id), dependencyState: {
      missing, unresolved, cyclicOrDependent,
      reason: cyclicOrDependent ? 'dependency-cycle-or-dependent-on-cycle' : missing.length ? 'dependency-owner-missing' : unresolved.length ? 'premises-open' : null },
    readiness: discharged ? 'discharged' : cyclicOrDependent || missing.length || unresolved.length ? 'blocked'
      : row.requiredCapability === 'owner-unavailable' ? 'unsupported' : 'inspectable',
    // Only direct reuse is counted. No inflated transitive/probability estimate.
    directReuse: outgoing.get(row.id).length + row.hypothesisIds.length };
  });
}

function dominates(left, right) {
  const benefit = left.declaredImpact >= right.declaredImpact && left.directReuse >= right.directReuse;
  const cheaper = ['workUnits', 'bytesRead', 'residentBytes', 'toolCalls'].every((key) => left.costEstimate[key] <= right.costEstimate[key]);
  const strict = left.declaredImpact > right.declaredImpact || left.directReuse > right.directReuse
    || ['workUnits', 'bytesRead', 'residentBytes', 'toolCalls'].some((key) => left.costEstimate[key] < right.costEstimate[key]);
  return benefit && cheaper && strict;
}

async function actionFrontier(rows, maximum, work) {
  const candidates = rows.filter((row) => row.readiness === 'inspectable'), pareto = [];
  for (const candidate of candidates) {
    let dominated = false;
    for (const other of candidates) {
      work.charge('workUnits');
      if (other.id !== candidate.id && dominates(other, candidate)) { dominated = true; break; }
      await work.yieldIfNeeded();
    }
    if (!dominated) pareto.push(candidate);
  }
  pareto.sort((a, b) => b.directReuse - a.directReuse || b.declaredImpact - a.declaredImpact
    || a.costEstimate.toolCalls - b.costEstimate.toolCalls || a.costEstimate.bytesRead - b.costEstimate.bytesRead
    || a.costEstimate.residentBytes - b.costEstimate.residentBytes || a.costEstimate.workUnits - b.costEstimate.workUnits
    || compareIdentity(a.id, b.id));
  return { actions: pareto.slice(0, maximum).map((row) => ({ id: row.id, kind: 'inspect-canonical-obligation',
    obligationId: row.id, propositionId: row.propositionId, requiredCapability: row.requiredCapability,
    evidenceIds: row.evidenceIds, hypothesisIds: row.hypothesisIds, costEstimate: row.costEstimate,
    reason: { paretoNonDominated: true, directReuse: row.directReuse, declaredImpact: row.declaredImpact },
    executable: false, automaticDispatch: false })),
  candidateCount: candidates.length, paretoCount: pareto.length, omitted: Math.max(0, pareto.length - maximum),
  policy: 'Pareto impact/reuse versus all supplied costs; deterministic lexicographic presentation, not a probability model' };
}

/** Bound input comes from the existing owner adapter; no model verdict writes. */
export async function describeInvestigationFrontier(request, { world, assumptions, snapshotId, work,
  getContext = null, resolveDischarge = null } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  recordFields(request, ['jobId', 'hypothesisIds', 'maximumActions', 'includeClaims', 'previousViewId', 'planningBudget'], 'investigation-query-fields');
  const planningBudget = normalizeInvestigationPlanningBudget(request.planningBudget);
  const jobId = exactString(request.jobId, 'investigation-query-job');
  const maximumActions = exactInteger(request.maximumActions ?? 16, 'investigation-action-cap', { min: 1, max: 64 });
  if (request.includeClaims !== undefined && typeof request.includeClaims !== 'boolean') contractFail('investigation-include-claims');
  if (request.previousViewId !== undefined) exactString(request.previousViewId, 'investigation-prior-view');
  if (!getContext) return { status: 'unsupported', reason: 'existing-investigation-owner-unbound', exact: false };
  const context = await work.await((signal) => getContext(jobId, { world, assumptions, snapshotId, work, signal }));
  if (!context) return { status: 'unsupported', reason: 'idle-loaded-investigation-unavailable', exact: false };
  if (typeof context.isCurrent !== 'function' || context.isCurrent() !== true
    || !(context.hypothesisStore instanceof HypothesisStore) || !(context.evidenceStore instanceof EvidenceStore)
    || context.hypothesisStore.evidenceStore !== context.evidenceStore) contractFail('investigation-native-owner-binding');
  const binding = snapshotContractData(context.binding, LIMITS), job = snapshotContractData(context.job, LIMITS);
  recordFields(binding, ['schema', 'worldId', 'assumptionsId', 'snapshotId', 'binaryId', 'jobId', 'sessionId',
    'executionScopeId', 'jobDigest', 'version'], 'investigation-binding-fields');
  if (binding.schema !== 'scoped-job-inspection-binding/v1' || binding.worldId !== world.id
    || binding.assumptionsId !== assumptions.id || binding.snapshotId !== snapshotId || binding.jobId !== jobId
    || job.id !== jobId || binding.sessionId !== job.sessionId || binding.executionScopeId !== job.executionScopeId
    || binding.jobDigest !== digest(job) || !world.binarySet.some((member) => member.binaryId === binding.binaryId)) contractFail('investigation-world-or-job-mismatch');
  const allHypotheses = stringSet(job.hypothesisIds, 'investigation-job-hypotheses', 128);
  const requested = request.hypothesisIds === undefined ? allHypotheses : stringSet(request.hypothesisIds, 'investigation-query-hypotheses', 128);
  if (requested.some((id) => !allHypotheses.includes(id))) contractFail('investigation-hypothesis-outside-job');
  const capturedHypotheses = new Map(), capturedEvidence = new Map(), hypotheses = [], evidence = [], missing = [];
  const evidenceIds = new Set();
  const check = (final = false) => {
    work.checkpoint();
    // Frozen owner rows can be read without repeatedly rescanning all earlier
    // rows. A single full pre-publication pass catches replacement/removal.
    if (!final) return;
    if (context.isCurrent() !== true || context.obligationOwner && context.obligationOwner.isCurrent() !== true) contractFail('investigation-owner-stale');
    for (const [id, record] of capturedHypotheses) if (context.hypothesisStore.get(id) !== record) contractFail('investigation-hypothesis-stale');
    for (const [id, record] of capturedEvidence) if (context.evidenceStore.get(id) !== record) contractFail('investigation-evidence-stale');
  };
  for (const id of requested) {
    work.charge('nodes'); work.charge('workUnits');
    const record = context.hypothesisStore.get(id);
    capturedHypotheses.set(id, record);
    if (!record) { missing.push({ id, kind: 'hypothesis-owner-record-missing' }); continue; }
    const raw = snapshotContractData(record, { ...LIMITS, maxBytes: 65536, maxNodes: 4096 });
    const support = stringSet(raw.supportEvidenceIds, 'investigation-support-ids', 256);
    const contradiction = stringSet(raw.contradictionEvidenceIds, 'investigation-contradiction-ids', 256);
    for (const ref of [...support, ...contradiction]) {
      if (evidenceIds.size >= MAX_EVIDENCE && !evidenceIds.has(ref)) contractFail('investigation-evidence-budget');
      evidenceIds.add(ref);
    }
    hypotheses.push({ id, recordDigest: digest(raw), recordedStatus: raw.status,
      ...(request.includeClaims ? { claim: raw.claim } : {}), claimDigest: digest(raw.claim),
      supportEvidenceIds: support, contradictionEvidenceIds: contradiction,
      declaredMissingEvidence: raw.missingEvidence, semanticVerdict: 'not-established',
      reviewSignals: support.length && contradiction.length ? ['declared-support-and-contradiction-coexist'] : [],
      authority: 'existing-agent-state-not-canonical-truth' });
    await work.yieldIfNeeded(); check();
  }
  for (const id of [...evidenceIds].sort(compareIdentity)) {
    work.charge('nodes'); work.charge('workUnits');
    const record = context.evidenceStore.get(id); capturedEvidence.set(id, record);
    if (!record) { missing.push({ id, kind: 'evidence-owner-record-missing' }); continue; }
    evidence.push(evidenceHeader(record)); await work.yieldIfNeeded(); check();
  }
  const owner = context.obligationOwner;
  let obligations = [], inventoryBinding = null, successContract = null, costSamples = [];
  if (owner) {
    if (typeof owner.isCurrent !== 'function' || owner.isCurrent() !== true) contractFail('investigation-inventory-current-owner');
    const data = snapshotContractData(owner.data, { maxBytes: 2097152, maxNodes: 65536 });
    recordFields(data, ['schema', 'worldId', 'assumptionsId', 'snapshotId', 'jobId', 'executionScopeId', 'ownerRevision', 'obligations', 'successContract', 'costSamples'], 'investigation-inventory-fields');
    if (data.schema !== 'canonical-investigation-obligations/v1' || data.worldId !== world.id || data.assumptionsId !== assumptions.id
      || data.snapshotId !== snapshotId || data.jobId !== jobId || data.executionScopeId !== binding.executionScopeId
      || !Array.isArray(data.obligations) || data.obligations.length > MAX_OBLIGATIONS) contractFail('investigation-inventory-binding');
    exactString(data.ownerRevision, 'investigation-inventory-revision');
    obligations = data.obligations.map((raw) => obligationRecord(raw, new Set(allHypotheses)));
    if (new Set(obligations.map((row) => row.id)).size !== obligations.length) contractFail('investigation-duplicate-obligation');
    inventoryBinding = { ownerRevision: data.ownerRevision, digest: digest(data) };
    successContract = data.successContract ?? null; costSamples = data.costSamples ?? [];
  }
  const judgments = new Map();
  for (const obligation of obligations) {
    work.charge('nodes'); work.charge('workUnits');
    let discharge = { status: 'open', reason: 'owner-proof-not-admitted', judgmentId: null };
    if (resolveDischarge) {
      const claim = await work.await((signal) => resolveDischarge(obligation, { world, assumptions, snapshotId, binding, work, signal })); check();
      if (claim) {
        assertQualifiedJudgment(claim);
        const correct = claim.world === world.id && claim.assumptions === assumptions.id && claim.subject === obligation.id
          && claim.precision === 'exact' && claim.quantifier === 'all-admitted-executions'
          && claim.executionStatus === 'completed' && claim.obligations.length === 0
          && sameData(claim.value, investigationDischargeProposition(obligation));
        discharge = correct ? { status: 'discharged', judgmentId: claim.id, reason: null }
          : { status: 'open', judgmentId: null, reason: 'obligation-judgment-does-not-prove-this-scoped-proposition' };
      }
    }
    judgments.set(obligation.id, deepFreeze(discharge)); await work.yieldIfNeeded(); check();
  }
  const rows = await dependencyFrontier(obligations, judgments, work); check();
  const relevant = rows.filter((row) => row.hypothesisIds.length === 0 || row.hypothesisIds.some((id) => requested.includes(id)));
  const planned = prepareInvestigationPlanningRows(relevant, { samples: costSamples,
    ownerRevision: inventoryBinding?.ownerRevision ?? null, planningBudget, work });
  const frontier = await actionFrontier(planned.rows, maximumActions, work); check();
  const discharged = rows.filter((row) => row.discharge.status === 'discharged').length;
  const success = checkInvestigationSuccessContract(successContract, { rows, binding, goalDigest: digest(job.goal),
    ownerRevision: inventoryBinding?.ownerRevision ?? null, missing, hypotheses, work });
  const policy = planInvestigationInspection(frontier, { rows, samples: costSamples,
    ownerRevision: inventoryBinding?.ownerRevision ?? null, planningBudget, success, work,
    calibration: planned.calibration, deferredCandidates: planned.deferred });
  const goalSummary = { id: job.id, sessionId: job.sessionId, goalDigest: digest(job.goal),
    ...(request.includeClaims ? { goal: job.goal } : {}), recordedJobStatus: job.status,
    usage: job.budgetUsage, limits: job.limits, declaredUnresolvedWork: job.unresolvedWork,
    goalCompleted: success.met, goalSemanticVerdict: success.met ? 'explicit-host-contract-met-in-declared-scope' : 'unknown', automatedActionsStarted: 0 };
  const remaining = ['agent-state-is-not-semantic-authority', 'goal-to-formal-obligation-completeness-not-proved',
    'evidence-presence-is-not-hypothesis-proof', ...(owner ? [] : ['canonical-obligation-inventory-unbound'])];
  if (rows.some((row) => row.dependencyState.cyclicOrDependent)) remaining.push('obligation-dependency-cycle-or-dependent-cut');
  if (missing.length) remaining.push('missing-existing-owner-records');
  check(true);
  const body = snapshotContractData({ schema: INVESTIGATION_FRONTIER_SCHEMA, version: INVESTIGATION_FRONTIER_VERSION,
    status: 'completed', binding, scope: { hypothesisIds: requested, includeClaims: request.includeClaims === true, maximumActions, planningBudget },
    inventoryBinding, goal: goalSummary, hypotheses, evidence, obligations: rows, frontier: policy.frontier, costCalibration: policy.calibration,
    coverage: { kind: 'declared-inventory-only', declaredHypotheses: requested.length, availableHypotheses: hypotheses.length,
      referencedEvidence: evidenceIds.size, availableEvidenceHeaders: evidence.length,
      declaredObligations: rows.length, proofAdmittedObligations: discharged,
      wholeGoalPercentage: null, wholeBinaryCoverage: 'unknown', goalClosure: success.met ? 'explicit-contract-only' : 'unproven', fixedContract: success },
    missing, remaining, stop: { ...policy.stop, reason: success.met ? 'explicit-required-propositions-qualified; natural-language-mapping-host-declared'
      : policy.stop.kind === 'budget' ? 'inspection-estimates-exceed-remaining-budget' : !owner ? 'formal-owner-inventory-required'
      : rows.length > 0 && rows.length === discharged ? 'declared-obligations-discharged-goal-closure-unproven'
        : policy.frontier.actions.length ? 'read-only-inspection-frontier-available' : 'owner-input-or-human-decomposition-required' },
    exact: false, canonicalTruthChanged: false, jobStateChanged: false }, { maxBytes: 4194304, maxNodes: 131072, maxStringLength: 8192 });
  work.charge('residentBytes', stableStringify(body).length * 2); check(true);
  const id = createEntityId({ binaryId: binding.binaryId, kind: INVESTIGATION_FRONTIER_SCHEMA, identity: { digest: digest(body) } });
  const view = deepFreeze({ ...body, id, cost: work.cost() });
  VIEWS.add(view); return view;
}

/**
 * One previous FINGERPRINT MANIFEST per job, never claims/proofs. A caller's
 * supplied previous ID cannot install a baseline. Missing/evicted/foreign IDs
 * cause a full replacement. This only compresses display/context transport.
 */
export class InvestigationViewCache {
  #entries = new Map(); #maximumJobs;
  constructor({ maximumJobs = 2 } = {}) { this.#maximumJobs = exactInteger(maximumJobs, 'investigation-view-cache-cap', { min: 1, max: 4 }); }
  project(view, previousViewId = null, { work } = {}) {
    assertScopedAnalysisWork(work);
    if (!VIEWS.has(view) || view?.schema !== INVESTIGATION_FRONTIER_SCHEMA || !view.id || view.exact !== false) contractFail('investigation-view-cache-input');
    const key = stableStringify({ world: view.binding.worldId, assumptions: view.binding.assumptionsId,
      snapshot: view.binding.snapshotId, job: view.binding.jobId, session: view.binding.sessionId,
      executionScope: view.binding.executionScopeId, selection: view.scope });
    const prior = this.#entries.get(view.binding.jobId);
    const baseline = prior?.key === key && prior.id === previousViewId ? prior : null;
    const groups = { hypotheses: view.hypotheses, evidence: view.evidence, obligations: view.obligations, actions: view.frontier.actions };
    const manifest = new Map(), changed = {}, removed = {};
    let total = 0;
    for (const [name, rows] of Object.entries(groups)) {
      if (!Array.isArray(rows) || rows.length > 2048 || (total += rows.length) > 4096) contractFail('investigation-view-cache-record-budget');
      changed[name] = []; removed[name] = [];
      const currentIds = new Set();
      for (const row of rows) {
        work.charge('workUnits');
        const id = exactString(row.id, 'investigation-view-record-id'), recordKey = `${name}\u0000${id}`;
        if (currentIds.has(id)) contractFail('investigation-view-duplicate-record');
        currentIds.add(id); const hash = digest(row); manifest.set(recordKey, hash);
        if (!baseline || baseline.manifest.get(recordKey) !== hash) changed[name].push(row);
      }
      if (baseline) for (const recordKey of baseline.manifest.keys()) {
        if (recordKey.startsWith(`${name}\u0000`) && !manifest.has(recordKey)) removed[name].push(recordKey.slice(name.length + 1));
      }
    }
    const manifestBytes = [...manifest].reduce((sum, [id, hash]) => sum + (id.length + hash.length) * 2 + 64, 0);
    if (manifestBytes > 1048576) contractFail('investigation-view-manifest-budget');
    work.charge('residentBytes', manifestBytes); work.checkpoint();
    this.#entries.delete(view.binding.jobId);
    this.#entries.set(view.binding.jobId, { key, id: view.id, manifest, contract: view.coverage.fixedContract?.inventoryDigest ?? null });
    while (this.#entries.size > this.#maximumJobs) this.#entries.delete(this.#entries.keys().next().value);
    const { hypotheses: _h, evidence: _e, obligations: _o, frontier: _f, ...header } = view;
    const { actions: _actions, ...frontierHeader } = view.frontier;
    return deepFreeze({ ...header, transfer: { mode: baseline ? 'delta' : 'full', baseViewId: baseline?.id ?? null,
      fixedDenominatorChanged: !!baseline && baseline.contract !== (view.coverage.fixedContract?.inventoryDigest ?? null),
      requestedBaseUnavailable: previousViewId !== null && !baseline, unchangedRecords: total - Object.values(changed).reduce((n, values) => n + values.length, 0),
      use: 'transport-only; cached fingerprints never discharge obligations' },
    records: changed, removed, frontier: frontierHeader, manifest: [...manifest].map(([key, hash]) => {
      const split = key.indexOf('\u0000');
      return { group: key.slice(0, split), id: key.slice(split + 1), digest: hash };
    }) });
  }
  clear() { this.#entries.clear(); }
}

/** Frontier of a service-loaded current FlowAnswer. Uses the same dependency
 * and Pareto inspection policy as existing jobs, without creating fake jobs or
 * turning model anchors into authoritative obligations. No actions execute.
 */
export async function describeDemandInvestigation(bundle, { artifactId, maximumActions = 16,
  world, assumptions, work, isCurrent } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  exactString(artifactId, 'demand-investigation-artifact');
  exactInteger(maximumActions, 'demand-investigation-action-limit', { min: 1, max: 64 });
  if (bundle?.schema !== 'scpa-flow-answer-publication/v1' || bundle.worldId !== world.id
    || bundle.assumptionsId !== assumptions.id || isCurrent?.() !== true) contractFail('demand-investigation-source-binding');
  const answer = bundle.answer, captured = [], seen = new Set();
  const reasons = [...answer.judgment.obligations.map(reason => ({ reason })),
    ...(answer.investigation?.obligations ?? []).map(reason => ({ reason, source: 'template-hypothesis' })), ...answer.frontier.entries];
  for (const entry of reasons) {
    work.charge('workUnits');
    const key = stableStringify(entry);
    if (seen.has(key)) continue; seen.add(key);
    if (captured.length >= 128) continue;
    const text = String(entry.reason ?? 'owner-unavailable');
    const requiredCapability = /byte|origin/.test(text) ? 'inspect-byte-binding'
      : /dispatch|target|callee|call/.test(text) ? 'inspect-call-targets'
        : /ABI|abi|argument|physical/.test(text) ? 'inspect-abi-placement'
          : /memory|object|buffer|lifetime/.test(text) ? 'inspect-memory-object'
            : /scope|world|profile|image|interposition/.test(text) ? 'inspect-world-closure' : 'inspect-canonical-evidence';
    const propositionId = createEntityId({ binaryId: world.binarySet[0].binaryId, kind: 'demand-open-obligation',
      identity: { artifactId, worldId: world.id, queryId: answer.queryId, entry } });
    const row = obligationRecord({ id: propositionId, propositionId, producerArtifactId: artifactId,
      ownerRevision: bundle.version, hypothesisIds: [], dependencies: [], evidenceIds: [answer.evidence.rootId],
      requiredCapability, declaredImpact: requiredCapability === 'inspect-world-closure' ? 5 : 3,
      costEstimate: { workUnits: 10000, bytesRead: 65536, residentBytes: 1048576, toolCalls: 1 } }, new Set());
    captured.push({ ...row, sourceFrontier: entry, discharger: 'canonical-owner-only' });
    await work.yieldIfNeeded();
  }
  const judgments = new Map(captured.map(row => [row.id, { status: 'open', reason: 'source-answer-has-undischarged-obligation' }]));
  const rows = await dependencyFrontier(captured, judgments, work), frontier = await actionFrontier(rows, maximumActions, work);
  work.checkpoint(); if (isCurrent() !== true) contractFail('demand-investigation-stale');
  const body = { schema: 'scoped-demand-investigation-frontier/v1', version: INVESTIGATION_FRONTIER_VERSION,
    artifactId, queryId: answer.queryId, worldId: world.id, assumptionsId: assumptions.id, snapshotId: bundle.snapshotId,
    template: answer.investigation?.template ?? null, obligations: rows, frontier,
    complete: false, omitted: Math.max(0, seen.size - captured.length) + (answer.frontier.omittedEntries ?? 0),
    dependencies: bundle.dependencies, evidenceRootId: answer.evidence.rootId, exact: false,
    costPolicy: 'bounded-planning-estimates; not-measured-completion-probability',
    authority: 'read-only-current-answer-frontier; no-job-status-or-canonical-fact-write' };
  return deepFreeze({ ...body, id: createEntityId({ binaryId: world.binarySet[0].binaryId,
    kind: body.schema, identity: body }), cost: work.cost() });
}
