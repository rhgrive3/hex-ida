/** Demand-precision vertical slice. This session owns only scheduling and
 * immutable query views: SSA/MSSA, range, points-to and SCC transfer functions
 * remain in their existing owners. No partial result is published as closed.
 */
import { AdaptiveContextPolicy, normalizeAdaptiveContextPolicy } from '../../refinement/adaptive-context.js';
import { ResourceBudget } from '../../../core/budgets/index.js';
import { ScopedAnalysisWork, normalizeQueryLimits, workStopStatus } from '../../../core/budgets/scoped-work.js';
import { deepFreeze, stableStringify } from '../../../core/identity/index.js';
import { snapshotContractData, recordFields, exactInteger, contractFail } from '../../../core/identity/structured.js';
import { normalizeDemandPrecision } from '../../scoped-demand-projection.js';
import { prepareDemandSummarySession } from '../../summary/interprocedural.js';
import { bindScopedSummaryCallCandidates } from '../../summary/scoped-call-candidates.js';
import { specializeDemandSummary, demandContextRangeRequest, attachDemandContextRanges } from '../../summary/specialization.js';
import { compileSemanticQuery } from './plan.js';
import { assertDemandInvestigationIntent } from './investigation-templates.js';
import { indexScopedFunctionEntries, scopedCallTargetRows, canonicalDispatchSite } from './call-targets.js';
import { ScopedInterproceduralProjectionBuilder } from './interprocedural.js';
import { SemanticQueryExecution } from './execute.js';
import { explainCanonicalReferenceSlice } from './reference-slice.js';
import { collectDemandIntegerCandidates } from './demand-integer.js';
import { collectDemandAliasCandidates } from './demand-alias.js';
import { assembleFlowAnswer, publishFlowAnswer } from '../../../core/evidence/flow-answer.js';

export const DEMAND_SLICE_LIMITS = Object.freeze({ functions: 8, contexts: 32, dispatchSites: 128,
  results: 64, evidenceNodesPerResult: 96, sessionSteps: 256, retainedBytes: 24 * 1024 * 1024 });
