let sequence = 1;

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason == null ? 'IL2CPP metadata parsing was cancelled.' : String(signal.reason));
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

export function parseMetadataFileInWorker(file, options = {}) {
  const signal = options.signal ?? null;
  const workerFactory = options.workerFactory || (() => new Worker(new URL('./il2cpp-worker.js', import.meta.url), { type:'module' }));
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const id = sequence++;
  const worker = workerFactory();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      try { worker.terminate(); } catch { /* worker may already be gone */ }
      fn(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal?.addEventListener('abort', onAbort, { once:true });
    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.id !== id) return;
      if (message.ok) finish(resolve, message.result);
      else {
        const error = new Error(message.error?.message || 'IL2CPP metadata worker failed.');
        error.name = message.error?.name || 'Error';
        if (message.error?.code) error.code = message.error.code;
        finish(reject, error);
      }
    };
    const fail = (event) => finish(reject, event?.error || new Error(event?.message || 'IL2CPP metadata worker failed.'));
    worker.onerror = fail;
    worker.onmessageerror = fail;
    try {
      // File/Blob is structured-cloneable. Do not call file.arrayBuffer() here.
      worker.postMessage({ t:'parse', id, file });
    } catch (error) {
      finish(reject, error);
    }
  });
}
