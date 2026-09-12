/** Resumable input preparation around the existing summary SCC owner.
 * No new transfer functions, invented callees or context specialization.
 */
import { ResourceBudget } from '../../../core/budgets/index.js';
import { ScopedAnalysisWork, normalizeQueryLimits, workStopStatus } from '../../../core/budgets/scoped-work.js';
import { createEntityId, deepFreeze, stableStringify } from '../../../core/identity/index.js';
import { assertWorldScope, assertAssumptionSet } from '../../../core/identity/world.js';
import { snapshotContractData, recordFields, stringSet, exactString, contractFail } from '../../../core/identity/structured.js';
import { prepareDemandSummarySession } from '../../summary/interprocedural.js';
import { bindScopedSummaryCallCandidates } from '../../summary/scoped-call-candidates.js';
import { assertCanonicalQueryProjection } from './projection.js';
import { indexScopedFunctionEntries } from './call-targets.js';

export const SCOPED_SUMMARY_SLICE_LIMITS = Object.freeze({ functions: 32, externalModelRecords: 128,
  transfersPerStep: 64, sessionSteps: 128, callCandidateBindings: 512, callCandidateGaps: 256 });
export class ScopedSummarySliceSession {
  #world; #assumptions; #snapshotId; #locators; #load; #modelsProvider; #current; #id; #ledger;
  #controller = new AbortController(); #locals = new Map(); #models = new Map(); #members = []; #skipped = [];
  #next = 0; #phase = 'load'; #owner = null; #retained = 0; #terminal = null;
  #busy = false; #closed = false; #steps = 0;
  #retainedOutput = 0; #projections = new Map(); #linkIndex = null; #linked = 0; #bindings = []; #linkGaps = [];
  constructor({ query, world, assumptions, snapshotId, loadLocalSummary, getExternalModels = null, isCurrent } = {}) {
    const input = snapshotContractData(query, { maxBytes: 65536, maxNodes: 1024 });
    recordFields(input, ['functionIds'], 'scoped-summary-fields');
    this.#locators = stringSet(input.functionIds, 'scoped-summary-functions', SCOPED_SUMMARY_SLICE_LIMITS.functions);
    if (!this.#locators.length) contractFail('scoped-summary-functions-empty');
    this.#world = assertWorldScope(world); this.#assumptions = assertAssumptionSet(assumptions, world);
    this.#snapshotId = exactString(snapshotId, 'scoped-summary-snapshot');
    if (typeof loadLocalSummary !== 'function' || typeof isCurrent !== 'function'
      || (getExternalModels !== null && typeof getExternalModels !== 'function')) contractFail('scoped-summary-host');
    this.#load = loadLocalSummary; this.#modelsProvider = getExternalModels; this.#current = isCurrent;
    this.#id = createEntityId({ binaryId: world.binarySet[0].binaryId, kind: 'scoped-summary-preparation/v2',
      identity: { worldId: world.id, assumptionsId: assumptions.id, snapshotId, locators: this.#locators } });
    const limits = normalizeQueryLimits({ workUnits: 2000000, bytesRead: 128 * 1024 * 1024,
      residentBytes: 96 * 1024 * 1024, nodes: 262144, edges: 524288, calls: 8192,
      artifactsMaterialized: 512, pagesFetched: 8192, results: 4096 });
    this.#ledger = new ResourceBudget(Object.fromEntries(Object.entries(limits).filter(([key]) => !['deadlineMs', 'yieldEvery'].includes(key))),
      { name: 'scoped-summary-preparation', signal: this.#controller.signal });
  }
  #check(work) {
    work.checkpoint();
    if (this.#closed) contractFail('scoped-summary-closed');
    if (this.#current() !== true) contractFail('scoped-summary-stale');
  }
  #releaseInputs() {
    this.#locals.clear(); this.#models.clear(); this.#retained = 0;
    for (const projection of this.#projections.values()) projection.release();
    this.#projections.clear(); this.#linkIndex = null;
  }
  #finish(reason = null) {
    this.#terminal = reason; this.#phase = 'done';
    this.#owner?.close(); this.#owner = null; this.#releaseInputs();
    if (['cancelled', 'stale', 'closed', 'failed'].includes(reason)) {
      this.#bindings = []; this.#linkGaps = []; this.#retainedOutput = 0;
    }
  }
  async #loadOne(work) {
    const locator = this.#locators[this.#next];
    const loaded = await work.await((signal) => this.#load(locator, { work, signal }));
    let retainedProjection = false;
    try {
      this.#check(work);
      if (!loaded?.summary) this.#skipped.push({ locator, reason: loaded?.reason ?? 'isolated-local-summary-unavailable' });
      else {
        const summary = snapshotContractData(loaded.summary, { allowBigInt: true, maxBytes: 1048576, maxNodes: 32768 });
        const functionId = exactString(summary.functionId, 'scoped-summary-function-id');
        if (this.#locals.has(functionId) || loaded.functionId !== functionId || loaded.snapshotId !== this.#snapshotId
          || loaded.worldId !== this.#world.id) contractFail('scoped-summary-local-binding');
        let projectionBytes = 0;
        if (loaded.projection) {
          const projection = assertCanonicalQueryProjection(loaded.projection, { world: this.#world, assumptions: this.#assumptions });
          if (projection.functionId !== functionId || projection.inputIdentity.snapshotId !== this.#snapshotId) contractFail('scoped-summary-projection-binding');
          projectionBytes = projection.size * 768 + projection.edgeCount * 384 + 4096;
        }
        const size = stableStringify(summary).length * 2 + 256 + projectionBytes;
        work.charge('residentBytes', size); this.#check(work);
        this.#locals.set(functionId, deepFreeze(summary)); this.#retained += size;
        if (loaded.projection) { this.#projections.set(functionId, loaded.projection); retainedProjection = true; }
        this.#members.push({ locator, functionId, producerArtifactId: loaded.artifactId ?? null });
      }
      this.#next++;
      if (this.#next >= this.#locators.length) {
        if (!this.#locals.size) this.#finish('summary-roots-unavailable');
        else this.#phase = 'link';
      }
    } finally { if (!retainedProjection) loaded?.projection?.release(); }
  }
  async #linkOne(work) {
    if (!this.#linkIndex) this.#linkIndex = indexScopedFunctionEntries([...this.#projections.values()]);
    const member = this.#members[this.#linked], projection = this.#projections.get(member.functionId);
    if (projection) {
      const linked = await bindScopedSummaryCallCandidates(this.#locals.get(member.functionId), projection, this.#linkIndex,
        { world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshotId, work,
          maximumBindings: Math.min(SCOPED_SUMMARY_SLICE_LIMITS.callCandidateBindings - this.#bindings.length, work.remaining('results')) });
      this.#check(work);
      const gaps = linked.skipped.slice(0, SCOPED_SUMMARY_SLICE_LIMITS.callCandidateGaps - this.#linkGaps.length);
      const size = stableStringify(linked.bindings).length * 2 + stableStringify(gaps).length * 2;
      work.charge('results', linked.bindings.length);
      work.charge('residentBytes', size);
      // Commit only a whole function. Budget interruption repeats this bounded
      // unit without exposing half-linked SCC inputs or duplicate bindings.
      this.#locals.set(member.functionId, linked.summary);
      this.#bindings.push(...linked.bindings); this.#linkGaps.push(...gaps.map(row => ({ ...row, functionId: member.functionId })));
      this.#retainedOutput += size;
    } else if (this.#linkGaps.length < SCOPED_SUMMARY_SLICE_LIMITS.callCandidateGaps) this.#linkGaps.push({ functionId: member.functionId, reason: 'canonical-call-source-unavailable' });
    this.#linked++;
    if (this.#linked >= this.#members.length) this.#phase = 'models';
  }
  async #loadModels(work) {
    if (!this.#modelsProvider) { this.#phase = 'prepare'; return; }
    const external = await work.await((signal) => this.#modelsProvider({ signal, work }));
    this.#check(work);
    if (!(external instanceof Map)) contractFail('scoped-summary-model-map');
    const targets = new Set();
    for (const summary of this.#locals.values()) {
      for (const call of [...(summary.directCalls ?? []), ...(summary.indirectCallSets ?? [])]) {
        work.charge('workUnits');
        for (const id of call.targetEntityIds ?? call.candidateEntityIds ?? []) {
          work.charge('workUnits');
          if (!this.#locals.has(id) && external.has(id)) targets.add(id);
          if (targets.size > SCOPED_SUMMARY_SLICE_LIMITS.externalModelRecords) contractFail('scoped-summary-model-record-limit');
        }
      }
    }
    const models = new Map(); let retained = 0;
    for (const id of [...targets].sort()) {
      const model = snapshotContractData(external.get(id), { allowBigInt: true, maxBytes: 1048576, maxNodes: 32768 });
      const size = stableStringify(model).length * 2 + 128;
      work.charge('residentBytes', size); retained += size;
      models.set(id, deepFreeze(model));
    }
    // Detach all selected provider rows before yielding, never a mixed Map
    // generation or a full unbounded external SDK registry.
    this.#check(work); await work.yieldIfNeeded(); this.#check(work);
    this.#models = models; this.#retained += retained; this.#phase = 'prepare';
  }
  async step({ signal = null, limits = {} } = {}) {
    if (this.#busy || this.#closed) contractFail('scoped-summary-not-resumable');
    const work = new ScopedAnalysisWork({ signal, limits, parentBudget: this.#ledger, name: 'scoped-summary-step' });
    this.#busy = true; let executionStatus = 'paused', ownerResult = null;
    try {
      this.#check(work);
      if (++this.#steps > SCOPED_SUMMARY_SLICE_LIMITS.sessionSteps) this.#finish('session-step-limit');
      if (this.#retained + this.#retainedOutput) work.charge('residentBytes', this.#retained + this.#retainedOutput);
      if (this.#phase === 'load') await this.#loadOne(work);
      else if (this.#phase === 'link') await this.#linkOne(work);
      else if (this.#phase === 'models') await this.#loadModels(work);
      else if (this.#phase === 'prepare') {
        const prepared = await prepareDemandSummarySession({ roots: [...this.#locals.keys()], localSummaries: this.#locals,
          libraryModels: this.#models, world: this.#world, assumptions: this.#assumptions,
          snapshotId: this.#snapshotId, work, limits: { maxNodes: 32, maxComponents: 32, maxEffectsPerSummary: 256 },
          assertCurrent: () => !this.#closed && this.#current() === true });
        try {
          this.#check(work);
          if (prepared.session) { this.#owner = prepared.session; this.#phase = 'solve'; this.#releaseInputs(); }
          else this.#finish(prepared.reason ?? prepared.status ?? 'summary-preparation-incomplete');
        } catch (error) { prepared.session?.close(); throw error; }
      } else if (this.#phase === 'solve') {
        ownerResult = await this.#owner.step(work, { maximumTransfers: SCOPED_SUMMARY_SLICE_LIMITS.transfersPerStep });
        this.#check(work); executionStatus = ownerResult.executionStatus;
        if (!ownerResult.resumable || ['cancelled', 'stale'].includes(executionStatus)) {
          this.#finish(executionStatus === 'completed' ? null : ownerResult.terminalReason ?? executionStatus);
        }
      }
      this.#check(work);
      if (this.#phase === 'done') executionStatus = this.#terminal ?? 'completed';
    } catch (error) {
      const stopped = workStopStatus(error, work.signal);
      if (error?.code === 'scoped-summary-stale' || error?.message === 'scoped-summary-stale') {
        executionStatus = 'stale'; ownerResult = null; this.#finish('stale');
      } else if (stopped) {
        executionStatus = stopped;
        if (stopped === 'cancelled') { ownerResult = null; this.#finish('cancelled'); }
        else if (Object.keys(this.#ledger.limits).some((key) => this.#ledger.remaining(key) === 0)) this.#finish('session-resource-limit');
      } else { this.close('failed'); throw error; }
    } finally { this.#busy = false; work.dispose(); }
    return deepFreeze({ schema: 'scoped-summary-slice/v1', summaries: [], context: 'context-insensitive',
      status: { completeness: 'partial', reason: this.#terminal ?? 'summary-preparation-incomplete' },
      ...(ownerResult ?? {}), worldId: this.#world.id, assumptionsId: this.#assumptions.id, snapshotId: this.#snapshotId,
      preparationId: this.#id, executionStatus, resumable: this.#phase !== 'done', terminalReason: this.#terminal,
      callCandidateBindings: { context: 'context-insensitive', exhaustive: false, exact: false, publication: 'none',
        limitReached: this.#bindings.length >= SCOPED_SUMMARY_SLICE_LIMITS.callCandidateBindings || this.#linkGaps.length >= SCOPED_SUMMARY_SLICE_LIMITS.callCandidateGaps,
        bindings: [...this.#bindings], remaining: [...this.#linkGaps] },
      preparation: { phase: this.#phase, loadedFunctions: this.#next, linkedFunctions: this.#linked, totalFunctions: this.#locators.length,
        sourceInputsRetained: this.#retained > 0 },
      requestedScope: { requestedLocators: this.#locators, resolvedFunctionIds: this.#members.map((member) => member.functionId),
        members: this.#members.map((member) => ({ ...member })), skipped: [...this.#skipped] },
      cost: { step: work.cost(), preparationTotal: this.#ledger.snapshot(), ownerTotal: ownerResult?.cumulativeBudget ?? null, steps: this.#steps },
      semanticClosure: 'unknown', exact: false });
  }
  close(reason = 'closed') {
    if (this.#closed) return;
    this.#closed = true; this.#finish(reason);
    if (!this.#controller.signal.aborted) this.#controller.abort(new Error(`scoped-summary-${reason}`));
  }
}
