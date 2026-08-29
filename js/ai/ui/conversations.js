/*
 * Conversations: the state behind "New chat" and the recent-chat list.
 *
 * A conversation owns everything a turn was asked under — transcript, mode,
 * style, scope and the provider/model selection — so switching chats is a
 * pointer change, never a replay. The id is stable and travels to the engine
 * as `conversationId`, which is what binds a UI chat to a runtime session.
 *
 * Persistence is deliberately small: the UI transcript only, bounded by
 * conversation count, turn count and text length, bucketed per binary so one
 * binary never shows another binary's chat. Evidence and binary data are never
 * copied into storage — a restored turn renders as its answer text.
 *
 * Pure module — no DOM. Tested by tests/ai-ui-conversations.mjs.
 */
import { normalizeResponse } from '../render/normalize.js';

export const MAX_CONVERSATIONS = 20;
export const MAX_PERSISTED_TURNS = 40;
export const MAX_PERSISTED_TEXT = 4000;
export const MAX_TITLE = 28;
export const LEGACY_STORAGE_KEY = 'hex.ai.conversations.v1';
export const STORAGE_KEY = 'hex.ai.conversations.v2';

let counter = 0;
/** Ids stay unique inside a page even when two conversations are made in the same millisecond. */
export function newConversationId() {
  counter += 1;
  return 'c-' + Date.now().toString(36) + '-' + counter.toString(36);
}

export function createConversation(fields = {}) {
  const now = Date.now();
  return {
    id: fields.id || newConversationId(),
    title: String(fields.title || ''),
    createdAt: fields.createdAt || now,
    updatedAt: fields.updatedAt || now,
    turns: Array.isArray(fields.turns) ? fields.turns : [],
    mode: fields.mode || 'chat',
    style: fields.style || 'beginner',
    scope: fields.scope || 'auto',
    provider: fields.provider || null,
    model: fields.model || null,
    reasoning: fields.reasoning || null,
    namespace: fields.namespace == null ? null : String(fields.namespace),
    busy: false,
    controller: null,
    lastQuestion: fields.lastQuestion || null,
  };
}

/**
 * A title from the first question, without an LLM call.
 *
 * Truncation is the whole trick: a question already says what the chat is
 * about, so the list only needs its head, with the trailing question mark
 * dropped because every row would otherwise end the same way.
 */
