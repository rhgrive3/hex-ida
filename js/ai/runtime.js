import { planAnalysisGoal } from '../query/planner.js';
import { PROPOSAL_DRAFT_SCHEMA } from './schema.js';
import { ContextBroker } from './context/index.js';
import { normalizePlannerTargetHint, plannerGoalWithTargetHint } from './context/planner-target-hint.js';
import { EvidenceStore } from './evidence.js';
import { HypothesisStore } from './hypothesis.js';
import { ProposalStore } from './proposals.js';
import { createAgentJobManager } from './jobs/index.js';
import { InvestigationSessionStore, isValidSessionId } from './session-core/index.js';
import { sanitizeActions, addressText, validateSchema } from './validation.js';
import { executeTurn } from './control/turn-executor.js';
import { addressExistsAsync, assertLiveBindingsUnchanged, claimedAddresses, defaultMonotonicNow, deterministicConfidence, fallbackEvidence, finalAnswerAuthorityEvidence, presentAnswer, qualifyingEvidence } from './control/runtime-support.js';
import { canonicalBindingId, resolveAnalysisRevision } from './control/snapshot.js';
import { analysisBinding } from './tools/storage/observation-store.js';

const BUDGET_LIMIT_REASONS = new Set([
  'budget_exhausted',
  'model-call-budget',
  'tool-call-budget',
  'tool-cost-budget',
]);

export class AIRuntime {
  constructor(options = {}) {
    this.localContext = options.context || {};
    this.provider = options.provider || null;
    this.sessionStore = options.sessionStore || new InvestigationSessionStore({ persistence: options.persistence });
    this.evidenceStore = options.evidenceStore || new EvidenceStore();
    this.hypothesisStore = options.hypothesisStore || new HypothesisStore(this.evidenceStore);
    this.proposalStore = options.proposalStore || new ProposalStore({
      evidenceStore: this.evidenceStore,
      binding: () => proposalBinding(this.localContext),
      currentEvidenceBinding: evidenceBindingResolver(this.evidenceStore, this.localContext),
    });
    this.initialStores = { evidenceStore: this.evidenceStore, hypothesisStore: this.hypothesisStore, proposalStore: this.proposalStore };
    this.initialStoresClaimed = false;
    this.initialStoresExplicit = options.evidenceStore != null || options.hypothesisStore != null || options.proposalStore != null;
    this.storeNamespaces = new Map();
    this.storeNamespaceOwners = new Map();
    this.contextBroker = options.contextBroker || new ContextBroker(this.localContext, options.contextOptions);
    this.planner = options.planner === false ? null : (options.planner || planAnalysisGoal);
    this.development = !!options.development;
    this.activeControllers = new Set();
    this.jobs = createAgentJobManager({ runtime: this, persistence: options.jobPersistence, maxSlices: options.maxJobSlices, maxElapsedMs: options.maxJobElapsedMs });
  }

  storesFor(session, binaryId) {
    const key = `${binaryId == null ? '<none>' : String(binaryId)}::${String(session.id)}`;
    let stores = this.storeNamespaces.get(key);
    if (stores) return stores;
    const hasPersistedState = (session.confirmedFindings?.length || 0) > 0
      || (session.hypotheses?.length || 0) > 0
      || (session.proposedActions?.length || 0) > 0;
    // Initial stores belong to one namespace for their entire lifetime (#6004).
    // Releasing the last session does not make its contents safe to reuse.
    if (!this.initialStoresClaimed && (this.initialStoresExplicit || !hasPersistedState)) {
      stores = this.initialStores;
      this.initialStoresClaimed = true;
    } else {
      const evidenceStore = new EvidenceStore(session.confirmedFindings || []);
      evidenceStore.restorePersistedConfirmed(session.confirmedFindings || []);
      const hypothesisStore = new HypothesisStore(evidenceStore, session.hypotheses || []);
      const proposalStore = new ProposalStore({
        evidenceStore,
        binding: () => proposalBinding(this.localContext),
        currentEvidenceBinding: evidenceBindingResolver(evidenceStore, this.localContext),
      });
      proposalStore.restorePersistedPending(session.proposedActions || []);
      stores = { evidenceStore, hypothesisStore, proposalStore };
    }
    this.storeNamespaces.set(key, stores);
    this.storeNamespaceOwners.set(key, String(session.id));
    return stores;
  }

