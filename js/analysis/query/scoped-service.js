import { projectTaskIdiomView } from '../../core/evidence/task-idiom.js';
import { queryConditionalModel } from './semantic/conditional-model.js';
import { queryLoopInvariant } from './semantic/loop-evidence.js';
import { queryPortableChecks } from './semantic/portable-checks.js';
import { queryAsyncEventOrder } from '../apple/scoped-async.js';
import { bindScopedFlowInputs, SCOPED_ABI_INPUT_LIMITS } from '../scoped-flow-projection.js';
import { queryObjcBlockCaptures, nativeObjcBlockContext, projectNativeBlockCaptures } from '../apple/scoped-block.js';
import { createSwiftScopedDispatchResolver } from '../apple/scoped-swift.js';
import { describeInvestigationFrontier, describeDemandInvestigation, InvestigationViewCache } from '../../ai/investigation/scoped-frontier.js';
import { queryMachOPointerView, createObjcScopedDispatchResolver } from '../apple/scoped-metadata.js';
/** Experimental, host-bound orchestration. Canonical owners retain all facts. */
import { queryScopedAbiPlacement } from '../types/scoped-abi.js';
import { explainNativeTransformProjection } from '../../core/evidence/native-transform.js';
import { explainTransformChain } from '../../core/evidence/transform-chain.js';
import { queryRuntimeReconciliation } from '../../runtime/scoped-reconciliation.js';
import { createWorldScope, createAssumptionSet } from '../../core/identity/world.js';
import { snapshotContractData, recordFields, exactString, stringSet, contractFail } from '../../core/identity/structured.js';
import { DependencyEpochRegistry } from '../../core/artifacts/dependencies.js';
import { ScopedAnalysisWork, workStopStatus, INTERACTIVE_QUERY_LIMITS, MAXIMUM_QUERY_LIMITS } from '../../core/budgets/scoped-work.js';
import { EvidenceGraph } from '../../core/evidence/index.js';
import { exportEvidenceCertificate, replayEvidenceCertificate } from '../../core/evidence/certificate.js';
import { packEvidenceCertificates, unpackEvidenceCertificates, CERTIFICATE_PACK_SCHEMA } from '../../core/evidence/certificate-pack.js';
import { compileSemanticQuery, SEMANTIC_QUERY_COMPILER_VERSION } from './semantic/plan.js';
import { buildCanonicalQueryProjection } from './semantic/projection.js';
import { SemanticQueryExecution } from './semantic/execute.js';
import { ScopedInterproceduralProjectionBuilder } from './semantic/interprocedural.js';
import { ScopedCallGraphSession, SCOPED_CALL_GRAPH_LIMITS } from './semantic/call-graph.js';
import { ScopedDemandSliceSession } from './semantic/demand-slice.js';
import { prepareDemandOwnerReplay } from './semantic/demand-replay.js';
import { compileDemandInvestigation } from './semantic/investigation-templates.js';
import { FLOW_ANSWER_BUNDLE_SCHEMA } from '../../core/evidence/flow-answer.js';
import { ScopedSummarySliceSession, SCOPED_SUMMARY_SLICE_LIMITS } from './semantic/summary-slice.js';
import { explainCanonicalReferenceSlice, replayCanonicalReferenceSlice } from './semantic/reference-slice.js';
import { DispatchResolverRegistry, resolveUnifiedDispatch } from '../dispatch/unified.js';
import { createNativeDemandDispatchResolver } from '../dispatch/native-demand.js';
import { queryNativeAppleMetadata, createNativeAppleDispatchResolver } from '../apple/native-metadata.js';
import { createObjectContext, partitionPointsToObjects } from '../pointsto/objects.js';

const unsupported = (reason) => ({ value: { status: 'unsupported', reason, exact: false }, status: { completeness: 'unsupported', reason } });
const random = () => {
  if (!globalThis.crypto?.getRandomValues) contractFail('scoped-service-secure-random-required');
  return [...globalThis.crypto.getRandomValues(new Uint32Array(4))].map((n) => n.toString(16).padStart(8, '0')).join('');
};
const clock = () => globalThis.performance?.now?.() ?? Date.now();

