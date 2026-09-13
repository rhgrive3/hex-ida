import { AI_MODES, AI_SCOPES, AI_STYLES } from '../schema.js';

let sessionSequence = 1;
const MEMORY_KEYS = ['goal','anchor','confirmedFacts','activeHypotheses','rejectedHypotheses','unresolvedQuestions','userConstraints','importantPriorActions'];

export function isValidSessionId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireSessionId(value) {
  if (!isValidSessionId(value)) throw new TypeError('AI session id must be a non-empty string');
  return value;
}


function requireBindingId(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new TypeError(`AI ${field} must be a non-empty string or null`);
  const text = value.trim();
  if (!text) throw new TypeError(`AI ${field} must be a non-empty string or null`);
  return text;
}

function isBindingIdError(error) {
  return error instanceof TypeError && /^AI (binaryId|projectId) must be a non-empty string or null$/.test(error.message);
}

export function createInvestigationMemory(input = {}) {
  return {
    goal: String(input.goal || ''),
    anchor: input.anchor && typeof input.anchor === 'object' ? cloneOwned(input.anchor) : null,
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
  const hasExplicitId = input.id != null;
  return {
    id: hasExplicitId ? requireSessionId(input.id) : `ai_${Date.now().toString(36)}_${sessionSequence++}`,
    binaryId: requireBindingId(input.binaryId, 'binaryId'),
    binaryIdentity: input.binaryIdentity && typeof input.binaryIdentity === 'object' ? cloneOwned(input.binaryIdentity) : null,
    projectId: requireBindingId(input.projectId, 'projectId'),
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
    lastActivity: cloneOwned(input.lastActivity || null),
    createdAt: cloneOwned(input.createdAt || now),
    updatedAt: now,
  };
}

export class InvestigationSessionStore {
  constructor({ persistence } = {}) {
    this.persistence = persistence || null;
    this.sessions = new Map();
    this.creating = new Map();
    this.publishing = new Set();
    /* Per-session persistence write ordering (#5556): the read-modify-write,
       durable save, and visibility swap of one session are serialized behind a
       per-id queue, so a slow older save can never commit (or swap) after a
       newer one. Sessions with different ids stay concurrent. The queue tail
       never rejects: one failed save must not stall later updates. */
    this.saveQueues = new Map();
  }

  enqueueSessionWrite(key, operation) {
    const previous = this.saveQueues.get(key) || Promise.resolve();
    const run = previous.then(operation, operation);
    const tail = run.catch(() => {});
    this.saveQueues.set(key, tail);
    tail.then(() => { if (this.saveQueues.get(key) === tail) this.saveQueues.delete(key); });
    return run;
  }

  register(session) {
    if (!session || !isValidSessionId(session.id)) return null;
    // Preserve the historical map/value identity contract while ensuring the
    // published record cannot mutate the store behind the controlled APIs.
    const validated = freezeOwned(createInvestigationSession(session));
    this.sessions.set(validated.id, validated);
    return validated;
  }

  async delete(id) {
    if (!isValidSessionId(id)) return false;
    const key = id;
    // A queued delete ends this identity generation. Later creates may reserve
    // a new generation, but still wait for this durable deletion in saveQueues.
    this.creating.delete(key);
    return this.enqueueSessionWrite(key, async () => {
      // Delete follows earlier saves in the same queue. Preserve the visible
      // record until durable deletion succeeds, including a failed delete
      // immediately after an in-flight update (#4450, #5556).
      if (this.persistence && typeof this.persistence.delete === 'function') {
        await this.persistence.delete(key);
      }
      this.sessions.delete(key);
    });
  }

  async create(input) {
    // Persistence and visibility both receive the same detached immutable
    // record; a caller cannot mutate either side between the two steps.
    const session = freezeOwned(createInvestigationSession(input));
    const id = session.id;
    if (this.creating.has(id)) throw new Error(`AI session id already exists: ${id}`);
    // Reserve synchronously, before the queue or persistence yields. A delete
    // can release this generation while its queued write is still pending.
    const reservation = {};
    this.creating.set(id, reservation);
    return this.enqueueSessionWrite(id, async () => {
      this.publishing.add(id);
      try {
        if (this.sessions.has(id)) throw new Error(`AI session id already exists: ${id}`);
        // Probe inside the canonical write queue so an earlier delete completes
        // before claiming its slot. Even malformed non-null state owns the ID.
        if (this.persistence && typeof this.persistence.load === 'function') {
          const existing = await this.persistence.load(id);
          if (existing != null) throw new Error(`AI session id already exists: ${id}`);
        }
        if (this.sessions.has(id)) throw new Error(`AI session id already exists: ${id}`);
        // Durability before visibility (#5434), ordered with every update/delete.
        await this.persist(session);
        this.sessions.set(id, session);
        return session;
      } finally {
        this.publishing.delete(id);
        if (this.creating.get(id) === reservation) this.creating.delete(id);
      }
    });
  }

  async get(id) {
    if (!isValidSessionId(id)) return null;
    const key = id;
    if (this.sessions.has(key)) return this.sessions.get(key);
    // A persistence adapter may stage a record before its save resolves.
    // The creating operation owns publication of that ID until durability.
    // A queued delete may release its reservation, but not this active writer.
    if (this.creating.has(key) || this.publishing.has(key)) return null;
    if (this.persistence && typeof this.persistence.load === 'function') {
      const loaded = await this.persistence.load(key);
      if (this.sessions.has(key)) return this.sessions.get(key);
      if (this.creating.has(key) || this.publishing.has(key)) return null;
      if (loaded) {
        // The lookup key is the session identity, not a search hint: a record
        // whose own id differs is corrupt/stale state from an adapter or
        // migration. Adopting it would alias another session's binary,
        // project, and conversation bindings onto the requested id and let
        // later updates persist against the wrong session (#4413).
        if (typeof loaded.id !== 'string' || loaded.id !== key) return null;
        let session;
        try { session = createInvestigationSession(loaded); }
        catch (error) {
          // Persisted binding identities are an authority boundary. Quarantine
          // malformed/coercible identities rather than laundering them into
          // the requested binary/project namespace (#4301).
          if (isBindingIdError(error)) return null;
          throw error;
        }
        if (session.id !== key) return null;
        const owned = freezeOwned(session);
        this.sessions.set(key, owned);
        return owned;
      }
    }
    return null;
  }

  async update(id, patch = {}) {
    if (!isValidSessionId(id)) return null;
    const key = id;
    return this.enqueueSessionWrite(key, () => this.applyUpdate(key, patch));
  }

  async updateMemory(id, patch = {}) {
    if (!isValidSessionId(id)) return null;
    const key = id;
    return this.enqueueSessionWrite(key, async () => {
      const current = await this.get(key);
      if (!current) return null;
      const next = { ...current.investigationMemory };
      for (const memoryKey of MEMORY_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(patch, memoryKey)) continue;
        next[memoryKey] = ['goal','anchor'].includes(memoryKey) ? patch[memoryKey] : mergeUnique(next[memoryKey], patch[memoryKey]);
      }
      return this.applyUpdate(key, { investigationMemory: next });
    });
  }

  async appendMessage(id, message) {
    if (!isValidSessionId(id)) return null;
    const key = id;
    return this.enqueueSessionWrite(key, async () => {
      const current = await this.get(key);
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
      return this.applyUpdate(key, { messages });
    });
  }

  async applyUpdate(id, patch = {}) {
    const current = await this.get(id);
    if (!current) return null;
    const allowed = ['binaryId','binaryIdentity','projectId','conversationId','mode','style','scope','effectiveScope','goal','messages','summary','investigationMemory','pinnedEvidence','hypotheses','confirmedFindings','rejectedHypotheses','proposedActions','lastActivity'];
    // Work on a detached candidate and swap it in only after the durable save
    // succeeded: a rejected write must leave the previous canonical state
    // visible instead of a partially applied patch (#5434).
    const candidate = cloneOwned(current);
    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      candidate[key] = key === 'investigationMemory' ? createInvestigationMemory(patch[key]) : cloneOwned(patch[key]);
    }
    // Identity upgrades must update both representations atomically. Otherwise
    // a legacy/weak session can accept a strong hash on this turn but be
    // rejected on the next turn because binaryId still contains filename:slice.
    if (!Object.prototype.hasOwnProperty.call(patch, 'binaryId') && patch.binaryIdentity?.id != null) {
      candidate.binaryId = requireBindingId(patch.binaryIdentity.id, 'binaryId');
    }
    candidate.binaryId = requireBindingId(candidate.binaryId, 'binaryId');
    candidate.projectId = requireBindingId(candidate.projectId, 'projectId');
    // update() is a second session-construction boundary, not a raw object
    // patcher. Re-run the same canonicalizer used by create/register/load so
    // enum and collection invariants cannot be bypassed by a later patch
    // (#4584). createInvestigationSession preserves candidate.createdAt and
    // refreshes updatedAt while normalizing every persisted field.
    const ownedCandidate = freezeOwned(createInvestigationSession(candidate));
    await this.persist(ownedCandidate);
    this.sessions.set(id, ownedCandidate);
    return ownedCandidate;
  }

  async persist(session) { if (this.persistence && typeof this.persistence.save === 'function') await this.persistence.save(stripSecrets(session)); }
  list(binaryId = null) {
    if (binaryId == null) return Array.from(this.sessions.values());
    let bindingId;
    try { bindingId = requireBindingId(binaryId, 'binaryId'); }
    catch (error) { if (isBindingIdError(error)) return []; throw error; }
    return Array.from(this.sessions.values()).filter((session) => session.binaryId === bindingId);
  }
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
    async load(id) {
      if (!isValidSessionId(id)) return null;
      return project.findings.investigationSessions.find((session) => session && session.id === id) || null;
    },
    async save(session) {
      const id = requireSessionId(session?.id);
      const safe = stripSecrets(session);
      const index = project.findings.investigationSessions.findIndex((item) => item && item.id === id);
      if (index >= 0) project.findings.investigationSessions[index] = safe; else project.findings.investigationSessions.push(safe);
      // AI session bookkeeping must not advance the semantic revision that
      // ObservationStore binds tool results to; only meaningful project
      // knowledge changes (annotations, names, comments, findings...) do.
      project.updatedAt = new Date().toISOString();
      if (project.analysisSemanticRevision == null) project.analysisSemanticRevision = project.updatedAt;
      if (typeof onChange === 'function') onChange(project, safe);
    },
    async delete(id) {
      if (!isValidSessionId(id)) return false;
      const key = id;
      const index = project.findings.investigationSessions.findIndex((item) => item && item.id === key);
      if (index >= 0) {
        project.findings.investigationSessions.splice(index, 1);
        project.updatedAt = new Date().toISOString();
        if (project.analysisSemanticRevision == null) project.analysisSemanticRevision = project.updatedAt;
        if (typeof onChange === 'function') onChange(project, null);
      }
    },
  };
}

function bounded(value, limit) { return Array.isArray(value) ? value.slice(-limit).map((item) => cloneOwned(item)) : []; }

function cloneRecord(value) {
  return cloneOwned(value);
}

function cloneOwned(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const item of value) out.push(cloneOwned(item, seen));
    return out;
  }
  const out = {};
  seen.set(value, out);
  for (const key of Object.keys(value)) {
    Object.defineProperty(out, key, {
      value: cloneOwned(value[key], seen),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
}

function freezeOwned(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) freezeOwned(descriptor.value, seen);
  }
  return Object.freeze(value);
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