  async turn(input = {}, options = {}) {
    const targetHint = input?.mode === 'agent' ? normalizePlannerTargetHint(input.untrustedTarget) : null;
    if (!targetHint || !this.planner || input.planner === false) return executeTurn.call(this, input, options);

    // Contextual binary data stays out of the trusted user goal. Bind it only
    // to this turn's deterministic planner so concurrent turns cannot share or
    // overwrite target state (#4288).
    const sourcePlanner = this.planner;
    const turnRuntime = {
      localContext: this.localContext,
      provider: this.provider,
      sessionStore: this.sessionStore,
      contextBroker: this.contextBroker,
      activeControllers: this.activeControllers,
      evidenceStore: this.evidenceStore,
      hypothesisStore: this.hypothesisStore,
      proposalStore: this.proposalStore,
      planner: (goal, context, plannerOptions) => sourcePlanner.call(
        this,
        plannerGoalWithTargetHint(goal, input.untrustedTarget),
        context,
        plannerOptions,
      ),
      storesFor: (...args) => this.storesFor(...args),
      finalize: (...args) => this.finalize(...args),
    };
    const routedInput = input.intent == null ? { ...input, intent: 'find-behaviour' } : input;
    try {
      return await executeTurn.call(turnRuntime, routedInput, options);
    } finally {
      // Keep the existing post-turn introspection projection on AIRuntime.
      this.evidenceStore = turnRuntime.evidenceStore;
      this.hypothesisStore = turnRuntime.hypothesisStore;
      this.proposalStore = turnRuntime.proposalStore;
    }
  }
  // Optional first-party setup only. Does not create/load a job, bind a fresh
  // evidence namespace, enable SCPA or perform an investigation action.
  async createScopedInvestigationProvider(options = {}) {
    const { createScopedJobContextProvider } = await import('./investigation/scoped-job-context.js');
    return createScopedJobContextProvider(this, options);
  }

  async createJob(input = {}) { return this.jobs.create(input); }
  async runJobSlice(jobOrId, options = {}) { return this.jobs.runSlice(jobOrId, options); }
  async resumeJob(id, options = {}) { return this.jobs.resume(id, options); }