const sizeOf = value => stableStringify(value).length * 2;
export class ScopedDemandSliceSession {
  #investigation; #world; #assumptions; #snapshot; #plan; #precision; #load; #current; #capture; #dispatch; #store; #reader;
  #ledger; #controller = new AbortController(); #members = []; #locals = new Map(); #owner = null;
  #phase = 'load'; #index = 0; #steps = 0; #busy = false; #closed = false; #terminal = null;
  #targets = []; #sites = []; #contexts = []; #bounds = []; #gaps = []; #slices = new Map();
  #execution = null; #result = null; #results = []; #bundle = null; #publication = null;
  #adaptive = null; #contextArtifactIds = new Set(); #maximumContexts; #retained = 0; #sccRevision = null;
  constructor({ request, world, assumptions, snapshotId, loadDemand, isCurrent, captureDependencies,
    resolveDispatch, store = null, readRange = null, investigation = null } = {}) {
    const input = snapshotContractData(request, { maxBytes: 262144, maxNodes: 16384 });
    recordFields(input, ['query', 'precision', 'maximumContexts', 'adaptiveRefinement'], 'demand-query-fields');
    this.#plan = compileSemanticQuery({ ...input.query, resultLimit: input.query?.resultLimit ?? 32 }, { world, assumptions });
    if (this.#plan.query.scope.functionIds.length > DEMAND_SLICE_LIMITS.functions
      || this.#plan.query.resultLimit > DEMAND_SLICE_LIMITS.results) contractFail('demand-query-scope-or-result-limit');
    this.#investigation = investigation === null ? null : assertDemandInvestigationIntent(investigation, { world, queryId: this.#plan.id });
    this.#precision = normalizeDemandPrecision(input.precision);
    const policy = normalizeAdaptiveContextPolicy(input.adaptiveRefinement);
    if (policy) this.#adaptive = new AdaptiveContextPolicy(policy);
    this.#maximumContexts = exactInteger(input.maximumContexts ?? 32, 'demand-context-limit', { min: 1, max: 32 });
    if (typeof loadDemand !== 'function' || typeof isCurrent !== 'function' || typeof captureDependencies !== 'function'
      || typeof resolveDispatch !== 'function') contractFail('demand-query-host');
    this.#world = world; this.#assumptions = assumptions; this.#snapshot = snapshotId;
    this.#load = loadDemand; this.#current = isCurrent; this.#capture = captureDependencies;
    this.#dispatch = resolveDispatch; this.#store = store; this.#reader = readRange;
    const limits = normalizeQueryLimits({ workUnits: 8000000, residentBytes: 256 * 1024 * 1024,
      bytesRead: 128 * 1024 * 1024, nodes: 262144, edges: 524288, results: 8192, calls: 16384,
      queueOperations: 2000000, artifactsMaterialized: 2048, pagesFetched: 16384 });
    this.#ledger = new ResourceBudget(Object.fromEntries(Object.entries(limits).filter(([key]) => !['deadlineMs', 'yieldEvery'].includes(key))),
      { name: 'scpa-demand-slice', signal: this.#controller.signal });
  }
  #check(work) { work.checkpoint(); if (this.#closed || this.#current() !== true) contractFail('demand-query-stale'); }
  #gap(row) { if (this.#gaps.length < 1023) this.#gaps.push(row); else if (this.#gaps.length === 1023) this.#gaps.push({ reason: 'demand-frontier-truncated' }); }
  #retain(value, work) {
    const bytes = sizeOf(value); work.charge('residentBytes', bytes);
    if (this.#retained + bytes > DEMAND_SLICE_LIMITS.retainedBytes) contractFail('demand-session-retained-limit');
    this.#retained += bytes;
  }
  #next(phase) { this.#phase = phase; this.#index = 0; }
  async #loadOne(work) {
    const locator = this.#plan.query.scope.functionIds[this.#index];
    const loaded = await this.#load(locator, { work, precision: this.#precision });
    let keep = false;
    try {
      this.#check(work);
      if (!loaded?.projection || loaded.demand?.status !== 'completed' || !loaded.demand.summary || !loaded.demand.nativeFlowInputs) {
        this.#gap({ functionId: locator, reason: loaded?.reason ?? loaded?.demand?.reason ?? 'native-demand-owner-unavailable' });
      } else {
        const { projection, demand } = loaded;
        if (this.#locals.has(projection.functionId)) contractFail('demand-query-duplicate-function');
        const member = { locator, functionId: projection.functionId, projection, demand, inputIdentity: projection.inputIdentity,
          artifactId: projection.inputIdentity.producerArtifactId, summary: demand.summary, factReferences: [] };
        const selected = new Set(demand.selectedValues), refs = new Set();
        for (let i = 0; i < projection.size; i++) {
          work.charge('workUnits'); const row = projection.recordAt(i);
          // MSSA definitions/uses connect object summaries to their real owner
          // rows. A finite cut remains visible instead of pretending completeness.
          if (selected.has(row.entityId) || row.owner === 'memory-ssa' || row.owner === 'memoryssa' || row.owner === 'semantic-ir') refs.add(row.id);
          if (refs.size >= 128) { this.#gap({ functionId: projection.functionId, reason: 'demand-owner-evidence-cut' }); break; }
        }
        for (const id of refs) member.factReferences.push({ record: projection.present(id, { includeOrigins: true }), source: projection.source(id) });
        member.integerProofCandidates = collectDemandIntegerCandidates(member, { world: this.#world, assumptions: this.#assumptions, work });
        member.aliasProofCandidates = collectDemandAliasCandidates(member, { work });
        this.#retain({ demand, factReferences: member.factReferences, inputIdentity: member.inputIdentity,
          integerProofCandidates: member.integerProofCandidates, aliasProofCandidates: member.aliasProofCandidates }, work);
        this.#check(work); this.#members.push(member); this.#locals.set(member.functionId, demand.summary); keep = true;
        for (const row of demand.frontier) this.#gap({ ...row, functionId: member.functionId });
      }
      if (++this.#index === this.#plan.query.scope.functionIds.length) this.#next(this.#members.length ? 'link' : 'unavailable');
    } finally { if (!keep) loaded?.projection?.release(); }
  }
  async #linkOne(work) {
    const member = this.#members[this.#index];
    const index = indexScopedFunctionEntries(this.#members.map(row => row.projection));
    const linked = await bindScopedSummaryCallCandidates(member.summary, member.projection, index,
      { world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshot, work, maximumBindings: 32, nativeDemand: member.demand });
    const targets = [], sites = [];
    for (let i = 0; i < member.projection.size; i++) {
      work.charge('workUnits'); const row = member.projection.recordAt(i);
      if (row.owner !== 'semantic-ir') continue;
      const node = member.projection.source(row.id), site = canonicalDispatchSite(node); if (!site) continue;
      if (sites.length + this.#sites.length < DEMAND_SLICE_LIMITS.dispatchSites) sites.push({ member, callSiteId: node.id });
      else this.#gap({ functionId: member.functionId, callSiteId: node.id, reason: 'demand-dispatch-site-cut' });
      // Jumps contribute dispatch bounds, but never call/ABI specializations.
      if (site.mode !== 'call') continue;
      work.charge('workUnits', Math.min(64, site.targetValueIds?.length ?? 0) * 512);
      for (const binding of scopedCallTargetRows(member.projection, node, index, member.demand)) {
        work.charge('workUnits');
        if (binding.inSelectedScope && !binding.reason && targets.length + this.#targets.length < this.#maximumContexts) targets.push(binding);
        else this.#gap({ callSiteId: node.id, reason: binding.reason ?? 'demand-context-cut' });
      }
      await work.yieldIfNeeded();
    }
    this.#retain({ summary: linked.summary, targets }, work); this.#check(work);
    member.summary = linked.summary; this.#locals.set(member.functionId, linked.summary);
    this.#targets.push(...targets); this.#sites.push(...sites);
    linked.skipped.forEach(row => this.#gap({ ...row, functionId: member.functionId }));
    if (++this.#index === this.#members.length) this.#next('prepare');
  }
  async #prepare(work) {
    const prepared = await prepareDemandSummarySession({ roots: [...this.#locals.keys()], localSummaries: this.#locals,
      libraryModels: new Map(), world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshot,
      work, limits: { maxNodes: 32, maxComponents: 32, maxEffectsPerSummary: 256 }, assertCurrent: this.#current });
    try {
      this.#check(work);
      if (prepared.session) { this.#owner = prepared.session; this.#next('solve'); }
      else { this.#gap({ reason: prepared.reason ?? 'summary-preparation-incomplete' }); this.#next('specialize'); }
    } catch (error) { prepared.session?.close(); throw error; }
  }
  async #solve(work) {
    const value = await this.#owner.step(work, { maximumTransfers: 64 }); this.#check(work);
    if (value.resumable) return;
    this.#sccRevision = value.inputDigest ?? null;
    for (const row of value.frontier?.entries ?? []) this.#gap({ ...row, phase: 'summary-scc' });
    if (value.status?.completeness && value.status.completeness !== 'complete') this.#gap({ reason: 'summary-scc-not-complete', status: value.status });
    for (const member of this.#members) {
      const settled = this.#owner.summary(member.functionId);
      if (settled) member.summary = settled;
      else this.#gap({ functionId: member.functionId, reason: 'scc-not-settled; local-conservative-summary-retained' });
    }
    this.#owner.close(); this.#owner = null; this.#next('specialize');
  }
  async #specialize(work) {
    if (this.#index >= this.#targets.length) { this.#next('dispatch'); return; }
    const target = this.#targets[this.#index], caller = this.#members.find(row => row.functionId === target.callerFunctionId),
      callee = this.#members.find(row => row.functionId === target.targetFunctionId);
    let view = await specializeDemandSummary({ caller, callee, callSiteId: target.callSiteId, targetBinding: target,
      summary: callee.summary, sccRevision: this.#sccRevision, world: this.#world, assumptions: this.#assumptions,
      snapshotId: this.#snapshot, work });
    const contextRequest = demandContextRangeRequest(view);
    const decision = contextRequest && this.#adaptive?.begin(view, callee.demand.ranges, { work });
    if (decision && !decision.admitted) this.#gap({ reason: decision.reason, contextId: view.id });
    if (contextRequest && (!decision || decision.admitted)) {
      let loaded = null, measured = null, completed = false;
      try {
        loaded = await this.#load(callee.locator, { work, precision: this.#precision, context: contextRequest });
        this.#check(work);
        if (loaded?.projection && loaded.demand?.conditionalRanges) {
          if (stableStringify(loaded.projection.inputIdentity.ownerDigests) !== stableStringify(callee.inputIdentity.ownerDigests)) contractFail('demand-context-callee-owner-changed');
          view = attachDemandContextRanges(view, { conditionalRanges: loaded.demand.conditionalRanges,
            artifactId: loaded.projection.inputIdentity.producerArtifactId, ownerIdentity: loaded.projection.inputIdentity });
          this.#contextArtifactIds.add(loaded.projection.inputIdentity.producerArtifactId);
          measured = loaded.demand.conditionalRanges; completed = true;
        } else this.#gap({ reason: loaded?.reason ?? 'context-range-owner-unavailable', contextId: view.id });
      } finally {
        loaded?.projection?.release();
        if (decision?.admitted) this.#adaptive.finish(decision.grant, measured, { completed });
      }
    }
    this.#retain(view, work); this.#check(work); this.#contexts.push(view); this.#index++;
  }
  async #dispatchOne(work) {
    if (this.#index >= this.#sites.length) { this.#next('query'); return; }
    const site = this.#sites[this.#index];
    const { cost: _cost, ...view } = await this.#dispatch(site.member.projection, site.callSiteId, work, { member: site.member, members: this.#members });
    this.#retain(view, work); this.#check(work); this.#bounds.push(view); this.#index++;
  }
  #startQuery() {
    const current = () => !this.#closed && this.#current() === true;
    const builder = new ScopedInterproceduralProjectionBuilder({ functionIds: this.#plan.query.scope.functionIds,
      world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshot, isCurrent: current,
      loadProjection: async locator => {
        const member = this.#members.find(row => row.locator === locator);
        return member ? { projection: member.projection, nativeFlowInputs: member.demand.nativeFlowInputs, nativeDemand: member.demand,
          specializations: this.#contexts.filter(row => row.callerFunctionId === member.functionId) }
          : { reason: 'demand-function-unavailable' };
      } });
    this.#execution = new SemanticQueryExecution({ plan: this.#plan, scopeBuilder: builder, world: this.#world,
      assumptions: this.#assumptions, loadProjection: async () => null, isCurrent: current, parentBudget: this.#ledger,
      totalLimits: { workUnits: 2000000, residentBytes: 96 * 1024 * 1024, nodes: 131072, edges: 262144, results: 64 },
      onResult: async (row, { projection, work }) => {
        const key = stableStringify(row);
        if (!this.#slices.has(key)) {
          if (this.#slices.size >= 64) contractFail('demand-result-evidence-limit');
          const roots = row.kind === 'record-match' ? [row.value.id] : (row.vertices ?? []).map(vertex => typeof vertex === 'string' ? vertex : vertex.id);
          const slice = await explainCanonicalReferenceSlice(projection, { projectionId: projection.id,
            referenceIds: [...new Set(roots)].slice(0, 32), direction: 'backward', maxDepth: 8, maxNodes: 96, includeBytes: true },
          { world: this.#world, assumptions: this.#assumptions, work, readRange: this.#reader, isCurrent: current });
          if (slice.status !== 'completed' || !slice.bundle) contractFail('demand-result-explanation-incomplete');
          this.#retain(slice.bundle, work); this.#check(work); this.#slices.set(key, slice.bundle);
        }
        return { ...row, evidenceSliceId: this.#slices.get(key).id ?? this.#slices.get(key).sliceId, semanticProof: false };
      } });
  }
  async step({ signal = null, limits = {} } = {}) {
    if (this.#closed || this.#busy || this.#phase === 'done') contractFail('demand-query-not-resumable');
    this.#busy = true; let work = null, status = 'paused';
    try {
      if (++this.#steps > DEMAND_SLICE_LIMITS.sessionSteps) { this.#terminal = 'demand-session-step-limit'; this.#phase = 'done'; }
      if (this.#phase === 'query') {
        if (!this.#execution) this.#startQuery();
        const page = await this.#execution.step({ signal, limits });
        if (this.#current() !== true) contractFail('demand-query-stale');
        this.#results.push(...page.results); this.#result = page;
        if (!page.resumable) {
          if (['cancelled', 'stale'].includes(page.executionStatus)) { this.#terminal = page.executionStatus; this.#phase = 'done'; }
          else this.#next('assemble');
        }
      } else {
        work = new ScopedAnalysisWork({ signal, limits, parentBudget: this.#ledger, name: 'demand-slice-step' });
        this.#check(work); if (this.#retained) work.charge('residentBytes', this.#retained);
        if (this.#phase === 'load') await this.#loadOne(work);
        else if (this.#phase === 'link') await this.#linkOne(work);
        else if (this.#phase === 'prepare') await this.#prepare(work);
        else if (this.#phase === 'solve') await this.#solve(work);
        else if (this.#phase === 'specialize') await this.#specialize(work);
        else if (this.#phase === 'dispatch') await this.#dispatchOne(work);
        else if (this.#phase === 'assemble') {
          const dependencies = this.#capture(this.#members, this.#sites, [...this.#contextArtifactIds]);
          const bundle = await assembleFlowAnswer({ plan: this.#plan, investigation: this.#investigation, result: { ...this.#result, results: this.#results },
            members: this.#members, specializations: this.#contexts, dispatchBounds: this.#bounds,
            slices: [...this.#slices.values()], frontier: [...this.#gaps, ...(this.#result?.frontier?.entries ?? [])],
            world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshot,
            dependencies, work, readRange: this.#reader, isCurrent: this.#current });
          this.#check(work); this.#bundle = bundle; this.#next('publish');
        } else if (this.#phase === 'publish') {
          this.#publication = await publishFlowAnswer(this.#bundle.payload, { store: this.#store, world: this.#world,
            snapshotId: this.#snapshot, work, isCurrent: this.#current });
          this.#check(work); this.#next('done');
        } else if (this.#phase === 'unavailable') { this.#terminal = 'native-demand-owner-unavailable'; this.#next('done'); }
      }
      if (this.#phase === 'done') status = this.#terminal ?? 'completed';
    } catch (error) {
      const stopped = workStopStatus(error, work?.signal ?? signal);
      if (/stale/.test(error?.code ?? error?.message ?? '')) { status = 'stale'; this.#terminal = status; this.#phase = 'done'; }
      else if (stopped) {
        status = stopped;
        if (stopped === 'cancelled' || Object.keys(this.#ledger.limits).some(key => this.#ledger.remaining(key) === 0)) {
          this.#terminal = stopped === 'cancelled' ? stopped : 'demand-session-resource-limit'; this.#phase = 'done';
        }
      } else { this.close('failed'); throw error; }
    } finally { work?.dispose(); this.#busy = false; }
    return deepFreeze({ schema: 'scoped-demand-slice/v1', worldId: this.#world.id, snapshotId: this.#snapshot,
      queryId: this.#plan.id, executionStatus: status, phase: this.#phase, terminalReason: this.#terminal,
      resumable: this.#phase !== 'done', exact: false, semanticClosure: 'unknown',
      answer: this.#phase === 'done' && !this.#terminal ? this.#bundle?.payload.answer ?? null : null,
      publication: this.#publication, progress: { loadedFunctions: this.#members.length, requestedFunctions: this.#plan.query.scope.functionIds.length,
        summaryContexts: this.#contexts.length, dispatchBounds: this.#bounds.length, resultCandidates: this.#results.length,
        evidenceSlices: this.#slices.size, published: this.#publication?.status === 'published' },
      adaptiveRefinement: this.#adaptive?.describe() ?? null,
      frontier: { entries: [...this.#gaps], closed: false, phase: this.#phase },
      cost: { step: work?.cost() ?? this.#result?.cost?.step ?? null, total: this.#ledger.snapshot(), steps: this.#steps } });
  }
  close(reason = 'closed') {
    if (this.#closed) return; this.#closed = true; this.#terminal ??= reason;
    this.#adaptive?.close();
    this.#owner?.close(); this.#owner = null; this.#execution?.close(reason); this.#execution = null;
    // release is idempotent; also covers projections not yet transferred when a
    // multi-function composition is cancelled between loads.
    for (const member of this.#members) member.projection.release();
    this.#members = []; this.#locals.clear(); this.#slices.clear(); this.#targets = []; this.#sites = [];
    this.#contexts = []; this.#bounds = []; this.#results = []; this.#bundle = null;
    if (!this.#controller.signal.aborted) this.#controller.abort(new Error(`demand-query-${reason}`));
  }
}
