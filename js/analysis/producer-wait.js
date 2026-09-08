/*
 * Shared consumer/wait ownership for app-level analysis producers.
 *
 * Multiple UI consumers can attach to one in-flight producer. Each waiter must
 * detach exactly once (even when the abort fires between the pre-check and the
 * listener subscription — #3195), and the last departing consumer aborts the
 * producer so cancelled work does not keep running underneath the UI.
 */

function safeAbortReason(signal) {
  let reason = null;
  try { reason = signal?.reason; } catch { return null; }
  try {
    if (reason instanceof Error) return reason;
    return reason == null ? null : String(reason);
  } catch {
    return null;
  }
}

export function appProducerAbortError(signal, message = 'Analysis producer aborted') {
  const reason = safeAbortReason(signal);
  if (reason instanceof Error) return reason;
  const error = new Error(reason == null ? message : reason);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

export function analysisAbortSignalMethods(signal) {
  if (signal == null) return null;
  const type = typeof signal;
  if (type !== 'object' && type !== 'function') throw new TypeError('analysis-invalid-abort-signal');
  let aborted;
  let addEventListener;
  let removeEventListener;
  try {
    aborted = signal.aborted;
    addEventListener = signal.addEventListener;
    removeEventListener = signal.removeEventListener;
  } catch {
    throw new TypeError('analysis-invalid-abort-signal');
  }
  if (
    typeof aborted !== 'boolean' ||
    typeof addEventListener !== 'function' ||
    typeof removeEventListener !== 'function'
  ) {
    throw new TypeError('analysis-invalid-abort-signal');
  }
  // Consumers must not be able to bypass waiter cleanup by throwing from a
  // later `aborted`/`reason` read. Keep event methods bound to the original
  // signal while exposing only fail-safe state to the shared-wait machinery.
  const signalView = Object.freeze({
    get aborted() {
      try { return signal.aborted === true; } catch { return true; }
    },
    get reason() { return safeAbortReason(signal); },
  });
  return {
    signal:signalView,
    addEventListener:(...args) => addEventListener.call(signal, ...args),
    removeEventListener:(...args) => removeEventListener.call(signal, ...args),
  };
}

function abortProducerWithoutConsumers(entry) {
  if (entry.settled || entry.waiters !== 0) return;
  // A producer may reject synchronously in response to controller.abort(). Keep
  // an explicit rejection observer attached before aborting so a consumer that
  // was already gone cannot leave an unhandled producer rejection behind.
  void Promise.resolve(entry.promise).catch(() => {});
  entry.controller.abort('analysis-producer-no-consumers');
}

export function waitForAppProducer(entry, signal) {
  let subscription;
  try {
    subscription = analysisAbortSignalMethods(signal);
  } catch (error) {
    abortProducerWithoutConsumers(entry);
    return Promise.reject(error);
  }
  if (subscription?.signal.aborted) {
    abortProducerWithoutConsumers(entry);
    return Promise.reject(appProducerAbortError(subscription.signal));
  }
  entry.waiters++;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value, abortIfLast = false) => {
      if (done) return;
      done = true;
      if (subscription) {
        try { subscription.removeEventListener.call(subscription.signal, 'abort', onAbort); } catch { /* accounting is authoritative */ }
      }
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (abortIfLast) abortProducerWithoutConsumers(entry);
      fn(value);
    };
    const onAbort = () => finish(reject, appProducerAbortError(subscription?.signal), true);
    if (subscription) {
      try {
        subscription.addEventListener.call(subscription.signal, 'abort', onAbort, { once:true });
      } catch (error) {
        finish(reject, error, true);
        return;
      }
    }
    // Register the producer handlers before the post-subscription abort check.
    // If that check aborts the final consumer, the producer can reject
    // immediately and must already have a rejection observer attached.
    entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
    /* #3195: an abort dispatched between the pre-check above and this
       subscription never re-fires for a later listener. Re-check after
       subscribing and route through onAbort so the consumer detaches
       immediately; the done guard keeps this a no-op when nothing raced. */
    if (subscription && !done) {
      let aborted;
      try { aborted = subscription.signal.aborted; }
      catch (error) { finish(reject, error, true); return; }
      if (aborted) onAbort();
    }
  });
}