  async finalize({ request, decision, plan, activity, modelCalls, toolCalls, contextBytes, wireUsage, started, monotonicNow = defaultMonotonicNow, limitReason, registry, snapshot, effectiveScope, stores, signal, assertFresh = null, providerControlledDecision = false }) {
    // Store authority comes from the turn's captured namespace, never from the
    // shared fields: a concurrent turn re-points `this.*Store` across awaits
    // and would otherwise swap this turn's evidence/hypothesis/proposal
    // mid-finalize (#6216). Fall back to the shared view only for direct
    // finalize() calls without a turn context (e.g. tests).
    const evidenceStore = stores?.evidenceStore ?? this.evidenceStore;
    const hypothesisStore = stores?.hypothesisStore ?? this.hypothesisStore;
    const proposalStore = stores?.proposalStore ?? this.proposalStore;
    // The final model call can overlap a workbench binary/project/runtime switch
    // without another tool execution. Re-check the turn binding before any
    // live-context validation (notably suggested action addresses) so finalization
    // cannot mix a snapshotted investigation with the newly visible binary.
    const assertFinalFresh = typeof assertFresh === 'function'
      ? assertFresh
      : () => assertLiveBindingsUnchanged(this.localContext, snapshot);
    assertFinalFresh();
    const requestedEvidence = Array.from(new Set((decision.evidenceIds || []).map(String)));
    const hasExplicitEvidenceSelection = requestedEvidence.length > 0;
    const evidence = requestedEvidence.map((id) => evidenceStore.get(id)).filter(Boolean);
    const missingIds = requestedEvidence.filter((id) => !evidenceStore.has(id));
    if (missingIds.length) activity.push({ type: 'consistency-check', label: `${missingIds.length} 件の存在しない evidence 参照を除外`, timestamp: new Date().toISOString() });
    // A non-empty model citation set is authoritative: if none of those IDs
    // resolve, never silently bind an unrelated deterministic/store fallback.
    const finalEvidence = evidence.length
      ? evidence
      : hasExplicitEvidenceSelection
        ? []
        : fallbackEvidence(evidenceStore, plan);
    for (const modelHypothesis of decision.hypotheses || []) hypothesisStore.upsert(modelHypothesis);
    const hasExplicitHypothesisSelection = Array.isArray(decision.hypothesisIds);
    const hypothesisIds = new Set((decision.hypothesisIds || []).map(String));
    const hypotheses = hasExplicitHypothesisSelection
      ? hypothesisStore.all().filter((item) => hypothesisIds.has(item.id))
      : hypothesisStore.all();
    const suggestedActions = Array.isArray(decision.suggestedActions) ? decision.suggestedActions : [];
    // Suggested actions must respect an async-only `addressExists`: resolve the
    // authority for every candidate target before sanitizing, so a `false`
    // cannot be dropped by the synchronous wrapper (#5790).
    const candidateAddresses = [...new Set(suggestedActions
      .map((value) => addressText(value?.target ?? value?.address ?? value?.functionAddress))
      .filter((value) => value != null))];
    const existence = new Map();
    for (const address of candidateAddresses) {
      existence.set(address, await addressExistsAsync(this.localContext, address, signal));
      assertFinalFresh();
    }
    // Address validation may await a workbench switch. Re-prove the captured
    // turn binding before ProposalStore reads live context to bind new drafts.
    assertFinalFresh();
    const proposals = createProposalRecords(decision.proposals, proposalStore, activity);
    const proposalActions = proposals.map((proposal) => ({ kind: 'review-proposal', target: proposal.id }));
    const actions = sanitizeActions([...suggestedActions, ...proposalActions], { evidenceStore, proposalStore, addressExists: (address) => existence.get(address) ?? false });
    let confidence = Number.isFinite(decision.confidence) ? Math.max(0, Math.min(1, decision.confidence)) : deterministicConfidence(plan);
    // Evidence exposure and confidence authority are separate contracts. A
    // current supported record may remain attached for provenance, whether it
    // came from an explicit citation or planner fallback, but only qualifying
    // authority may lift the no-authority confidence cap (#8864). #5159's
    // invalid-explicit-citation no-substitution rule remains unchanged above.
    // A genuinely `verified` record is only authority for the subject it proves:
    // citing an authentic `0x1000` proof must not terminalise an unrelated claim
    // about `0xDEAD` (#9009), which is the same trust boundary HypothesisStore
    // already enforces for model-created hypotheses.
    const claimAddresses = claimedAddresses(decision.answer, request.goal);
    const authorityEvidence = finalAnswerAuthorityEvidence(finalEvidence, claimAddresses, {
      providerControlled: providerControlledDecision,
      // A provider that made no explicit citation may still consume the exact
      // verified record set bound to this turn's deterministic plan (#8864).
      // This is Hex-owned fallback authority, not model-selected session state.
      allowAddressFreeDeterministicFallback: providerControlledDecision
        && !hasExplicitEvidenceSelection
        && plan != null
        && typeof plan === 'object',
    });
    if (authorityEvidence.length < finalEvidence.filter((item) => item?.status === 'verified').length) {
      activity.push({ type: 'consistency-check', label: '引用された検証済み記録が最終回答の主張住所を証明していないため、権限を付与せず根拠提示のみとしました', timestamp: new Date().toISOString() });
    }
    const evidenceSatisfiesAuthority = authorityEvidence.length > 0;
    if (!evidenceSatisfiesAuthority) confidence = Math.min(confidence, 0.5);
    const budgetReason = BUDGET_LIMIT_REASONS.has(limitReason) ? limitReason : null;
    const elapsedNow = typeof monotonicNow === 'function' ? monotonicNow() : defaultMonotonicNow();
    const elapsedMs = Number.isFinite(elapsedNow) && Number.isFinite(started)
      ? Math.max(0, elapsedNow - started)
      : 0;
    return {
      mode: request.mode, style: request.style,
      answer: presentAnswer(String(decision.answer || ''), request.style, finalEvidence, plan, claimAddresses, authorityEvidence), confidence, evidence: finalEvidence, hypotheses, actions,
      proposals,
      followups: (decision.followups || []).map(String).slice(0, 8), activity,
      usage: { modelCalls, toolCalls, elapsedMs, contextBytes, ...wireUsage, candidateCount: plan?.candidates?.length || 0, analyzedFunctions: plan?.stats?.analyzedFunctions || 0, disassembly: Math.max(plan?.stats?.disassembly || 0, registry.analysisStats?.disassembly || 0), toolCost: registry.accounting.cost },
      scope: { requested: request.scope, effective: effectiveScope }, turnSnapshotId: snapshot.id,
      limits: { exhausted: !!budgetReason, reason: limitReason || undefined },
    };
  }

