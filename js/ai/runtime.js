import { planAnalysisGoal } from '../query/planner.js';
import { PROPOSAL_DRAFT_SCHEMA } from './schema.js';
import { ContextBroker } from './context/index.js';
import { EvidenceStore } from './evidence.js';
import { HypothesisStore } from './hypothesis.js';
import { ProposalStore } from './proposals.js';
import { createAgentJobManager } from './jobs/index.js';
import { InvestigationSessionStore } from './session-core/index.js';
import { sanitizeActions, addressText, validateSchema } from './validation.js';
import { executeTurn } from './control/turn-executor.js';
import { addressExistsAsync, assertLiveBindingsUnchanged, deterministicConfidence, fallbackEvidence, presentAnswer } from './control/runtime-support.js';

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
    this.proposalStore = options.proposalStore || new ProposalStore({ evidenceStore: this.evidenceStore, binding: () => proposalBinding(this.localContext) });
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
    const hasPersistedState = (session.confirmedFindings?.length || 0) > 0 || (session.hypotheses?.length || 0) > 0;
    // Initial stores belong to one namespace for their entire lifetime (#6004).
    // Releasing the last session does not make its contents safe to reuse.
    if (!this.initialStoresClaimed && (this.initialStoresExplicit || !hasPersistedState)) {
      stores = this.initialStores;
      this.initialStoresClaimed = true;
    } else {
      const evidenceStore = new EvidenceStore(session.confirmedFindings || []);
      evidenceStore.restorePersistedConfirmed(session.confirmedFindings || []);
      const hypothesisStore = new HypothesisStore(evidenceStore, session.hypotheses || []);
      stores = { evidenceStore, hypothesisStore, proposalStore: new ProposalStore({ evidenceStore, binding: () => proposalBinding(this.localContext) }) };
    }
    this.storeNamespaces.set(key, stores);
    this.storeNamespaceOwners.set(key, String(session.id));
    return stores;
  }

  async turn(input = {}, options = {}) { return executeTurn.call(this, input, options); }
  async createJob(input = {}) { return this.jobs.create(input); }
  async runJobSlice(jobOrId, options = {}) { return this.jobs.runSlice(jobOrId, options); }
  async resumeJob(id, options = {}) { return this.jobs.resume(id, options); }

  async finalize({ request, decision, plan, activity, modelCalls, toolCalls, contextBytes, wireUsage, started, limitReason, registry, snapshot, effectiveScope, stores, signal }) {
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
    assertLiveBindingsUnchanged(this.localContext, snapshot);
    const requestedEvidence = Array.from(new Set((decision.evidenceIds || []).map(String)));
    const evidence = requestedEvidence.map((id) => evidenceStore.get(id)).filter(Boolean);
    const missingIds = requestedEvidence.filter((id) => !evidenceStore.has(id));
    if (missingIds.length) activity.push({ type: 'consistency-check', label: `${missingIds.length} 件の存在しない evidence 参照を除外`, timestamp: new Date().toISOString() });
    const finalEvidence = evidence.length ? evidence : fallbackEvidence(evidenceStore, plan);
    for (const modelHypothesis of decision.hypotheses || []) hypothesisStore.upsert(modelHypothesis);
    const hypothesisIds = new Set((decision.hypothesisIds || []).map(String));
    const hypotheses = hypothesisIds.size ? hypothesisStore.all().filter((item) => hypothesisIds.has(item.id)) : hypothesisStore.all();
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
    }
    const proposals = createProposalRecords(decision.proposals, proposalStore, activity);
    const proposalActions = proposals.map((proposal) => ({ kind: 'review-proposal', target: proposal.id }));
    const actions = sanitizeActions([...suggestedActions, ...proposalActions], { evidenceStore, proposalStore, addressExists: (address) => existence.get(address) ?? false });
    let confidence = Number.isFinite(decision.confidence) ? Math.max(0, Math.min(1, decision.confidence)) : deterministicConfidence(plan);
    if (!finalEvidence.length) confidence = Math.min(confidence, 0.5);
    const budgetReason = BUDGET_LIMIT_REASONS.has(limitReason) ? limitReason : null;
    return {
      mode: request.mode, style: request.style,
      answer: presentAnswer(String(decision.answer || ''), request.style, finalEvidence, plan), confidence, evidence: finalEvidence, hypotheses, actions,
      proposals,
      followups: (decision.followups || []).map(String).slice(0, 8), activity,
      usage: { modelCalls, toolCalls, elapsedMs: Date.now() - started, contextBytes, ...wireUsage, candidateCount: plan?.candidates?.length || 0, analyzedFunctions: plan?.stats?.analyzedFunctions || 0, disassembly: Math.max(plan?.stats?.disassembly || 0, registry.analysisStats?.disassembly || 0), toolCost: registry.accounting.cost },
      scope: { requested: request.scope, effective: effectiveScope }, turnSnapshotId: snapshot.id,
      limits: { exhausted: !!budgetReason, reason: limitReason || undefined },
    };
  }

  async releaseSession(sessionId, { deletePersisted = false } = {}) {
    if (sessionId == null) return false;
    const id = String(sessionId);
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
    binaryId: context?.binaryId == null ? null : String(context.binaryId),
    projectId: context?.projectId == null ? null : String(context.projectId),
    runtimeSessionId: context?.runtimeSessionId == null ? null : String(context.runtimeSessionId),
  };
}