export class ScopedAnalysisService {
  #host; #snapshot; #world; #assumptions; #dependencies; #dispatch; #sessions = new Map();
  #investigationCache = new InvestigationViewCache({ maximumJobs: 2 });
  #knowledgeCursors = new Set();
  #busy = false; #closed = false; #unregister = null; #expiryTimer = null; #lifetime = new AbortController();
  constructor({ host, snapshot, worldInput } = {}) {
    if (typeof host?.isCurrent !== 'function' || typeof host?.loadPipeline !== 'function') contractFail('scoped-service-host-required');
    this.#host = host; this.#snapshot = snapshot;
    this.#world = createWorldScope(worldInput); this.#assumptions = createAssumptionSet({}, this.#world);
    this.#dependencies = new DependencyEpochRegistry({ world: this.#world, maxSelectors: 8192, maxWatchers: 256 });
    this.#dispatch = new DispatchResolverRegistry({ onMembershipChange: () => this.#dependencies.reset('dispatch-provider-membership') });
    if (host.canonicalArchitecture === 'arm64') this.#dispatch.register(createNativeDemandDispatchResolver({ queryPointer: host.queryNativeApplePointer
      ? (request, context) => host.queryNativeApplePointer(request, context) : null, readMemory: host.readNativeDispatchMemory ?? null }));
    if (host.getNativeAppleMetadataContext) this.#dispatch.register(createNativeAppleDispatchResolver({
      snapshotId: snapshot.snapshotId, getContext: host.getNativeAppleMetadataContext,
      resolveFunctionIdentity: host.configuration.resolveFunctionIdentity ?? null }));
    if (host.configuration.getObjcDispatchContext && host.configuration.resolveFunctionIdentity) {
      this.#dispatch.register(createObjcScopedDispatchResolver({ getContext: host.configuration.getObjcDispatchContext,
        resolveFunctionIdentity: host.configuration.resolveFunctionIdentity, snapshotId: snapshot.snapshotId }));
    }
    if (host.configuration.getSwiftDispatchContext && host.configuration.resolveFunctionIdentity) {
      this.#dispatch.register(createSwiftScopedDispatchResolver({ getContext: host.configuration.getSwiftDispatchContext,
        resolveFunctionIdentity: host.configuration.resolveFunctionIdentity, snapshotId: snapshot.snapshotId }));
    }
    this.#unregister = host.artifactStore?.registerDependencyRegistry?.(this.#dependencies) ?? null;
  }
  get worldId() { return this.#world.id; }
  get closed() { return this.#closed; }
  get dependencies() { return this.#dependencies; }
  get dispatchResolvers() { return this.#dispatch; }
  #current() { return !this.#closed && this.#host.isCurrent() === true; }
  #assertCurrent() { if (!this.#current()) { this.close('stale'); contractFail('scoped-service-stale'); } }
  #prune() {
    const at = clock();
    for (const [cursor, entry] of this.#sessions) if (at >= entry.expires || !this.#dependencies.validate(entry.dependency)) {
      entry.execution.close('expired-or-stale'); this.#sessions.delete(cursor);
    }
  }
  #scheduleExpiry() {
    clearTimeout(this.#expiryTimer); this.#expiryTimer = null;
    if (this.#closed || !this.#sessions.size) return;
    const next = Math.min(...[...this.#sessions.values()].map((entry) => entry.expires));
    this.#expiryTimer = setTimeout(() => { this.#prune(); this.#scheduleExpiry(); }, Math.max(1, next - clock()));
    // Idle continuation cleanup must not keep a non-browser host running.
    this.#expiryTimer?.unref?.();
  }
  #save(kind, execution, dependency, { expires = null, scope = null } = {}) {
    this.#prune();
    if (this.#sessions.size >= this.#host.configuration.maximumSessions) { execution.close('session-cap'); return null; }
    const cursor = `scpa_${random()}`;
    this.#sessions.set(cursor, { kind, execution, dependency, scope, expires: expires ?? clock() + this.#host.configuration.sessionTtlMs });
    this.#scheduleExpiry();
    return cursor;
  }
  #take(cursor, kind) {
    this.#prune(); exactString(cursor, 'scoped-session-cursor', 256);
    const entry = this.#sessions.get(cursor);
    if (!entry || entry.kind !== kind) contractFail('scoped-session-unavailable-or-wrong-kind');
    // Single-use cursor. Failed or cancelled resume cannot be replayed to roll
    // back budget counters or duplicate already consumed result pages.
    this.#sessions.delete(cursor); this.#scheduleExpiry(); return entry;
  }
  #envelope(value, completeness = 'partial') {
    return { value: { ...value, world: this.#world, assumptions: this.#assumptions,
      analysisAuthority: 'canonical-owner-references', experimental: true, releaseQualified: false },
      status: { completeness, reason: value.reason ?? value.remaining?.[0] ?? null }, cost: value.cost ?? null };
  }
  async #load(locator, work, localProjection = null) {
    this.#assertCurrent(); exactString(locator, 'scoped-function-locator');
    const dependencyScope = this.#dependencies.capture([], { snapshotOnly: true });
    const loaded = await work.await((signal) => this.#host.loadPipeline(locator, { snapshot: this.#snapshot,
      world: this.#world, assumptions: this.#assumptions, work, signal, localProjection, dependencyScope }));
    if (!this.#dependencies.validate(dependencyScope)) contractFail('scoped-pipeline-dependencies-stale');
    this.#assertCurrent();
    if (!loaded?.pipeline) return { ...loaded, reason: loaded?.reason ?? 'canonical-pipeline-unavailable' };
    const pipeline = loaded.pipeline;
    if (pipeline.binaryId !== this.#snapshot.binaryId || (pipeline.snapshotId !== undefined && pipeline.snapshotId !== this.#snapshot.snapshotId)) contractFail('scoped-pipeline-identity-mismatch');
    return loaded;
  }
  #localView(loaded, kind) {
    const view = loaded.localProjection;
    if (!view || view.schema !== 'scoped-local-owner-projection/v1' || view.version !== (['demand', 'transforms'].includes(kind) ? '1.0.0' : ['ranges', 'range-values'].includes(kind) ? '1.2.0' : '1.1.0') || view.kind !== kind
      || view.worldId !== this.#world.id || view.snapshotId !== this.#snapshot.snapshotId
      || view.binaryId !== loaded.pipeline.binaryId || view.functionId !== loaded.pipeline.functionId) return null;
    return view;
  }
  async #projection(locator, work, nativeInputs = false) {
    const loaded = await this.#load(locator, work, nativeInputs ? { kind: 'flow-inputs', world: this.#world, assumptions: this.#assumptions } : null);
    if (!loaded.pipeline) return loaded;
    const projection = await buildCanonicalQueryProjection(loaded.pipeline, { world: this.#world, assumptions: this.#assumptions,
      snapshotId: this.#snapshot.snapshotId, work, sourceStatus: loaded.completeness ?? 'partial', producerArtifactId: loaded.artifactId ?? null, sourceLocation: loaded.scope ?? null, functionLocator: locator });
    try {
      this.#assertCurrent();
      const view = nativeInputs ? this.#localView(loaded, 'flow-inputs') : null;
      const nativeFlowInputs = view?.status === 'completed' && view.assumptionsId === this.#assumptions.id ? view.inputs : null;
      return { projection, nativeFlowInputs, nativeFlowReason: nativeInputs && !nativeFlowInputs ? view?.reason ?? 'native-abi-inputs-unavailable' : null };
    } catch (error) { projection.release(); throw error; }
  }
  async #nativeTransforms(input, work) {
    recordFields(input, ['functionId', 'includePremises'], 'native-transform-query-fields');
    exactString(input.functionId, 'native-transform-function');
    if (input.includePremises !== undefined && typeof input.includePremises !== 'boolean') contractFail('native-transform-premises-option');
    if (this.#host.canonicalArchitecture !== 'arm64') return { status: 'unsupported', reason: 'native-transform-arm64-owner-required', exact: false };
    const loaded = await this.#load(input.functionId, work, { kind: 'transforms', world: this.#world, assumptions: this.#assumptions });
    if (!loaded.pipeline) return { status: 'unsupported', reason: loaded.reason, exact: false };
    const view = this.#localView(loaded, 'transforms');
    if (!view) return { status: 'unsupported', reason: 'native-transform-projection-unavailable', exact: false };
    return explainNativeTransformProjection(view, { world: this.#world, assumptions: this.#assumptions,
      snapshotId: this.#snapshot.snapshotId, functionId: loaded.pipeline.functionId, producerArtifactId: loaded.artifactId,
      isCurrent: () => this.#current(), work, includePremises: input.includePremises ?? false });
  }
  async #taskView(input, work) {
    recordFields(input, ['functionId', 'task', 'statementIds'], 'task-query-fields');
    exactString(input.functionId, 'task-query-function');
    if (this.#host.canonicalArchitecture !== 'arm64') return { status: 'unsupported', reason: 'task-native-arm64-owner-required', exact: false };
    const loaded = await this.#load(input.functionId, work, { kind: 'transforms', world: this.#world, assumptions: this.#assumptions });
    if (!loaded.pipeline) return { status: 'unsupported', reason: loaded.reason, exact: false };
    const view = this.#localView(loaded, 'transforms');
    if (!view) return { status: 'unsupported', reason: 'task-current-source-unavailable', exact: false };
    const { functionId: _locator, ...query } = input;
    return projectTaskIdiomView(view, query, { world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshot.snapshotId,
      functionId: loaded.pipeline.functionId, producerArtifactId: loaded.artifactId, isCurrent: () => this.#current(), work });
  }
  /** One active operation per app bounds CPU and live projections on iPad. */
  async invoke(method, request = {}, options = {}) {
    this.#assertCurrent(); this.#prune();
    if (this.#busy) return unsupported('scoped-service-busy');
    this.#busy = true;
    // Only a data copy of user input enters analysis; host callbacks remain in
    // the private capability object and never travel with a plan or cursor.
    let work = null;
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    const retired = () => controller.abort(this.#lifetime.signal.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    this.#lifetime.signal.addEventListener('abort', retired, { once: true });
    if (options.signal?.aborted) abort();
    try {
      const input = snapshotContractData(request, { allowBigInt: true, maxBytes: method === 'replayProof' ? 8 * 1024 * 1024 : method === 'replayReferenceSlice' ? 3 * 1024 * 1024 : 262144, maxNodes: 100000 });
      if (['demandQuery', 'investigateDemand', 'resumeDemandQuery'].includes(method)) return await this.#demand(method, input, { ...options, signal: controller.signal });
      if (method === 'semanticQuery' || method === 'interproceduralQuery' || method === 'resumeSemanticQuery') return await this.#query(method, input, { ...options, signal: controller.signal });
      if (method === 'callGraphSlice' || method === 'resumeCallGraphSlice') return await this.#callGraph(method, input, { ...options, signal: controller.signal });
      if (method === 'summarySlice' || method === 'resumeSummarySlice') return await this.#summaries(method, input, { ...options, signal: controller.signal });
      work = new ScopedAnalysisWork({ limits: options.limits ?? {}, signal: controller.signal, name: 'scoped-api' });
      // Synchronous capability routes must obey cancellation too.
      work.checkpoint();
      let value;
      if (['explainDemandResult', 'replayDemandResult', 'demandInvestigationFrontier'].includes(method)) value = await this.#demandEvidence(method, input, work);
      else if (method === 'scopedCapabilities') value = this.#capabilities();
      else if (method === 'appleMetadataView') value = await queryNativeAppleMetadata(input, {
        world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshot.snapshotId, work,
        getContext: this.#host.getNativeAppleMetadataContext ?? null });
      else if (method === 'applePointerView') value = !this.#host.configuration.getMachOPointerContext && this.#host.queryNativeApplePointer
        ? await this.#host.queryNativeApplePointer(input, { world: this.#world, assumptions: this.#assumptions, work })
        : await queryMachOPointerView(input, { world: this.#world, assumptions: this.#assumptions,
          snapshotId: this.#snapshot.snapshotId, work, getContext: this.#host.configuration.getMachOPointerContext ?? null });
      else if (method === 'knowledgeMatches') {
        const { queryScopedRecognition } = await work.await(() => import('../../recognition/scoped-evidence.js'));
        const { nativeKnowledgeContext } = await work.await(() => import('../../recognition/native-context.js'));
        this.#assertCurrent();
        const nativeOwner = !this.#host.configuration.getKnowledgeContext ? this.#host.knowledgeOwner : null;
        const sourceContext = this.#host.configuration.getKnowledgeContext ?? (nativeOwner
          ? (locator, context) => nativeKnowledgeContext(locator, { ...context, work, database: nativeOwner,
              isCurrent: () => this.#current(), loadOwner: (id, precision) => this.#loadDemandOwner(id, work, precision) }) : null);
        let issuedCursor = null, delivered = false;
        const getContext = sourceContext && (async (...args) => {
          const context = await sourceContext(...args);
          if (nativeOwner) {
            // The input capability is consumed only after the owner accepted
            // its scope. A foreign-scope failure must remain cancellable.
            if (input.cursor) this.#knowledgeCursors.delete(input.cursor);
            issuedCursor = context?.page?.continuation ?? null;
          }
          return context;
        });
        try {
          value = await queryScopedRecognition(input, { world: this.#world, assumptions: this.#assumptions,
            snapshotId: this.#snapshot.snapshotId, work, getContext });
          work.checkpoint(); this.#assertCurrent();
          if (nativeOwner && value.continuation) {
            // Retire old expired/unconsumed capabilities too; never grow a
            // session-owned tracking set indefinitely across database epochs.
            while (this.#knowledgeCursors.size >= 32) {
              const oldest = this.#knowledgeCursors.values().next().value;
              nativeOwner.cancelScopedPage(oldest); this.#knowledgeCursors.delete(oldest);
            }
            this.#knowledgeCursors.add(value.continuation);
          }
          delivered = true;
        } finally { if (!delivered && issuedCursor) nativeOwner.cancelScopedPage(issuedCursor); }

      }
      else if (method === 'taskIdiomView') value = await this.#taskView(input, work);
      else if (method === 'inspectConditionalModel') value = await queryConditionalModel(input, {
        world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshot.snapshotId, work,
        getContext: this.#host.configuration.getConditionalModelContext ?? null, isCurrent: () => this.#current() });
      else if (method === 'checkLoopInvariant') value = await queryLoopInvariant(input, {
        world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshot.snapshotId, work,
        getContext: this.#host.configuration.getLoopModelContext ?? (this.#host.canonicalArchitecture === 'arm64' && this.#host.readRange
          ? (locator, loopId) => this.#nativeLoopContext(locator, loopId, work) : null), isCurrent: () => this.#current() });
      else if (method === 'asyncEventOrder') value = await queryAsyncEventOrder(input, {
        world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshot.snapshotId, work,
        getContext: this.#host.configuration.getAsyncEventContext ?? this.#host.getNativeAsyncEventContext ?? null,
        getRuntimeContext: this.#host.configuration.getRuntimeEvidenceContext ?? this.#host.getNativeRuntimeEvidenceContext ?? null, isCurrent: () => this.#current() });
      else if (method === 'portableIntegerChecks') value = this.#host.canonicalArchitecture !== 'arm64'
        ? { status: 'unsupported', reason: 'portable-native-arm64-required', exact: false }
        : await queryPortableChecks(input, { world: this.#world, assumptions: this.#assumptions,
          snapshotId: this.#snapshot.snapshotId, work, isCurrent: () => this.#current(), readRange: this.#host.readRange ?? null,
          loadOwner: (locator, work, precision) => this.#loadDemandOwner(locator, work, precision) });
      else if (method === 'dispatchTargets') value = await this.#targets(input, work);
      else if (method === 'investigationFrontier') {
        const view = await describeInvestigationFrontier(input, { world: this.#world, assumptions: this.#assumptions,
          snapshotId: this.#snapshot.snapshotId, work, getContext: this.#host.configuration.getInvestigationContext ?? this.#host.getNativeInvestigationContext ?? null,
          resolveDischarge: this.#host.configuration.resolveInvestigationDischarge ?? null });
        this.#assertCurrent();
        value = view.status === 'completed' ? this.#investigationCache.project(view, input.previousViewId ?? null, { work }) : view;
      }
      else if (method === 'abiInputBindings') value = await this.#abiInputs(input, work);
      else if (method === 'rangeValueCatalog') value = await this.#rangeCatalog(input, work);
      else if (method === 'typeEvidence') value = await this.#types(input, work);
      else if (method === 'blockCaptures') value = await this.#block(input, work);
      else if (method === 'abiPlacementEvidence') value = await this.#abiPlacement(input, work);
      else if (method === 'explainTransformChain' && input.stepIds === undefined) value = await this.#nativeTransforms(input, work);
      else if (method === 'explainTransformChain') {
        const checkers = this.#host.configuration.getProofCheckers
          ? await work.await((signal) => this.#host.configuration.getProofCheckers({ snapshot: this.#snapshot, world: this.#world, signal })) : null;
        this.#assertCurrent();
        value = await explainTransformChain(input, { world: this.#world, assumptions: this.#assumptions,
          snapshotId: this.#snapshot.snapshotId, work, resolveReceipt: this.#host.configuration.resolveTransformReceipt ?? null, checkers });
      }
      else if (method === 'runtimeObservations') value = await queryRuntimeReconciliation(input, {
        world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshot.snapshotId, work,
        getContext: this.#host.configuration.getRuntimeEvidenceContext ?? null,
        getTargetEnvelope: this.#host.configuration.getRuntimeTargetEnvelope ?? null,
        qualifyObservation: this.#host.configuration.qualifyRuntimeObservation ?? null });
      else if (method === 'referenceSlice' || method === 'replayReferenceSlice') value = await this.#references(method, input, work);
      else if (method === 'objectMemory') value = await this.#objects(input, work);
      else if (method === 'refineValueFacts') value = await this.#ranges(input, work);
      else if (method === 'proofSlice' || method === 'replayProof') value = await this.#proof(method, input, work);
      else if (method === 'cancelScopedQuery') {
        recordFields(input, ['cursor'], 'scoped-cancel-fields'); exactString(input.cursor, 'scoped-session-cursor', 256);
        const entry = this.#sessions.get(input.cursor); entry?.execution.close('user-cancelled'); this.#sessions.delete(input.cursor); this.#scheduleExpiry();
        const knowledge = this.#knowledgeCursors.delete(input.cursor) ? this.#host.knowledgeOwner?.cancelScopedPage(input.cursor).cancelled : false;
        value = { status: entry || knowledge ? 'cancelled' : 'not-found', cursor: input.cursor };
      } else return unsupported('scoped-api-method-unavailable');
      work.checkpoint();
      this.#assertCurrent();
      return this.#envelope(value, value.status === 'unsupported' ? 'unsupported' : 'partial');
    } catch (error) {
      const status = workStopStatus(error, controller.signal);
      if (status) return this.#envelope({ status, reason: status, exact: false, cost: work?.cost() ?? null }, 'partial');
      throw error;
    } finally {
      work?.dispose(); this.#busy = false;
      options.signal?.removeEventListener('abort', abort); this.#lifetime.signal.removeEventListener('abort', retired);
    }
  }
  #capabilities() {
    const native = this.#host.canonicalArchitecture === 'arm64';
    const custom = typeof this.#host.configuration.loadPipeline === 'function';
    return { schema: 'scoped-capabilities/v1', status: 'available-experimental', canonicalArchitecture: this.#host.canonicalArchitecture ?? null,
      producerQualification: custom ? 'custom-host-unverified' : native ? 'current-arm64-owner-unverified' : 'native-pair-unsupported', modes: {
      taskIdiomView: native ? 'source-bound-mask-condition-idioms; human-task-unmeasured; default-off' : 'unsupported',
      inspectConditionalModel: this.#host.configuration.getConditionalModelContext ? 'explicit-VL-SME-event-models; model-only-not-native-proof' : 'unsupported',
      checkLoopInvariant: this.#host.configuration.getLoopModelContext ? 'current-host-model-induction; machine-correspondence-unproved' : native && this.#host.readRange ? 'current-source-counted-loop-fragment; bounded-independent-induction' : 'unsupported',
      asyncEventOrder: this.#host.configuration.getAsyncEventContext || this.#host.getNativeAsyncEventContext ? 'versioned-captured-event-contracts; no-static-universal-order' : 'unsupported',
      portableIntegerChecks: native ? 'current-integer-proposals-and-bounded-detached-replay; no-whole-query-proof' : 'unsupported',
      demandQuery: native ? 'query-scoped-native-owners; selected-context-scc; atomic-evidence-answer; not-release-qualified' : 'unsupported',
      explainDemandResult: this.#host.artifactStore ? 'published-source-bytes-and-current-owner-rule-replay; semantic-closure-unknown' : 'unsupported',
      investigateDemand: native ? 'three-typed-templates-execute-demand-query; hypotheses-not-facts' : 'unsupported',
      demandInvestigationFrontier: this.#host.artifactStore ? 'published-answer-obligations; read-only-inspection' : 'unsupported',
      knowledgeMatches: this.#host.configuration.getKnowledgeContext || this.#host.knowledgeOwner ? 'native-fingerprint-and-bounded-knowledge-page; no-transfer-or-identity-proof' : 'unsupported',
      blockCaptures: this.#host.configuration.getObjcBlockContext || native ? 'native-memoryssa-field-and-escape-references; layout-and-lifetime-unqualified' : 'unsupported',
      swiftDispatch: this.#host.getNativeAppleMetadataContext || this.#host.configuration.getSwiftDispatchContext && this.#host.configuration.resolveFunctionIdentity ? 'bound-existing-swift-candidates; no-exact-targets' : 'unsupported',
      applePointerView: this.#host.configuration.getMachOPointerContext ? 'host-loader-required' : this.#host.queryNativeApplePointer ? 'isolated-current-loader-and-source-bytes; no-authentication-proof' : 'unsupported',
      appleMetadataView: this.#host.getNativeAppleMetadataContext ? 'existing-current-apple-metadata-owners; runtime-closure-unknown' : 'unsupported',
      callGraphSlice: native || custom ? 'bounded-selected-callsite-graph; literal-entry-binding; no-closure' : 'unsupported',
      semanticQuery: native || custom ? 'bounded-canonical-projection' : 'unsupported', interproceduralQuery: native || custom ? (this.#host.configuration.getFunctionFlowInterface ? 'explicit-scope-unqualified-value-ports' : native ? 'selected-native-arguments-declared-returns-and-may-memory-ports; exception-and-semantic-closure-open' : 'local-projection-with-open-call-cuts') : 'unsupported', dispatch: 'candidate-envelope',
      investigationFrontier: this.#host.configuration.getInvestigationContext ? 'read-only-existing-job-inventory; no-automatic-actions' : this.#host.getNativeInvestigationContext ? 'already-loaded-idle-job; exact-namespace-world-identity-required; no-core-initialization' : 'unsupported',
      typeEvidence: native || custom ? 'isolated-worker-canonical-type-projection' : 'unsupported',
      abiInputBindings: native ? 'isolated-existing-abi-and-compat-64-bit-register-inputs; candidate-only' : 'unsupported',
      abiPlacementEvidence: this.#host.configuration.getAbiPlacementContext || native ? 'canonical-owner-physical-consistency; prototype-unknown-preserved' : 'unsupported',
      explainTransformChain: (this.#host.configuration.resolveTransformReceipt || this.#host.canonicalArchitecture === 'arm64') ? 'receipt-dag-replay; checker-required-for-semantic-verdict' : 'unsupported',
      runtimeObservations: this.#host.configuration.getRuntimeEvidenceContext ? 'captured-events-only; no-runtime-experiments' : 'unsupported',
      objectMemory: native || custom ? 'isolated-worker-points-to-root-projection' : 'unsupported',
      summarySlice: native || custom ? 'resumable-source-preparation-and-context-insensitive-bounded-scc' : 'unsupported',
      rangeValueCatalog: native ? 'isolated-canonical-value-identities' : 'unsupported',
      rangeRefinement: this.#host.configuration.getPhase8Context ? 'host-owner-required' : native ? 'isolated-existing-phase8-sccp; no-publication' : 'unsupported',
      referenceSlice: native || custom ? 'bounded-current-owner-reference-and-origin-byte-explanation; not-semantic-proof' : 'unsupported',
      proofExport: this.#host.configuration.getEvidenceGraph ? 'host-graph-required' : 'unsupported',
      proofReplay: this.#host.configuration.getProofCheckers ? 'host-checkers-required' : 'integrity-only' },
      contracts: { queryCompilerVersion: SEMANTIC_QUERY_COMPILER_VERSION,
        nativeFunctionLocator: 'current-exact-address; reference.functionLocator, not canonical semantic entity ID',
        resourceBudget: { defaults: INTERACTIVE_QUERY_LIMITS, ceilings: MAXIMUM_QUERY_LIMITS,
          accounting: 'conservative-allocation-and-work; not-measured-peak-RSS',
          clientOption: 'workBudget in tools; limits in AnalysisQueryAPI options' },
        continuations: { singleUse: true, maximumRetained: this.#host.configuration.maximumSessions,
          ttlMs: this.#host.configuration.sessionTtlMs, idleSessions: this.#sessions.size,
          freshBudgetResetsTotals: false, resumeExtendsExpiry: false, releaseMethod: 'cancelScopedQuery' },
        nativeAbiInputs: SCOPED_ABI_INPUT_LIMITS,
        callGraph: SCOPED_CALL_GRAPH_LIMITS, summaries: SCOPED_SUMMARY_SLICE_LIMITS,
        rangeValues: { ownerIdentityRequiredForNativeRefinement: true,
          catalogMethod: 'rangeValueCatalog', numericIdsStableAcrossOwners: false },
        references: { portable: true, replayComparesCompleteContent: true, semanticProof: false } },
      dependencyRegistry: this.#dependencies.stats(), unknowns: ['world-closure', 'ambient-machine-state', 'current-roadmap-prerequisites'],
      exact: false, authority: 'availability-is-not-semantic-qualification' };
  }
  async #query(method, input, options) {
    let execution, prior = null;
    const dependency = this.#dependencies.capture([], { snapshotOnly: true });
    if (method === 'resumeSemanticQuery') {
      recordFields(input, ['cursor'], 'scoped-query-resume-fields');
      prior = this.#take(input.cursor, 'semantic'); execution = prior.execution;
    } else {
      this.#prune();
      if (this.#sessions.size >= this.#host.configuration.maximumSessions) return unsupported('scoped-session-cap');
      const plan = compileSemanticQuery(input, { world: this.#world, assumptions: this.#assumptions });
      const scopeBuilder = method === 'interproceduralQuery' ? new ScopedInterproceduralProjectionBuilder({
        functionIds: plan.query.scope.functionIds, world: this.#world, assumptions: this.#assumptions,
        snapshotId: this.#snapshot.snapshotId, loadProjection: (locator, ctx) => this.#projection(locator, ctx.work,
          this.#host.canonicalArchitecture === 'arm64' && !this.#host.configuration.getFunctionFlowInterface),
        getFunctionFlowInterface: this.#host.configuration.getFunctionFlowInterface ?? null,
        isCurrent: () => this.#current() && this.#dependencies.validate(dependency),
      }) : null;
      execution = new SemanticQueryExecution({ plan, scopeBuilder, world: this.#world, assumptions: this.#assumptions,
        loadProjection: (locator, ctx) => this.#projection(locator, ctx.work),
        isCurrent: () => this.#current() && this.#dependencies.validate(dependency),
        totalLimits: { residentBytes: 32 * 1024 * 1024, nodes: 65536, edges: 262144, results: 1024 } });
    }
    try {
      const value = await execution.step({ signal: options.signal, limits: options.limits ?? {} });
      this.#assertCurrent();
      const cursor = value.resumable ? this.#save('semantic', execution, prior?.dependency ?? dependency, { expires: prior?.expires ?? null }) : null;
      if (!cursor) execution.close(value.resumable ? 'session-cap' : 'completed');
      return this.#envelope({ ...value, continuation: cursor ? { cursor, kind: 'semantic-query' } : null,
        resumable: Boolean(cursor), ...(value.resumable && !cursor ? { reason: 'session-cap' } : {}) });
    } catch (error) { execution.close('failed'); throw error; }
  }
  async #demand(method, input, options) {
    const dependency = this.#dependencies.capture([], { snapshotOnly: true });
    let session, prior = null;
    if (method === 'resumeDemandQuery') {
      recordFields(input, ['cursor'], 'scoped-demand-resume-fields');
      prior = this.#take(input.cursor, 'demand'); session = prior.execution;
    } else {
      if (this.#sessions.size >= this.#host.configuration.maximumSessions) return unsupported('scoped-session-cap');
      const current = () => this.#current() && this.#dependencies.validate(dependency);
      const template = method === 'investigateDemand' ? compileDemandInvestigation(input, { world: this.#world, assumptions: this.#assumptions }) : null;
      session = new ScopedDemandSliceSession({ request: template?.request ?? input, investigation: template?.intent ?? null, world: this.#world, assumptions: this.#assumptions,
        snapshotId: this.#snapshot.snapshotId, isCurrent: current, store: this.#host.artifactStore ?? null,
        readRange: this.#host.readRange ?? null,
        captureDependencies: (members, sites, contextArtifactIds) => this.#dependencies.capture([
          { selector: { kind: 'binary-images', ownerId: this.#world.id, partition: '*' }, polarity: 'complete-membership' },
          { selector: { kind: 'function-membership', ownerId: this.#world.id, partition: '*' }, polarity: 'negative-membership' },
          { selector: { kind: 'external-models', ownerId: this.#world.id, partition: '*' }, polarity: 'negative-membership' },
          ...sites.map(({ member, callSiteId }) => ({ selector: { kind: 'dispatch-targets', ownerId: member.functionId,
            partition: callSiteId }, polarity: 'complete-membership' })),
          ...members.map(member => ({ selector: { kind: 'byte-ranges', ownerId: member.functionId,
            partition: this.#snapshot.snapshotId }, polarity: 'positive-membership' })),
        ], { positiveArtifactIds: [...new Set([...members.map(member => member.artifactId).filter(Boolean), ...contextArtifactIds])], snapshotOnly: true }),
        resolveDispatch: (projection, callSiteId, work, nativeContext) => resolveUnifiedDispatch(projection,
          { functionId: projection.functionId, callSiteId, maxTargets: 64, maxHops: 8 },
          { world: this.#world, assumptions: this.#assumptions, work, registry: this.#dispatch, nativeContext,
            admit: this.#host.configuration.qualifyDispatch ?? null }),
        loadDemand: (locator, { work, precision, context = null }) => this.#loadDemandOwner(locator, work, precision, context) });
    }
    try {
      const value = await session.step({ signal: options.signal, limits: options.limits ?? {} });
      this.#assertCurrent();
      const cursor = value.resumable ? this.#save('demand', session, prior?.dependency ?? dependency, { expires: prior?.expires ?? null }) : null;
      if (!cursor) session.close(value.resumable ? 'session-cap' : 'completed');
      return this.#envelope({ ...value, continuation: cursor ? { cursor, kind: 'demand-query' } : null,
        resumable: Boolean(cursor), ...(value.resumable && !cursor ? { reason: 'scoped-session-cap' } : {}) });
    } catch (error) { session.close('failed'); throw error; }
  }
  async #loadDemandOwner(locator, work, precision, context = null) {
    const loaded = await this.#load(locator, work, { kind: 'demand', precision, ...(context ? { context } : {}), world: this.#world, assumptions: this.#assumptions });
    if (!loaded.pipeline) return { reason: loaded.reason };
    const demand = this.#localView(loaded, 'demand');
    if (!demand || demand.assumptionsId !== this.#assumptions.id) return { reason: demand?.reason ?? 'native-demand-view-unavailable' };
    const projection = await buildCanonicalQueryProjection(loaded.pipeline, { world: this.#world, assumptions: this.#assumptions,
      snapshotId: this.#snapshot.snapshotId, work, sourceStatus: loaded.completeness ?? 'partial',
      producerArtifactId: loaded.artifactId ?? null, sourceLocation: loaded.scope ?? null, functionLocator: locator });
    try {
      const blockCaptures = await projectNativeBlockCaptures(projection, demand, { world: this.#world, assumptions: this.#assumptions,
        snapshotId: this.#snapshot.snapshotId, work, isCurrent: () => this.#current() });
      this.#assertCurrent(); return { projection, demand: { ...demand, blockCaptures } };
    }
    catch (error) { projection.release(); throw error; }
  }
  async #demandEvidence(method, input, work) {
    recordFields(input, method === 'demandInvestigationFrontier' ? ['artifactId', 'maximumActions'] : ['artifactId', 'view', 'level', 'encoding'], 'demand-evidence-fields');
    exactString(input.artifactId, 'demand-evidence-artifact');
    const view = input.view ?? 'summary';
    if (input.encoding != null && (method !== 'explainDemandResult' || view !== 'certificate'
      || !['canonical', 'shared-dag-v1'].includes(input.encoding))) contractFail('demand-evidence-encoding');
    if (input.level != null && (method !== 'replayDemandResult' || !['integrity', 'owners'].includes(input.level))) contractFail('demand-replay-level');
    if (!['summary', 'certificate', 'graph', 'answer'].includes(view)) contractFail('demand-evidence-view');
    const store = this.#host.artifactStore;
    if (!store) return { status: 'unsupported', reason: 'canonical-artifact-store-unavailable', exact: false };
    work.charge('artifactsMaterialized');
    const loaded = await work.await(signal => store.get(input.artifactId, { signal, allowIncomplete: true, observeForQuarantine: method === 'replayDemandResult' }));
    this.#assertCurrent();
    if (loaded.status !== 'hit') return { status: loaded.status, reason: loaded.reason ?? 'demand-answer-unavailable', exact: false };
    const bundle = loaded.payload;
    if (bundle?.schema !== FLOW_ANSWER_BUNDLE_SCHEMA || bundle.worldId !== this.#world.id
      || bundle.assumptionsId !== this.#assumptions.id || bundle.snapshotId !== this.#snapshot.snapshotId
      || !this.#dependencies.validate(bundle.dependencies)) return { status: 'stale', reason: 'demand-answer-world-or-dependencies-stale', exact: false };
    if (method === 'demandInvestigationFrontier') return describeDemandInvestigation(bundle, { artifactId: input.artifactId,
      maximumActions: input.maximumActions ?? 16, world: this.#world, assumptions: this.#assumptions, work,
      isCurrent: () => this.#current() && this.#dependencies.validate(bundle.dependencies) });
    if (method === 'replayDemandResult') {
      const graph = EvidenceGraph.fromJSON(bundle.graph);
      work.charge('calls'); // reserve an atomic withdrawal fence
      let ownerReplay = null, result;
      try {
        if ((input.level ?? 'owners') === 'owners') ownerReplay = await prepareDemandOwnerReplay(bundle, graph,
          { world: this.#world, assumptions: this.#assumptions, work,
            loadOwner: (locator, work, precision) => this.#loadDemandOwner(locator, work, precision),
            isCurrent: () => this.#current() && this.#dependencies.validate(bundle.dependencies) });
        result = await replayEvidenceCertificate(bundle.certificate.certificate, { world: this.#world,
          assumptions: this.#assumptions, work, readRange: this.#host.readRange ?? null,
          resolveCanonicalNode: ownerReplay?.resolveCanonicalNode ?? (async id => ({ worldId: this.#world.id, node: graph.getNode(id) })),
          checkers: ownerReplay?.checkers ?? null, stopOnRejection: true, canonicalResolverExecution: 'local-bounded' });
        result = { ...result, ownerReplay: ownerReplay ? { counters: { ...ownerReplay.counters },
          unavailable: ownerReplay.unavailable, mismatches: ownerReplay.mismatches, independentProof: false } : null };
      } finally { ownerReplay?.close(); }
      this.#assertCurrent();
      let quarantine = null;
      if (result.integrity === 'rejected' || result.semantic === 'rejected') {
        const reason = result.integrity === 'rejected' ? 'integrity-rejection'
          : result.rejected?.some(row => /byte/.test(row.reason)) ? 'source-byte-rejection' : 'semantic-contradiction';
        quarantine = typeof store.quarantineObserved === 'function'
          ? await work.await(signal => store.quarantineObserved(loaded, { reason, signal }), { chargeCall: false })
          : { status: 'unsupported', reason: 'canonical-store-quarantine-unavailable' };
      }
      return { ...result, artifactId: input.artifactId, quarantine, exact: false,
        authority: 'current-source-binding-and-scoped-integer-derivations; whole-query-semantic-proof-unknown' };
    }
    const answer = bundle.answer;
    const certificateTransfer = view === 'certificate' && input.encoding === 'shared-dag-v1'
      ? await packEvidenceCertificates([bundle.certificate.certificate], { world: this.#world, assumptions: this.#assumptions, work }) : null;
    this.#assertCurrent();
    if (!this.#dependencies.validate(bundle.dependencies)) return { status: 'stale', reason: 'demand-answer-dependencies-changed-during-explanation', exact: false };
    return { schema: 'scoped-demand-explanation/v1', status: 'completed', artifactId: input.artifactId,
      queryId: answer.queryId, worldId: this.#world.id, snapshotId: this.#snapshot.snapshotId, view,
      ...(view === 'graph' ? { graph: bundle.graph } : view === 'certificate' ? certificateTransfer ? { certificateTransfer, encoding: 'shared-dag-v1', semantic: 'unknown' } : { certificate: bundle.certificate }
        : view === 'answer' ? { answer } : { judgment: answer.judgment, existence: answer.existence, upper: answer.upper,
          lower: answer.lower, frontier: answer.frontier, dependencies: bundle.dependencies, evidence: answer.evidence,
          counts: { candidates: answer.candidates.length, objects: answer.precision.objects.length,
            valueFacts: answer.precision.valueFacts.length, summaryContexts: answer.precision.summarySpecializations.length,
            dispatchBounds: answer.precision.dispatchBounds.length } }),
      exact: false, checkerLevel: 'integrity-only', releaseQualified: false };
  }
  async #callGraph(method, input, options) {
    const dependency = this.#dependencies.capture([], { snapshotOnly: true });
    let session, prior = null;
    if (method === 'resumeCallGraphSlice') {
      recordFields(input, ['cursor'], 'scoped-call-graph-resume-fields');
      prior = this.#take(input.cursor, 'call-graph'); session = prior.execution;
    } else {
      this.#prune();
      if (this.#sessions.size >= this.#host.configuration.maximumSessions) return unsupported('scoped-session-cap');
      session = new ScopedCallGraphSession({ query: input, world: this.#world, assumptions: this.#assumptions,
        snapshotId: this.#snapshot.snapshotId, loadProjection: (locator, ctx) => this.#host.canonicalArchitecture === 'arm64'
          ? this.#loadDemandOwner(locator, ctx.work, { maximumValues: 64 }) : this.#projection(locator, ctx.work),
        resolveDispatch: (projection, callSiteId, work, nativeContext) => resolveUnifiedDispatch(projection,
          { functionId: projection.functionId, callSiteId, maxTargets: nativeContext.maxTargets, maxHops: nativeContext.maxHops },
          { world: this.#world, assumptions: this.#assumptions, work, registry: this.#dispatch, nativeContext,
            admit: this.#host.configuration.qualifyDispatch ?? null }),
        isCurrent: () => this.#current() && this.#dependencies.validate(dependency) });
    }
    try {
      const value = await session.step({ signal: options.signal, limits: options.limits ?? {} });
      this.#assertCurrent();
      const cursor = value.resumable ? this.#save('call-graph', session, prior?.dependency ?? dependency, { expires: prior?.expires ?? null }) : null;
      if (!cursor) session.close(value.resumable ? 'session-cap' : 'completed');
      return this.#envelope({ ...value, continuation: cursor ? { cursor, kind: 'call-graph-slice' } : null,
        resumable: Boolean(cursor), ...(value.resumable && !cursor ? { reason: 'scoped-session-cap' } : {}) });
    } catch (error) { session.close('failed'); throw error; }
  }
  async #targets(input, work) {
    recordFields(input, ['functionId', 'callSiteId', 'families', 'maxTargets', 'maxHops'], 'scoped-dispatch-fields');
    const loaded = this.#host.canonicalArchitecture === 'arm64'
      ? await this.#loadDemandOwner(input.functionId, work, { maximumValues: 64 }) : await this.#projection(input.functionId, work);
    if (!loaded.projection) return { status: 'unsupported', reason: loaded.reason };
    try {
      const value = await resolveUnifiedDispatch(loaded.projection, { ...input, functionId: loaded.projection.functionId },
        { world: this.#world, assumptions: this.#assumptions, work, registry: this.#dispatch,
          admit: this.#host.configuration.qualifyDispatch ?? null,
          nativeContext: loaded.demand ? { member: { projection: loaded.projection, demand: loaded.demand,
            inputIdentity: loaded.projection.inputIdentity, functionId: loaded.projection.functionId },
            members: [{ projection: loaded.projection, demand: loaded.demand,
              inputIdentity: loaded.projection.inputIdentity, functionId: loaded.projection.functionId }] } : null });
      return { ...value, requestedFunctionLocator: input.functionId };
    }
    finally { loaded.projection.release(); }
  }
  async #nativeLoopContext(locator, loopId, work) {
    if (loopId !== 'entry-counted-loop') return { reason: 'native-loop-id-unsupported' };
    const loaded = await this.#load(locator, work);
    if (!loaded.pipeline) return { reason: loaded.reason };
    const source = loaded.nativeSource;
    if (!source || source.length !== 24 || source.binaryId !== this.#snapshot.binaryId || !loaded.artifactId) {
      return { reason: 'native-loop-entry-fragment-unavailable' };
    }
    const dependency = this.#dependencies.capture([], { snapshotOnly: true });
    const current = () => this.#current() && this.#dependencies.validate(dependency);
    return { isCurrent: current, nativeSource: source,
      binding: { worldId: this.#world.id, assumptionsId: this.#assumptions.id, snapshotId: this.#snapshot.snapshotId,
        functionLocator: locator, loopId, modelRevision: 'native-counted-loop/v1', artifactId: loaded.artifactId,
        sourceReferences: [loaded.artifactId, loaded.pipeline.semanticIr.nodes[0]?.id].filter(Boolean) },
      readNativeBytes: async ({ signal }) => {
        if (!current()) contractFail('native-loop-source-stale');
        const response = await this.#host.readRange({ worldId: this.#world.id, binaryId: source.binaryId,
          offset: source.offset, length: source.length }, { signal });
        if (!current()) contractFail('native-loop-source-stale');
        return { ...response, snapshotId: this.#snapshot.snapshotId, virtualStart: source.virtualStart };
      } };
  }
  async #abiPlacement(input, work) {
    recordFields(input, ['functionId', 'kind', 'callSiteId'], 'scoped-abi-query-fields');
    if (this.#host.configuration.getAbiPlacementContext) return queryScopedAbiPlacement(input, {
      world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshot.snapshotId, work,
      getContext: this.#host.configuration.getAbiPlacementContext });
    exactString(input.functionId, 'scoped-abi-function');
    if (!['arguments', 'return'].includes(input.kind)) contractFail('scoped-abi-query-kind');
    const callSiteId = input.callSiteId == null ? null : exactString(input.callSiteId, 'scoped-abi-callsite');
    const loaded = await this.#loadDemandOwner(input.functionId, work, { maximumValues: 1 });
    try {
      if (!loaded.projection) return { status: 'unsupported', reason: loaded.reason, exact: false };
      const value = loaded.demand.abiPlacements?.views.find(row => row.kind === input.kind && row.callSiteId === callSiteId);
      if (!value) return { status: 'unsupported', reason: 'native-abi-request-outside-bounded-owner', exact: false };
      if (value.binding && (value.binding.producerArtifactId !== loaded.projection.inputIdentity.producerArtifactId
        || value.binding.functionId !== loaded.projection.functionId)) contractFail('native-abi-transport-binding');
      this.#assertCurrent(); return { ...value, requestedFunctionLocator: input.functionId, native: true };
    } finally { loaded.projection?.release(); }
  }
  async #block(input, work) {
    recordFields(input, ['functionId', 'blockValueId'], 'scoped-block-fields');
    const native = !this.#host.configuration.getObjcBlockContext;
    const loaded = native ? await this.#loadDemandOwner(input.functionId, work, { maximumValues: 64 }) : await this.#projection(input.functionId, work);
    if (!loaded.projection) return { status: 'unsupported', reason: loaded.reason };
    try {
      const getContext = this.#host.configuration.getObjcBlockContext ?? (() => nativeObjcBlockContext(loaded.projection, loaded.demand,
        input.blockValueId, { world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshot.snapshotId,
          work, isCurrent: () => this.#current() }));
      const value = await queryObjcBlockCaptures({ ...input, functionId: loaded.projection.functionId }, {
        world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshot.snapshotId,
        projection: loaded.projection, work, getContext });
      return { ...value, requestedFunctionLocator: input.functionId };
    } finally { loaded.projection.release(); }
  }
  async #references(method, input, work) {
    recordFields(input, method === 'referenceSlice' ? ['functionId', 'request'] : ['functionId', 'bundle'], 'scoped-reference-fields');
    const loaded = await this.#projection(input.functionId, work);
    if (!loaded.projection) return { status: 'unsupported', reason: loaded.reason };
    try {
      const options = { world: this.#world, assumptions: this.#assumptions, work,
        readRange: this.#host.readRange ?? null, isCurrent: () => this.#current() };
      return method === 'referenceSlice'
        ? await explainCanonicalReferenceSlice(loaded.projection, input.request, options)
        : await replayCanonicalReferenceSlice(loaded.projection, input.bundle, options);
    } finally { loaded.projection.release(); }
  }
  async #objects(input, work) {
    recordFields(input, ['functionId', 'valueId'], 'scoped-object-fields');
    exactString(input.valueId, 'scoped-object-value');
    if (this.#host.canonicalArchitecture === 'arm64' && !this.#host.configuration.describeObjectTarget) {
      const loaded = await this.#loadDemandOwner(input.functionId, work, { valueIds: [input.valueId], maximumValues: 1 });
      try {
        if (!loaded.projection) return { status: 'unsupported', reason: loaded.reason, exact: false };
        const row = loaded.demand.objects.find(value => value.valueId === input.valueId);
        if (!row) return { status: 'unsupported', reason: 'native-object-value-outside-owner', exact: false };
        return { status: 'completed', schema: 'object-memory-view/v1', worldId: this.#world.id,
          assumptionsId: this.#assumptions.id, functionId: loaded.projection.functionId, valueId: input.valueId,
          partitions: row.partitions, unknowns: row.unknowns, pointsToStatus: row.ownerStatus,
          producerArtifactId: loaded.projection.inputIdentity.producerArtifactId, exact: false,
          authority: 'current-points-to-and-escape-owner; no-runtime-singleton-or-strong-update-proof' };
      } finally { loaded.projection?.release(); }
    }
    const loaded = await this.#load(input.functionId, work, { kind: 'points-to', valueId: input.valueId });
    if (!loaded.pipeline) return { status: 'unsupported', reason: loaded.reason };
    const owner = this.#localView(loaded, 'points-to');
    if (!owner || owner.valueId !== input.valueId || !owner.set) return { status: 'unsupported',
      reason: owner?.reason ?? 'isolated-points-to-owner-unavailable', valueId: input.valueId };
    const pointees = owner.set;
    const value = await partitionPointsToObjects(pointees, { world: this.#world,
      assumptions: this.#assumptions, context: createObjectContext(), work,
      describeTarget: this.#host.configuration.describeObjectTarget ?? null });
    return { ...value, status: 'completed', functionId: loaded.pipeline.functionId, valueId: input.valueId,
      producerArtifactId: loaded.artifactId ?? null, pointsToStatus: owner.ownerStatus ?? null };
  }
  async #types(input, work) {
    recordFields(input, ['functionId', 'entityIds'], 'scoped-type-fields');
    const entityIds = stringSet(input.entityIds, 'scoped-type-entities', 64);
    if (!entityIds.length) contractFail('scoped-type-empty-query');
    const loaded = await this.#load(input.functionId, work, { kind: 'types', entityIds });
    if (!loaded.pipeline) return { status: 'unsupported', reason: loaded.reason };
    const owner = this.#localView(loaded, 'types');
    if (!owner?.types || owner.types.status !== 'completed') return { status: 'unsupported', reason: owner?.reason ?? 'isolated-type-owner-unavailable' };
    if (owner.types.worldId !== this.#world.id || owner.types.snapshotId !== this.#snapshot.snapshotId
      || owner.types.functionId !== loaded.pipeline.functionId || owner.types.requested.length !== entityIds.length
      || !entityIds.every((id, index) => owner.types.requested[index] === id)) contractFail('scoped-type-owner-binding');
    return { ...owner.types, requestedFunctionLocator: input.functionId, producerArtifactId: loaded.artifactId ?? null,
      assumptionsId: this.#assumptions.id, exact: false };
  }
  async #abiInputs(input, work) {
    recordFields(input, ['functionId'], 'scoped-abi-input-query-fields');
    const loaded = await this.#projection(input.functionId, work, true);
    if (!loaded.projection) return { status: 'unsupported', reason: loaded.reason };
    try {
      if (!loaded.nativeFlowInputs) return { status: 'unsupported', reason: loaded.nativeFlowReason, exact: false };
      const inputs = bindScopedFlowInputs(loaded.nativeFlowInputs, loaded.projection, {
        world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshot.snapshotId });
      return { ...inputs, status: 'completed', requestedFunctionLocator: input.functionId, exact: false };
    } finally { loaded.projection.release(); }
  }
  async #rangeCatalog(input, work) {
    recordFields(input, ['functionId', 'offset', 'limit'], 'scoped-range-catalog-fields');
    exactString(input.functionId, 'scoped-range-function');
    const loaded = await this.#load(input.functionId, work, { kind: 'range-values', world: this.#world,
      assumptions: this.#assumptions, ...(input.offset === undefined ? {} : { offset: input.offset }),
      ...(input.limit === undefined ? {} : { limit: input.limit }) });
    if (!loaded.pipeline) return { status: 'unsupported', reason: loaded.reason };
    const owner = this.#localView(loaded, 'range-values');
    if (!owner?.catalog || owner.assumptionsId !== this.#assumptions.id) return { status: 'unsupported', reason: owner?.reason ?? 'range-value-catalog-unavailable' };
    return { ...owner.catalog, status: owner.status, functionId: owner.functionId, requestedFunctionLocator: input.functionId,
      producerArtifactId: loaded.artifactId ?? null, exact: false };
  }
  async #ranges(input, work) {
    recordFields(input, ['functionId', 'request', 'ownerIdentity'], 'scoped-range-fields'); exactString(input.functionId, 'scoped-range-function');
    const getter = this.#host.configuration.getPhase8Context;
    if (!getter) {
      if (!input.ownerIdentity) return { status: 'unsupported', reason: 'range-value-catalog-owner-identity-required', exact: false };
      const loaded = await this.#load(input.functionId, work, { kind: 'ranges', request: input.request,
        world: this.#world, assumptions: this.#assumptions, ownerIdentity: input.ownerIdentity });
      if (!loaded.pipeline) return { status: 'unsupported', reason: loaded.reason };
      const owner = this.#localView(loaded, 'ranges');
      if (!owner?.ranges || owner.assumptionsId !== this.#assumptions.id) return { status: 'unsupported', reason: owner?.reason ?? 'isolated-phase8-owner-unavailable' };
      return { ...owner.ranges, requestedFunctionLocator: input.functionId, functionId: owner.functionId,
        producerArtifactId: loaded.artifactId ?? null, exact: false, published: false };
    }
    const context = await work.await((signal) => getter(input.functionId, { snapshot: this.#snapshot, signal }));
    this.#assertCurrent();
    if (!context) return { status: 'unsupported', reason: 'canonical-phase8-function-unavailable' };
    if (input.ownerIdentity != null) {
      const { canonicalAnalysisIdentity } = await work.await(() => import('../../decompiler/phase8/analysis-identity.js'));
      const { stableStringify, lossyTypeWitness } = await work.await(() => import('../../core/identity/index.js'));
      const identity = canonicalAnalysisIdentity(context);
      if (!identity.valid || stableStringify(input.ownerIdentity) !== stableStringify(identity.identity)
        || stableStringify(lossyTypeWitness(input.ownerIdentity)) !== stableStringify(lossyTypeWitness(identity.identity))) {
        return { status: 'stale', reason: 'range-value-catalog-owner-changed', values: [], exact: false };
      }
      this.#assertCurrent();
    }
    // Queries never grant publication permission to a remote caller or the AI.
    const { requestDemandRanges } = await work.await(() => import('../../decompiler/phase8/demand-range.js'));
    this.#assertCurrent();
    return requestDemandRanges(context, input.request, { world: this.#world, assumptions: this.#assumptions, work, publish: false });
  }
  async #summaries(method, input, options) {
    const dependency = this.#dependencies.capture([], { snapshotOnly: true });
    let session, prior = null;
    if (method === 'resumeSummarySlice') {
      recordFields(input, ['cursor'], 'scoped-summary-resume-fields');
      prior = this.#take(input.cursor, 'summary'); session = prior.execution;
    } else {
      this.#prune();
      if (this.#sessions.size >= this.#host.configuration.maximumSessions) return unsupported('scoped-session-cap');
      session = new ScopedSummarySliceSession({ query: input, world: this.#world, assumptions: this.#assumptions,
        snapshotId: this.#snapshot.snapshotId,
        loadLocalSummary: async (locator, { work }) => {
          const loaded = await this.#load(locator, work, { kind: 'summary' });
          if (!loaded.pipeline) return { reason: loaded.reason };
          const local = this.#localView(loaded, 'summary');
          if (!local?.summary) return { reason: local?.reason ?? 'isolated-local-summary-unavailable' };
          const projection = await buildCanonicalQueryProjection(loaded.pipeline, { world: this.#world, assumptions: this.#assumptions,
            snapshotId: this.#snapshot.snapshotId, work, sourceStatus: loaded.completeness ?? 'partial',
            producerArtifactId: loaded.artifactId ?? null, sourceLocation: loaded.scope ?? null, functionLocator: locator });
          try {
            this.#assertCurrent();
            return { summary: local.summary, projection, functionId: loaded.pipeline.functionId,
              worldId: this.#world.id, snapshotId: this.#snapshot.snapshotId, artifactId: loaded.artifactId ?? null };
          } catch (error) { projection.release(); throw error; }
        },
        getExternalModels: this.#host.configuration.getExternalModels ? ({ signal }) => this.#host.configuration.getExternalModels({
          snapshot: this.#snapshot, world: this.#world, signal }) : null,
        isCurrent: () => this.#current() && this.#dependencies.validate(dependency) });
    }
    try {
      const value = await session.step({ signal: options.signal, limits: options.limits ?? {} });
      this.#assertCurrent();
      const cursor = value.resumable ? this.#save('summary', session, prior?.dependency ?? dependency, { expires: prior?.expires ?? null }) : null;
      if (!cursor) session.close(value.resumable ? 'session-cap' : 'completed');
      return this.#envelope({ ...value, continuation: cursor ? { cursor, kind: 'summary-slice' } : null,
        resumable: Boolean(cursor), ...(value.resumable && !cursor ? { reason: 'scoped-session-cap' } : {}) });
    } catch (error) { session.close('failed'); throw error; }
  }
  async #proof(method, input, work) {
    const config = this.#host.configuration;
    const readRange = this.#host.readRange ?? null;
    if (method === 'proofSlice') {
      const graph = config.getEvidenceGraph ? await work.await((signal) => config.getEvidenceGraph({ snapshot: this.#snapshot, signal })) : null;
      this.#assertCurrent();
      if (!(graph instanceof EvidenceGraph)) return { status: 'unsupported', reason: 'canonical-evidence-graph-unavailable' };
      recordFields(input, ['roots', 'includeBytes', 'encoding'], 'scoped-proof-fields');
      if (!['canonical', 'shared-dag-v1'].includes(input.encoding ?? 'canonical')) contractFail('scoped-proof-encoding');
      const exported = await exportEvidenceCertificate({ graph, roots: input.roots, includeBytes: input.includeBytes ?? false,
        world: this.#world, assumptions: this.#assumptions, work, readRange });
      if (!exported.certificate || input.encoding !== 'shared-dag-v1') return exported;
      const certificateTransfer = await packEvidenceCertificates([exported.certificate], { world: this.#world, assumptions: this.#assumptions, work });
      this.#assertCurrent();
      if (graph.revision !== exported.certificate.graphRevision) contractFail('scoped-proof-graph-changed-during-pack');
      return { ...exported, certificate: null, certificateTransfer, encoding: 'shared-dag-v1', semantic: 'unknown', cost: work.cost() };
    }
    const certificate = input.schema === CERTIFICATE_PACK_SCHEMA
      ? (await unpackEvidenceCertificates(input, { world: this.#world, assumptions: this.#assumptions, work })).certificates : [input];
    if (certificate.length !== 1) contractFail('scoped-proof-single-replay-required');
    this.#assertCurrent();
    return replayEvidenceCertificate(certificate[0], { world: this.#world, assumptions: this.#assumptions, work, readRange,
      // The graph's presence alone is not a world-bound canonical lookup.
      resolveCanonicalNode: config.resolveCanonicalEvidence ?? null,
      checkers: config.getProofCheckers ? await work.await((signal) => config.getProofCheckers({ snapshot: this.#snapshot, signal })) : null });
  }
  close(reason = 'closed') {
    if (this.#closed) return;
    this.#closed = true; this.#investigationCache.clear();
    for (const cursor of this.#knowledgeCursors) this.#host.knowledgeOwner?.cancelScopedPage(cursor);
    this.#knowledgeCursors.clear(); clearTimeout(this.#expiryTimer); this.#expiryTimer = null; this.#lifetime.abort(new Error(`scoped-service-${reason}`));
    for (const entry of this.#sessions.values()) entry.execution.close(reason);
    this.#sessions.clear(); this.#dependencies.close();
    if (typeof this.#unregister === 'function') this.#unregister();
  }
}