  async releaseSession(sessionId, { deletePersisted = false } = {}) {
    if (!isValidSessionId(sessionId)) return false;
    const id = sessionId;
    for (const [key, ownerId] of Array.from(this.storeNamespaceOwners.entries())) {
      if (ownerId !== id) continue;
      this.storeNamespaces.delete(key);
      this.storeNamespaceOwners.delete(key);
    }
    if (deletePersisted) await this.sessionStore.delete(id);
    else this.sessionStore.sessions?.delete?.(id);
    return true;
  }

  cancel() { for (const controller of this.activeControllers) controller.abort('cancelled'); this.activeControllers.clear(); if (this.provider && typeof this.provider.cancel === 'function') this.provider.cancel(); }
}

function createProposalRecords(rawDrafts, proposalStore, activity) {
  const created = [];
  for (const raw of Array.isArray(rawDrafts) ? rawDrafts.slice(0, 8) : []) {
    const draft = normalizeProposalDraft(raw);
    if (!draft) {
      activity.push({ type: 'proposal-rejected', label: '変更提案を形式境界で除外', errorType: 'invalid_tool_call' });
      continue;
    }
    try {
      created.push(proposalStore.create(draft));
    } catch (error) {
      // Evidence, structured-clone, binding, and stale-state checks remain
      // owned by ProposalStore. A bad model draft must not turn into a
      // mutation or discard an otherwise valid final answer.
      activity.push({ type: 'proposal-rejected', label: '変更提案を根拠境界で除外', errorType: error?.type || 'invalid_tool_call' });
    }
  }
  return created;
}

function normalizeProposalDraft(value) {
  if (!validateSchema(value, PROPOSAL_DRAFT_SCHEMA).ok) return null;
  if (!isPlainObject(value) || value.before === undefined || value.after === undefined) return null;
  const target = value.target;
  if (typeof target === 'string' ? !target : !isPlainObject(target) || Object.keys(target).length === 0) return null;
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.some((id) => typeof id !== 'string' || !id)) return null;
  if (value.reason != null && typeof value.reason !== 'string') return null;
  return {
    kind: value.kind,
    target,
    before: value.before,
    after: value.after,
    evidenceIds: [...value.evidenceIds],
    ...(value.reason == null ? {} : { reason: value.reason }),
  };
}

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function createAIRuntime(options) { return new AIRuntime(options); }

function proposalBinding(context) {
  return {
    binaryId: canonicalBindingId(context?.binaryId),
    projectId: canonicalBindingId(context?.projectId),
    runtimeSessionId: canonicalBindingId(context?.runtimeSessionId),
    // `analysisRevision` is part of the proposal's identity: a proposal created
    // against r1 must not apply after the analysis moved to r2 (#8929).
    analysisRevision: canonicalBindingId(resolveAnalysisRevision(context)),
  };
}

/**
 * Resolve the canonical binding key that authority-bearing evidence must still
 * carry. The EvidenceStore's own ObservationStore is the exact store that
 * minted the current turn's provenance, so it wins; `analysisBinding()` on the
 * live context is the fallback for stores that have not been turn-wired yet.
 */
function evidenceBindingResolver(evidenceStore, context) {
  const store = evidenceStore?.observationStore;
  if (store && typeof store.binding === 'function') return () => store.binding().key;
  // Custom evidence adapters predate revision-bound provenance. Do not
  // silently upgrade them into a resolver-backed authority contract. First-
  // party EvidenceStore instances retain the live-context fallback (#8929).
  if (!(evidenceStore instanceof EvidenceStore)) return null;
  return () => analysisBinding(context).key;
}
