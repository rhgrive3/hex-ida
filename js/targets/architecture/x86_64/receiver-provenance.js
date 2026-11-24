// Receiver-only decoder authority is intentionally kept in a module that has
// no dependency on effect helpers.  That lets semantic owners consult the
// private brand without creating a runtime-provenance/effects import cycle.
const REVALIDATION_WORKER_PATH = '/js/targets/architecture/x86_64/semantic-revalidation-worker.js';
const PROTECTED_LOGICAL_PATH = 'js/targets/architecture/x86_64/semantic-revalidation-worker.js';

function isReceiverRevalidationRealm() {
  if (typeof WorkerGlobalScope === 'undefined' || !(globalThis instanceof WorkerGlobalScope)) return false;
  if (globalThis.__HEX_PROTECTED_WORKER_LOGICAL_PATH__ === PROTECTED_LOGICAL_PATH) return true;
  try {
    const href = globalThis.location?.href;
    if (typeof href !== 'string') return false;
    return new URL(href).pathname.endsWith(REVALIDATION_WORKER_PATH);
  } catch {
    return false;
  }
}

function lockProtectedWorkerLogicalPath() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, '__HEX_PROTECTED_WORKER_LOGICAL_PATH__');
  if (descriptor && !descriptor.configurable) return;
  try {
    Object.defineProperty(globalThis, '__HEX_PROTECTED_WORKER_LOGICAL_PATH__', {
      value: descriptor ? descriptor.value : undefined,
      writable: false,
      enumerable: Boolean(descriptor?.enumerable),
      configurable: false,
    });
  } catch {
    // globalThis may already be non-extensible or frozen.
  }
}

const RECEIVER_REVALIDATION_REALM = isReceiverRevalidationRealm();
lockProtectedWorkerLogicalPath();

const RECEIVER_REVALIDATED_ROWS = new WeakMap();

function cloneAndFreezeValue(value, snapshots, seen) {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (ArrayBuffer.isView(value)) {
    const byteCopy = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    const clonedView = value instanceof DataView
      ? new DataView(byteCopy.buffer)
      : new value.constructor(byteCopy.buffer);
    snapshots.push(Object.freeze({ view: clonedView, bytes: byteCopy.slice() }));
    seen.set(value, clonedView);
    return clonedView;
  }
  if (Array.isArray(value)) {
    const copy = new Array(value.length);
    seen.set(value, copy);
    for (let index = 0; index < value.length; index += 1) {
      if (Object.hasOwn(value, index)) {
        copy[index] = cloneAndFreezeValue(value[index], snapshots, seen);
      }
    }
    return Object.freeze(copy);
  }
  const copy = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    copy[key] = cloneAndFreezeValue(value[key], snapshots, seen);
  }
  return Object.freeze(copy);
}

function snapshotsIntact(snapshots) {
  for (let index = 0; index < snapshots.length; index += 1) {
    const { view, bytes } = snapshots[index];
    if (view.byteLength !== bytes.length) return false;
    const current = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (let offset = 0; offset < bytes.length; offset += 1) {
      if (current[offset] !== bytes[offset]) return false;
    }
  }
  return true;
}

export function registerReceiverRevalidatedX86Row(row) {
  if (row == null || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError('x86-decoder-runtime-provenance-row-required');
  }
  const snapshots = [];
  const frozenRow = cloneAndFreezeValue(row, snapshots, new Map());
  if (RECEIVER_REVALIDATION_REALM && isReceiverRevalidationRealm()) {
    RECEIVER_REVALIDATED_ROWS.set(frozenRow, Object.freeze(snapshots));
  }
  return frozenRow;
}

export function hasReceiverRevalidatedX86Row(row) {
  if (row == null || typeof row !== 'object') return false;
  const snapshots = RECEIVER_REVALIDATED_ROWS.get(row);
  if (!snapshots) return false;
  return snapshotsIntact(snapshots);
}
