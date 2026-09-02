/*
 * Shared consumer/wait ownership for app-level analysis producers.
 *
 * Multiple UI consumers can attach to one in-flight producer. Each waiter must
 * detach exactly once (even when the abort fires between the pre-check and the
 * listener subscription — #3195), and the last departing consumer aborts the
 * producer so cancelled work does not keep running underneath the UI.
 */

export function appProducerAbortError(signal, message = 'Analysis producer aborted') {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason == null ? message : String(signal.reason));
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

export function waitForAppProducer(entry, signal) {
  if (signal?.aborted) return Promise.reject(appProducerAbortError(signal));
  entry.waiters++;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      entry.waiters = Math.max(0, entry.waiters - 1);
      fn(value);
    };
    const onAbort = () => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (!entry.settled && entry.waiters === 0) entry.controller.abort('analysis-producer-no-consumers');
      reject(appProducerAbortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once:true });
    /* #3195: an abort dispatched between the pre-check above and this
       subscription never re-fires for a later listener. Re-check after
       subscribing and route through onAbort so the consumer detaches
       immediately; the done guard keeps this a no-op when nothing raced. */
    if (signal?.aborted && !done) onAbort();
    entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}
