import { AI_MODES, AI_SCOPES, AI_STYLES } from '../schema.js';

let sessionSequence = 1;
const MEMORY_KEYS = ['goal','anchor','confirmedFacts','activeHypotheses','rejectedHypotheses','unresolvedQuestions','userConstraints','importantPriorActions'];

export function createInvestigationMemory(input = {}) {
  return {
    goal: String(input.goal || ''),
    anchor: input.anchor && typeof input.anchor === 'object' ? { ...input.anchor } : null,
    confirmedFacts: bounded(input.confirmedFacts, 64),
    activeHypotheses: bounded(input.activeHypotheses, 48),
    rejectedHypotheses: bounded(input.rejectedHypotheses, 48),
    unresolvedQuestions: bounded(input.unresolvedQuestions, 32),
    userConstraints: bounded(input.userConstraints, 32),
    importantPriorActions: bounded(input.importantPriorActions, 48),
  };
}

export function createInvestigationSession(input = {}) {
  const now = new Date().toISOString();
  return {
    id: String(input.id || `ai_${Date.now().toString(36)}_${sessionSequence++}`),
    binaryId: input.binaryId == null ? null : String(input.binaryId),
    binaryIdentity: input.binaryIdentity && typeof input.binaryIdentity === 'object' ? { ...input.binaryIdentity } : null,
    projectId: input.projectId == null ? null : String(input.projectId),
    conversationId: input.conversationId == null ? null : String(input.conversationId),
    mode: AI_MODES.includes(input.mode) ? input.mode : 'chat',
    style: AI_STYLES.includes(input.style) ? input.style : 'analyst',
    scope: AI_SCOPES.includes(input.scope) ? input.scope : 'auto',
    effectiveScope: AI_SCOPES.includes(input.effectiveScope) ? input.effectiveScope : null,
    goal: String(input.goal || ''),
    // Store-owned session state must not share array/object references with
    // the caller's input: a post-create mutation of the caller object would
    // silently rewrite the registered session without update()/persist()
    // (#5705). Copy the owned arrays (message elements included) and their
    // element objects.
    messages: Array.isArray(input.messages) ? input.messages.slice(-100).map(cloneRecord) : [],
    summary: String(input.summary || ''), // legacy persistence only; no longer accumulates transcript data
    investigationMemory: createInvestigationMemory(input.investigationMemory || { goal: input.goal }),
    pinnedEvidence: Array.isArray(input.pinnedEvidence) ? Array.from(new Set(input.pinnedEvidence.map(String))) : [],
    hypotheses: Array.isArray(input.hypotheses) ? input.hypotheses.map(cloneRecord) : [],
    confirmedFindings: Array.isArray(input.confirmedFindings) ? input.confirmedFindings.map(cloneRecord) : [],
    rejectedHypotheses: Array.isArray(input.rejectedHypotheses) ? input.rejectedHypotheses.map(cloneRecord) : [],
    proposedActions: Array.isArray(input.proposedActions) ? input.proposedActions.map(cloneRecord) : [],
    lastActivity: input.lastActivity || null,
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
}

export class InvestigationSessionStore {
  constructor({ persistence } = {}) { this.persistence = persistence || null; this.sessions = new Map(); }

  register(session) {
    if (!session || !session.id) return null;
    const validated = createInvestigationSession(session);
    this.sessions.set(validated.id, validated);
    return validated;
  }

  async delete(id) {
    const key = String(id);
    this.sessions.delete(key);
    if (this.persistence && typeof this.persistence.delete === 'function') {
      await this.persistence.delete(key);
    }
  }

  async create(input) {
    const session = createInvestigationSession(input);
    // Durability before visibility: a failed save must not leave the session
    // in memory presenting a write that never landed (#5434).
    await this.persist(session);
    this.sessions.set(session.id, session);
    return session;
  }

  async get(id) {
    const key = String(id);
    if (this.sessions.has(key)) return this.sessions.get(key);
    if (this.persistence && typeof this.persistence.load === 'function') {
      const loaded = await this.persistence.load(key);
      if (loaded) {
        // The lookup key is the session identity, not a search hint: a record
        // whose own id differs is corrupt/stale state from an adapter or
        // migration. Adopting it would alias another session's binary,
        // project, and conversation bindings onto the requested id and let
        // later updates persist against the wrong session (#4413).
        if (typeof loaded.id !== 'string' || loaded.id !== key) return null;
        const session = createInvestigationSession(loaded);
        this.sessions.set(key, session);
        return session;
      }
    }
    return null;
  }

  async update(id, patch = {}) {
    const current = await this.get(id);
    if (!current) return null;
    const allowed = ['binaryId','binaryIdentity','projectId','conversationId','mode','style','scope','effectiveScope','goal','messages','summary','investigationMemory','pinnedEvidence','hypotheses','confirmedFindings','rejectedHypotheses','proposedActions','lastActivity'];
    // Work on a detached candidate and swap it in only after the durable save
    // succeeded: a rejected write must leave the previous canonical state
    // visible instead of a partially applied patch (#5434).
    const candidate = { ...current };
    for (const key of allowed) if (Object.prototype.hasOwnProperty.call(patch, key)) candidate[key] = key === 'investigationMemory' ? createInvestigationMemory(patch[key]) : patch[key];
    // Identity upgrades must update both representations atomically. Otherwise
    // a legacy/weak session can accept a strong hash on this turn but be
    // rejected on the next turn because binaryId still contains filename:slice.
    if (!Object.prototype.hasOwnProperty.call(patch, 'binaryId') && patch.binaryIdentity?.id) candidate.binaryId = String(patch.binaryIdentity.id);
    if (candidate.binaryId != null) candidate.binaryId = String(candidate.binaryId);
    candidate.updatedAt = new Date().toISOString();
    await this.persist(candidate);
    this.sessions.set(String(id), candidate);
    return candidate;
  }

  async updateMemory(id, patch = {}) {
    const current = await this.get(id);
    if (!current) return null;
    const next = { ...current.investigationMemory };
    for (const key of MEMORY_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      next[key] = ['goal','anchor'].includes(key) ? patch[key] : mergeUnique(next[key], patch[key]);
    }
    return this.update(id, { investigationMemory: next });
  }

  async appendMessage(id, message) {
    const current = await this.get(id);
    if (!current) return null;
    // Build the candidate without mutating the currently visible session. If
    // persistence rejects the write, the old message list must remain the
    // canonical in-memory state (#5434).
    const messages = [
      ...(Array.isArray(current.messages) ? current.messages : []),
      {
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.content || '').slice(0, 20000),
        timestamp: message.timestamp || new Date().toISOString(),
      },
    ].slice(-100);
    return this.update(id, { messages });
  }

  async persist(session) { if (this.persistence && typeof this.persistence.save === 'function') await this.persistence.save(stripSecrets(session)); }
  list(binaryId = null) { return Array.from(this.sessions.values()).filter((session) => binaryId == null || session.binaryId === String(binaryId)); }
}

