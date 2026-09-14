import { DebugAdapterError } from '../debug/adapter.js';

function invalidRuntimeOperationSignal() {
  return new DebugAdapterError('invalid-signal', 'signal must be AbortSignal-compatible');
}

function runtimeOperationSignalAuthority(value) {
  if (value == null) return null;
  if (typeof value !== 'object' && typeof value !== 'function') throw invalidRuntimeOperationSignal();
  let addEventListener;
  let removeEventListener;
  let aborted;
  try {
    addEventListener = value.addEventListener;
    removeEventListener = value.removeEventListener;
    aborted = value.aborted;
  } catch {
    throw invalidRuntimeOperationSignal();
  }
  if (typeof addEventListener !== 'function' || typeof removeEventListener !== 'function' || typeof aborted !== 'boolean') {
    throw invalidRuntimeOperationSignal();
  }
  return { signal: value, addEventListener, removeEventListener, aborted };
}

// Compose caller cancellation into a session-owned controller. The returned
// signal is always owned by the session, so newEpoch()/close() can abort an
// in-flight backend request even when the caller supplied no signal (#5696).
export function createRuntimeOperationController(session, externalSignal = null) {
  const authority = runtimeOperationSignalAuthority(externalSignal);
  const controller = session.controller();
  let listener = null;
  const detach = () => {
    if (!authority || !listener) return;
    try { Reflect.apply(authority.removeEventListener, authority.signal, ['abort', listener]); } catch {}
    listener = null;
  };
  try {
    if (authority) {
      listener = () => {
        let reason = 'cancelled';
        try { reason = authority.signal.reason ?? reason; } catch {}
        if (!controller.signal.aborted) controller.abort(reason);
      };
      if (authority.aborted) listener();
      else {
        Reflect.apply(authority.addEventListener, authority.signal, ['abort', listener, { once: true }]);
        let aborted;
        try { aborted = authority.signal.aborted; } catch { throw invalidRuntimeOperationSignal(); }
        if (typeof aborted !== 'boolean') throw invalidRuntimeOperationSignal();
        if (aborted) listener();
      }
    }
  } catch (error) {
    detach();
    session.releaseController(controller);
    if (error instanceof DebugAdapterError && error.code === 'invalid-signal') throw error;
    throw invalidRuntimeOperationSignal();
  }
  return {
    signal: controller.signal,
    release() {
      detach();
      session.releaseController(controller);
    },
  };
}

