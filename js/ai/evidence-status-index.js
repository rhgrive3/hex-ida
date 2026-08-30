/* Incremental status index for EvidenceStore without changing its semantic authority. */
const STATE = new WeakMap();
const WRAPPED = Symbol('hex-evidence-status-index-wrapped');

function statusOf(record) { return String(record?.status || 'unknown'); }

function build(store) {
  const byStatus = new Map();
  const statusById = new Map();
  for (const [id, record] of store?.records || []) {
    const status = statusOf(record);
    let ids = byStatus.get(status);
    if (!ids) byStatus.set(status, ids = []);
    ids.push(String(id));
    statusById.set(String(id), status);
  }
  return { byStatus, statusById };
}

function rebuild(store, state) {
  const next = build(store);
  state.byStatus = next.byStatus;
  state.statusById = next.statusById;
}

function sync(store, state, record) {
  if (!record?.id) return;
  const id = String(record.id), next = statusOf(record), previous = state.statusById.get(id);
  if (previous == null) {
    let ids = state.byStatus.get(next);
    if (!ids) state.byStatus.set(next, ids = []);
    ids.push(id); state.statusById.set(id, next); return;
  }
  if (previous !== next) rebuild(store, state); // preserve canonical Map insertion order
}

function wrapAdds(store, state) {
  if (!store || store[WRAPPED] || typeof store.add !== 'function') return;
  const original = store.add;
  Object.defineProperty(store, WRAPPED, { value:true });
  Object.defineProperty(store, 'add', {
    configurable:true, writable:true,
    value:function indexedAdd(...args) {
      const record = original.apply(this, args);
      sync(this, state, record);
      return record;
    },
  });
}

export function ensureEvidenceStatusIndex(store) {
  if (!store) return null;
  let state = STATE.get(store);
  if (!state) { state = build(store); STATE.set(store, state); wrapAdds(store, state); }
  return state;
}

export function evidenceByStatus(store, status) {
  const state = ensureEvidenceStatusIndex(store);
  if (!state) return [];
  const wanted = String(status), ids = state.byStatus.get(wanted) || [], out = [];
  for (const id of ids) {
    const record = store.get?.(id) ?? store.records?.get?.(id) ?? null;
    if (record && statusOf(record) === wanted) out.push(record);
  }
  return out;
}

export function recentEvidenceByStatus(store, status, limit = 32) {
  const state = ensureEvidenceStatusIndex(store);
  if (!state) return [];
  const wanted = String(status), ids = state.byStatus.get(wanted) || [];
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  if (!cap) return [];
  const out = [];
  for (let i = Math.max(0, ids.length - cap); i < ids.length; i++) {
    const record = store.get?.(ids[i]) ?? store.records?.get?.(ids[i]) ?? null;
    if (record && statusOf(record) === wanted) out.push(record);
  }
  return out;
}