export function stripSecrets(value, seen = new Set()) {
  const blocked = /api.?key|token|secret|authorization|credential/i;
  if (value && typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('Cannot strip secrets from cyclic object');
    seen.add(value);
  }
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => stripSecrets(item, seen));
  } else if (!value || typeof value !== 'object') {
    return value;
  } else {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (!blocked.test(key)) {
        Object.defineProperty(out, key, {
          value: stripSecrets(item, seen),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
    result = out;
  }
  if (value && typeof value === 'object') {
    seen.delete(value);
  }
  return result;
}

export function createProjectSessionPersistence(project, { onChange } = {}) {
  if (!project || typeof project !== 'object') throw new Error('project-required');
  project.findings ||= {}; project.findings.investigationSessions ||= [];
  return {
    list() { return project.findings.investigationSessions.slice(); },
    async load(id) { return project.findings.investigationSessions.find((session) => session && session.id === String(id)) || null; },
    async save(session) {
      const safe = stripSecrets(session);
      const index = project.findings.investigationSessions.findIndex((item) => item && item.id === safe.id);
      if (index >= 0) project.findings.investigationSessions[index] = safe; else project.findings.investigationSessions.push(safe);
      // AI session bookkeeping must not advance the semantic revision that
      // ObservationStore binds tool results to; only meaningful project
      // knowledge changes (annotations, names, comments, findings...) do.
      project.updatedAt = new Date().toISOString();
      if (project.analysisSemanticRevision == null) project.analysisSemanticRevision = project.updatedAt;
      if (typeof onChange === 'function') onChange(project, safe);
    },
    async delete(id) {
      const key = String(id);
      const index = project.findings.investigationSessions.findIndex((item) => item && String(item.id) === key);
      if (index >= 0) {
        project.findings.investigationSessions.splice(index, 1);
        project.updatedAt = new Date().toISOString();
        if (project.analysisSemanticRevision == null) project.analysisSemanticRevision = project.updatedAt;
        if (typeof onChange === 'function') onChange(project, null);
      }
    },
  };
}

function bounded(value, limit) { return Array.isArray(value) ? value.slice(-limit) : []; }

// A shallow element copy is enough to detach store-owned session arrays from
// the caller's objects: the session contract treats these records as plain
// JSON-safe data (see normalize/persist paths), never as live class instances.
function cloneRecord(value) {
  return value && typeof value === 'object' ? { ...value } : value;
}

function mergeUnique(current, incoming) {
  const values = [...bounded(current, 100), ...bounded(incoming, 100)];
  const latest = new Map();
  for (const item of values) {
    const id = typeof item === 'string' ? item : String(item?.id ?? item?.claim ?? item?.summary ?? JSON.stringify(item));
    // Refresh both the snapshot and its retention order. A recently updated
    // item must not be evicted merely because its first occurrence was old.
    latest.delete(id);
    latest.set(id, item);
  }
  return [...latest.values()].slice(-64);
}
