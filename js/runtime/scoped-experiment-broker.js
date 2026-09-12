/** First-party, explicitly authorized experiment broker. NOT an AI read tool.
 * All execution goes through the existing RuntimeAnalysisPlatform/verifier.
 * A serialized approval flag, grant copy, SAT string or confidence score has
 * no authority. Grants are private, one-use, expiring object capabilities.
 */
import { assertWorldScope, assertAssumptionSet } from '../core/identity/world.js';
import { deepFreeze, stableDigest, lossyTypeWitness } from '../core/identity/index.js';
import { snapshotContractData, recordFields, exactString, exactInteger, unsignedAddress, contractFail } from '../core/identity/structured.js';
import { ScopedAnalysisWork } from '../core/budgets/scoped-work.js';
import { captureExperimentModuleBinding, assertExperimentModuleBinding } from './experiment-module-binding.js';
import { captureExperimentBinding, assertExperimentBinding } from './experiment-binding.js';
const now = () => globalThis.performance?.now?.() ?? Date.now();
const copy = value => snapshotContractData(value, { allowBigInt: true, maxNodes: 16384, maxBytes: 1048576 });
const digest = value => stableDigest({ value, typed: lossyTypeWitness(value) });
const SCHEMA = 'scoped-experiment-plan/v1';
let nextBroker = 0;
function normalizeExperiment(value, binaryHash) {
  const e = copy(value);
  recordFields(e, ['id', 'hypothesis', 'functionAddress', 'binaryHash', 'cases', 'generated', 'compiler'], 'scoped-experiment-fields');
  exactString(e.id, 'scoped-experiment-id');
  if (e.binaryHash !== binaryHash) contractFail('scoped-experiment-build-mismatch');
  unsignedAddress(e.functionAddress, { bits: 64 });
  if (!Array.isArray(e.cases) || !e.cases.length || e.cases.length > 64) contractFail('scoped-experiment-case-budget');
  const ids = new Set();
  for (const c of e.cases) {
    exactString(c.id, 'scoped-experiment-case-id');
    if (ids.has(c.id)) contractFail('scoped-experiment-duplicate-case'); ids.add(c.id);
    if (!Array.isArray(c.input?.arguments) || c.input.arguments.length > 16
      || !Array.isArray(c.initialState?.fields) || c.initialState.fields.length > 64
      || !Array.isArray(c.watch) || c.watch.length > 64) contractFail('scoped-experiment-case-shape');
  }
  return deepFreeze(e);
}
function traceCompleteness(result) {
  // A return value is not a complete trace. Missing loss/gap metadata stays
  // unknown; positive loss is never hidden by a successful case comparison.
  return result.cases.every(c => c.observation?.trace?.complete === true
    && c.observation.trace.dropped === 0 && Array.isArray(c.observation.trace.gaps)
    && c.observation.trace.gaps.length === 0) ? 'explicitly-complete' : 'unknown-or-gapped';
}
export class ScopedExperimentBroker {
  #world; #assumptions; #snapshotId; #isCurrent; #authorize; #captureSession; #run; #resolve;
  #plans = new Map(); #grants = new Map(); #busy = false; #closed = false; #lifetime = new AbortController();
  #serial = 0; #ownerId; #captureModules;
  constructor({ world, assumptions, snapshotId, isCurrent, authorize, captureSession, runExperiment, resolveCounterexample = null, getModuleBindingContext = null } = {}) {
    assertWorldScope(world); assertAssumptionSet(assumptions, world); exactString(snapshotId, 'experiment-broker-snapshot');
    for (const fn of [isCurrent, authorize, captureSession, runExperiment]) if (typeof fn !== 'function') contractFail('experiment-broker-host-capability');
    if (resolveCounterexample !== null && typeof resolveCounterexample !== 'function') contractFail('experiment-counterexample-owner');
    if (getModuleBindingContext !== null && typeof getModuleBindingContext !== 'function') contractFail('experiment-module-owner-callback');
    this.#captureModules = getModuleBindingContext;
    this.#world = world; this.#assumptions = assumptions; this.#snapshotId = snapshotId;
    this.#isCurrent = isCurrent; this.#authorize = authorize; this.#captureSession = captureSession;
    this.#run = runExperiment; this.#resolve = resolveCounterexample; this.#ownerId = ++nextBroker;
  }
  #check(plan = null, work = null) {
    work?.checkpoint();
    if (this.#closed || this.#isCurrent() !== true) contractFail('experiment-broker-stale');
    if (plan) {
      assertExperimentBinding(plan.binding, work?.signal);
      if (plan.moduleBinding) assertExperimentModuleBinding(plan.moduleBinding, work);
      if (now() >= plan.expires) contractFail('experiment-plan-expired');
      if (plan.candidateCurrent && plan.candidateCurrent() !== true) contractFail('experiment-counterexample-stale');
    }
    return true;
  }
  #prune() {
    for (const [id, plan] of this.#plans) if (now() >= plan.expires) this.#plans.delete(id);
    for (const [grant, item] of this.#grants) if (now() >= item.expires || !this.#plans.has(item.plan.id)) this.#grants.delete(grant);
  }
  async #withWork(options, callback) {
    const controller = new AbortController(), signals = [options.signal, this.#lifetime.signal].filter(Boolean), listeners = [];
    let work = null;
    try {
      for (const signal of signals) {
        const abort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true }); listeners.push([signal, abort]);
        if (signal.aborted) abort();
      }
      work = new ScopedAnalysisWork({ signal: controller.signal, limits: { deadlineMs: 10000, ...(options.limits ?? {}) }, name: 'scoped-runtime-experiment' });
      this.#check(null, work); return await callback(work);
    } finally { work?.dispose(); for (const [signal, abort] of listeners) signal.removeEventListener('abort', abort); }
  }
  #prepare(request, candidate = null) {
    this.#check(); this.#prune();
    recordFields(request, ['experiment', 'maxSteps', 'timeoutMs', 'ttlMs'], 'scoped-experiment-request-fields');
    if (this.#plans.size >= 16) contractFail('experiment-plan-capacity');
    const session = this.#captureSession(), binding = captureExperimentBinding(session, this.#captureSession);
    if (!this.#world.binarySet.some(b => b.sourceIdentity.kind === 'complete-content' && b.sourceIdentity.sha256 === binding.binaryHash)) {
      contractFail('experiment-world-build-unbound');
    }
    const experiment = normalizeExperiment(request.experiment, binding.binaryHash);
    const moduleBinding = this.#captureModules ? captureExperimentModuleBinding(this.#captureModules(),
      { world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshotId, debugBinding: binding, target: experiment.functionAddress }) : null;
    const ttlMs = exactInteger(request.ttlMs ?? 60000, 'experiment-plan-ttl', { min: 1, max: 60000 });
    const maxSteps = exactInteger(request.maxSteps ?? 20000, 'experiment-max-steps', { min: 1, max: 100000 });
    const timeoutMs = exactInteger(request.timeoutMs ?? 10000, 'experiment-timeout', { min: 1, max: 60000 });
    const body = { schema: SCHEMA, worldId: this.#world.id, assumptionsId: this.#assumptions.id,
      snapshotId: this.#snapshotId, binaryHash: binding.binaryHash, binding, moduleBinding, experiment, maxSteps, timeoutMs,
      purpose: candidate ? 'sat-counterexample-candidate-replay' : 'authorized-target-observation',
      candidate: candidate?.data ?? null, observationMode: 'intervened', exact: false,
      authority: 'requires-separate-host-approval; not-a-natural-execution-proof' };
    const id = `scpa-experiment:${this.#ownerId}:${++this.#serial}:${digest(body)}`;
    const plan = { id, preview: deepFreeze(body), binding, moduleBinding, experiment, maxSteps, timeoutMs,
      expires: now() + ttlMs, candidateCurrent: candidate?.isCurrent ?? null };
    this.#check(plan); this.#plans.set(id, plan);
    return deepFreeze({ id, ...body });
  }
  /** Preparation has no runtime side effects and never requests authorization. */
  prepare(request) { return this.#prepare(copy(request)); }
  /** A SAT candidate is resolved from a live first-party owner, never supplied
   * as executable JSON by an LLM. Owner validation is a declared premise, not
   * an independently implemented SAT solver in this broker.
   */
  async prepareCounterexampleReplay(request, options = {}) {
    const input = copy(request); recordFields(input, ['candidateId'], 'counterexample-replay-fields');
    exactString(input.candidateId, 'counterexample-candidate-id');
    if (!this.#resolve) contractFail('counterexample-owner-unavailable');
    return this.#withWork(options, async work => {
      const owner = await work.await(signal => this.#resolve(input.candidateId, { world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshotId, signal }));
      this.#check(null, work);
      if (typeof owner?.isCurrent !== 'function' || owner.isCurrent() !== true) contractFail('counterexample-owner-not-current');
      const data = copy(owner.data);
      recordFields(data, ['id', 'kind', 'worldId', 'assumptionsId', 'snapshotId', 'queryHash', 'checkerId', 'checkerVersion', 'experiment'], 'counterexample-owner-fields');
      if (data.id !== input.candidateId || data.kind !== 'validated-sat-candidate'
        || data.worldId !== this.#world.id || data.assumptionsId !== this.#assumptions.id || data.snapshotId !== this.#snapshotId) contractFail('counterexample-owner-binding');
      for (const k of ['queryHash', 'checkerId', 'checkerVersion']) exactString(data[k], 'counterexample-checker-binding');
      if (data.experiment?.cases?.length !== 1) contractFail('counterexample-single-model-required');
      const { experiment, ...identity } = data;
      return this.#prepare({ experiment }, { data: identity, isCurrent: owner.isCurrent });
    });
  }
  /** Only this private host callback may issue the single-use grant. Nothing
   * in the plan, tool JSON or resolver response bypasses the approval step.
   */
  async approve(planId, options = {}) {
    exactString(planId, 'experiment-plan-id'); this.#prune();
    const plan = this.#plans.get(planId); if (!plan) contractFail('experiment-plan-unavailable');
    if (this.#grants.size >= 16) contractFail('experiment-grant-capacity');
    return this.#withWork(options, async work => {
      this.#check(plan, work);
      const decision = copy(await work.await(signal => this.#authorize(deepFreeze({ id: plan.id, ...plan.preview }), { signal })));
      this.#check(plan, work);
      recordFields(decision, ['approved', 'decisionId'], 'experiment-authorization-fields');
      if (decision.approved !== true) contractFail('experiment-authorization-denied');
      exactString(decision.decisionId, 'experiment-authorization-id');
      const grant = Object.freeze({ schema: 'scoped-experiment-grant/v1', planId, decisionId: decision.decisionId });
      // Recheck after awaiting approval: concurrent requests cannot exceed cap.
      if (this.#grants.size >= 16) contractFail('experiment-grant-capacity');
      this.#grants.set(grant, { plan, expires: plan.expires, decisionId: decision.decisionId });
      return grant;
    });
  }
  async execute(grant, options = {}) {
    this.#prune();
    const entry = this.#grants.get(grant); if (!entry) contractFail('experiment-grant-unavailable-or-consumed');
    if (this.#busy) contractFail('experiment-broker-busy');
    this.#grants.delete(grant); this.#plans.delete(entry.plan.id); // consume before ANY external operation
    this.#busy = true;
    try { return await this.#withWork(options, async work => {
      const plan = entry.plan; this.#check(plan, work);
      const annotation = { schema: 'scoped-experiment-observation/v1', worldId: this.#world.id,
        assumptionsId: this.#assumptions.id, snapshotId: this.#snapshotId, planId: plan.id,
        authorizationId: entry.decisionId, sessionEpoch: plan.binding.epoch, observationMode: 'intervened',
        interventionIds: [plan.id], classification: 'observation-only', ...(plan.moduleBinding ? { moduleBinding: plan.moduleBinding } : {}) };
      const experiment = deepFreeze({ ...plan.experiment, scopedObservation: annotation });
      const timeoutMs = Math.max(1, Math.min(plan.timeoutMs, Math.floor(work.limits.deadlineMs - work.cost().elapsedMs)));
      const result = await work.await(signal => this.#run(experiment, { signal, maxSteps: plan.maxSteps,
        maxCases: plan.experiment.cases.length, timeoutMs, experimentTimeoutMs: timeoutMs }, () => this.#check(plan, work)));
      this.#check(plan, work);
      const completeness = traceCompleteness(result);
      const candidate = plan.preview.candidate;
      const reproduced = candidate && completeness === 'explicitly-complete' && result.coverage?.complete === true
        && result.cases.length === 1 && result.cases[0].comparison?.status === 'contradicted'
        && result.cases[0].observation?.stop?.kind === 'return';
      return { schema: 'scoped-experiment-result/v1', planId: plan.id, worldId: this.#world.id,
        assumptionsId: this.#assumptions.id, snapshotId: this.#snapshotId, status: 'observed',
        observationMode: 'intervened', exact: false, globalStaticTruth: false, candidateReproduced: candidate ? !!reproduced : null,
        traceCompleteness: completeness, result, annotation,
        remaining: ['authorized-case-only', 'natural-program-reachability-unproved', 'whole-program-disproof-unproved',
          ...(plan.moduleBinding ? [] : ['canonical-provider-module-generation-unbound']),
          ...(completeness === 'explicitly-complete' ? [] : ['trace-gap-or-completeness-unresolved'])], cost: work.cost() };
    }); } finally { this.#busy = false; }
  }
  close() { this.#closed = true; this.#lifetime.abort('broker-closed'); this.#plans.clear(); this.#grants.clear(); }
}