export function deriveTitle(question) {
  const text = String(question || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const head = text.split(/[\n。．.!?！？]/)[0].trim() || text;
  const clean = head.replace(/[？?！!、,。．.\s]+$/, '');
  const source = clean || head;
  return source.length > MAX_TITLE ? source.slice(0, MAX_TITLE - 1) + '…' : source;
}

export function conversationTitle(conversation, ja = true) {
  if (conversation && conversation.title) return conversation.title;
  return ja ? '新しいチャット' : 'New chat';
}

/* ── persistence ────────────────────────────────────────────── */

function serializeTurn(turn) {
  const base = { role: turn.role, mode: turn.mode, style: turn.style, scope: turn.scope, at: turn.at || Date.now() };
  if (turn.role === 'user') return { ...base, text: String(turn.text || '').slice(0, MAX_PERSISTED_TEXT) };
  const answer = turn.response && turn.response.answerText ? turn.response.answerText : turn.text;
  return { ...base, status: turn.status === 'running' ? 'cancelled' : turn.status, text: String(answer || '').slice(0, MAX_PERSISTED_TEXT) };
}

function reviveTurn(raw, index) {
  const mode = raw.mode || 'chat';
  const style = raw.style || 'beginner';
  const scope = raw.scope || 'auto';
  const text = String(raw.text || '');
  const base = { id: 'r' + index + '-' + Math.random().toString(36).slice(2, 7), mode, style, scope, at: raw.at || Date.now() };
  if (raw.role === 'user') return { ...base, role: 'user', text };
  return {
    ...base, role: 'assistant', status: raw.status === 'running' ? 'cancelled' : (raw.status || 'done'),
    effectiveScope: scope, activity: [], error: null, text: '',
    response: text ? normalizeResponse({ answer: text }, { mode, style }) : null,
  };
}

export function serializeConversation(conversation) {
  return {
    id: conversation.id, title: conversation.title,
    createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
    mode: conversation.mode, style: conversation.style, scope: conversation.scope,
    provider: conversation.provider, model: conversation.model, reasoning: conversation.reasoning,
    turns: conversation.turns.slice(-MAX_PERSISTED_TURNS).map(serializeTurn),
  };
}

export function reviveConversation(raw, namespace) {
  const turns = Array.isArray(raw && raw.turns) ? raw.turns.map(reviveTurn) : [];
  return createConversation({ ...raw, turns, namespace });
}

/**
 * Bounded localStorage for chat history.
 *
 * `namespace()` is read late, so a binary switch writes to a different bucket
 * instead of merging two binaries' chats. A storage failure (private mode, a
 * full quota) is not an error the user should ever see: history is a
 * convenience, the live conversation lives in memory.
 */
const MAX_NAMESPACES = 6;
const INDEX_KEY = 'hex.ai.conversations.v2.index';

export function createConversationStore({ namespace, storage, key = STORAGE_KEY } = {}) {
  const backing = () => {
    if (storage) return storage;
    try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
  };
  const currentNamespace = () => {
    let value = null;
    try { value = typeof namespace === 'function' ? namespace() : namespace; } catch { value = null; }
    return value == null || value === '' ? 'default' : String(value);
  };
  const bucketKey = (space) => `${key}.${space}`;

  const readIndex = () => {
    const store = backing();
    if (!store) return {};
    try {
      const raw = store.getItem(key === STORAGE_KEY ? INDEX_KEY : `${key}.index`);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  };

  const writeIndex = (index) => {
    const store = backing();
    if (!store) return false;
    try {
      store.setItem(key === STORAGE_KEY ? INDEX_KEY : `${key}.index`, JSON.stringify(index));
      return true;
    } catch { return false; }
  };

  const migrateLegacyIfNeeded = () => {
    const store = backing();
    if (!store) return;
    try {
      const legacyRaw = store.getItem(LEGACY_STORAGE_KEY);
      if (!legacyRaw) return;
      const legacyAll = JSON.parse(legacyRaw);
      if (legacyAll && typeof legacyAll === 'object') {
        const index = readIndex();
        for (const [sp, list] of Object.entries(legacyAll)) {
          if (Array.isArray(list) && list.length) {
            const bk = bucketKey(sp);
            if (!store.getItem(bk)) {
              store.setItem(bk, JSON.stringify(list));
              index[sp] = lastTouched(list);
            }
          }
        }
        writeIndex(index);
        store.removeItem(LEGACY_STORAGE_KEY);
      }
    } catch { /* best effort */ }
  };

  return {
    get key() {
      return bucketKey(currentNamespace());
    },
    namespace: currentNamespace,
    available: () => !!backing(),
    load(space = currentNamespace()) {
      const store = backing();
      if (!store) return [];
      migrateLegacyIfNeeded();
      try {
        const raw = store.getItem(bucketKey(space));
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed.map((item) => reviveConversation(item, space));
        }
        const legacyRaw = store.getItem(LEGACY_STORAGE_KEY);
        if (legacyRaw) {
          const parsed = JSON.parse(legacyRaw);
          if (parsed && typeof parsed === 'object' && Array.isArray(parsed[space])) {
            return parsed[space].map((item) => reviveConversation(item, space));
          }
        }
      } catch { return []; }
      return [];
    },
    save(conversations, space = currentNamespace()) {
      const store = backing();
      if (!store) return false;
      migrateLegacyIfNeeded();
      const keep = conversations
        .filter((item) => item.turns.length)
        .slice(-MAX_CONVERSATIONS)
        .map(serializeConversation);

      const bk = bucketKey(space);
      const index = readIndex();
      try {
        if (keep.length) {
          store.setItem(bk, JSON.stringify(keep));
          index[space] = lastTouched(keep);
        } else {
          store.removeItem(bk);
          delete index[space];
        }
      } catch { return false; }

      const spaces = Object.keys(index);
      if (spaces.length > MAX_NAMESPACES) {
        const ranked = spaces
          .filter((name) => name !== space)
          .sort((a, b) => (index[a] || 0) - (index[b] || 0));
        for (const name of ranked.slice(0, spaces.length - MAX_NAMESPACES)) {
          delete index[name];
          try { store.removeItem(bucketKey(name)); } catch { /* best effort */ }
        }
      }
      writeIndex(index);
      return true;
    },
    clear() {
      const store = backing();
      if (!store) return;
      try {
        const index = readIndex();
        for (const space of Object.keys(index)) {
          try { store.removeItem(bucketKey(space)); } catch { /* best effort */ }
        }
        store.removeItem(INDEX_KEY);
        store.removeItem(LEGACY_STORAGE_KEY);
      } catch { /* best effort */ }
    },
  };
}

function lastTouched(bucket) {
  if (!Array.isArray(bucket) || !bucket.length) return 0;
  return bucket.reduce((max, item) => Math.max(max, item.updatedAt || 0), 0);
}

export default { createConversation, createConversationStore, deriveTitle, conversationTitle };
