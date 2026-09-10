function cloneEventValue(value, seen = new Map()) {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const item of value) out.push(cloneEventValue(item, seen));
    return out;
  }
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      return new DataView(buffer);
    }
    return new value.constructor(value);
  }
  if (value instanceof Map) {
    const out = new Map();
    seen.set(value, out);
    for (const [key, item] of value) out.set(cloneEventValue(key, seen), cloneEventValue(item, seen));
    return out;
  }
  if (value instanceof Set) {
    const out = new Set();
    seen.set(value, out);
    for (const item of value) out.add(cloneEventValue(item, seen));
    return out;
  }

  const out = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  seen.set(value, out);
  for (const [key, item] of Object.entries(value)) out[key] = cloneEventValue(item, seen);
  return out;
}

function ownedEventValue(value) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch { /* fall through */ }
  }
  return cloneEventValue(value);
}

function freezeEventValue(value, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (value instanceof Map) {
    for (const [key, item] of value) {
      freezeEventValue(key, seen);
      freezeEventValue(item, seen);
    }
    return Object.freeze(value);
  }
  if (value instanceof Set) {
    for (const item of value) freezeEventValue(item, seen);
    return Object.freeze(value);
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  for (const item of Object.values(value)) freezeEventValue(item, seen);
  return Object.freeze(value);
}

function snapshotEventValue(value) {
  return freezeEventValue(ownedEventValue(value));
}

export function createSchedulerEventBuffer({ capacity = 128 } = {}) {
  const numericString = typeof capacity === 'string' && /^[+-]?\d+$/.test(capacity.trim());
  if (typeof capacity !== 'number' && typeof capacity !== 'bigint' && !numericString) {
    throw new RangeError("capacity must be an integer in [1, 4096]");
  }
  const cap = Number(capacity);
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 4096) {
    throw new RangeError("capacity must be an integer in [1, 4096]");
  }
  const items = [];
  let droppedCount = 0;
  return Object.freeze({
    onEvent(event) {
      if (items.length >= cap) {
        items.shift();
        droppedCount++;
      }
      const details = snapshotEventValue(event.details ?? {});
      const item = Object.freeze({ ...event, details });
      items.push(item);
    },
    snapshot() {
      // Return a detached snapshot as well as storing one. Deep-frozen plain
      // objects/arrays reject mutation, while mutable built-ins (Map/typed
      // arrays) still cannot mutate the buffer because this graph is owned.
      return snapshotEventValue(items);
    },
    clear() {
      items.length = 0;
    },
    get size() {
      return items.length;
    },
    get dropped() {
      return droppedCount;
    },
  });
}
