import { recoverSchemas } from '../schema.js';

const TASKS = new WeakMap();

function abortError(signal, fallback = 'Schema recovery aborted') {
  const error = signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason || fallback));
  if (!error.name || error.name === 'Error') error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function waitForShared(promise, signal) {
  throwIfAborted(signal);
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal.addEventListener('abort', onAbort, { once:true });
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

async function waitForOwnedRequest(request, signal) {
  throwIfAborted(signal);
  if (!signal) return request;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      if (typeof request?.cancel === 'function') request.cancel();
      finish(reject, abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once:true });
    Promise.resolve(request).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function taskMap(app) {
  let map = TASKS.get(app);
  if (!map) { map = new Map(); TASKS.set(app, map); }
  return map;
}

function createTask(app, epoch, { onProgress, priority, budget } = {}) {
  const controller = new AbortController();
  const signal = controller.signal;
  const map = taskMap(app);
  const entry = { controller, waiters:0, result:null, promise:null, priority, budget };

  entry.promise = (async () => {
    // Strings and Program are independent reusable artifacts at this boundary.
    // Start both immediately; do not serialize one global producer behind the other.
    const stringsPromise = Promise.resolve().then(() => app.ensureStrings?.((progress) => onProgress?.({ phase:'strings', ...progress })));
    const programPromise = Promise.resolve().then(() => app.ensureProgram?.((progress) => onProgress?.({ phase:'program', ...progress })));
    const [strings, program] = await Promise.all([
      waitForShared(stringsPromise, signal),
      waitForShared(programPromise, signal),
    ]);
    throwIfAborted(signal);
    if (epoch !== app.backend?.gen) throw Object.assign(new Error('Schema recovery became stale.'), { name:'StaleRequestError', stale:true });
    if (!program) return [];

    const read = async (address, length) => {
      throwIfAborted(signal);
      const request = app.backend.readAt(address, length);
      const response = await waitForOwnedRequest(request, signal);
      throwIfAborted(signal);
      return response?.found ? response.bytes : null;
    };
    const architecture = app.store?.get?.('architecture') || app.currentSlice?.()?.capability?.architecture || null;
    const schemas = await recoverSchemas({
      strings,
      program,
      read,
      architecture,
      limit:budget?.maxSchemas,
      onProgress:(progress) => onProgress?.({ phase:'recover', ...progress }),
      isCancelled:() => signal.aborted || epoch !== app.backend?.gen,
    });
    throwIfAborted(signal);
    if (epoch !== app.backend?.gen) throw Object.assign(new Error('Schema recovery became stale.'), { name:'StaleRequestError', stale:true });
    entry.result = schemas || [];
    // Preserve the existing app-level cache contract, but only publish fresh,
    // fully completed schema recovery—not an aborted/stale consumer result.
    app.schemas = entry.result;
    return entry.result;
  })().catch((error) => {
    if (!entry.result) map.delete(epoch);
    throw error;
  });
  map.set(epoch, entry);
  return entry;
}

export function recoverSchemasForUi(app, { signal = null, onProgress = null, priority = 'interactive', budget = null } = {}) {
  if (app?.schemas) return Promise.resolve(app.schemas);
  const epoch = app?.backend?.gen ?? -1;
  const map = taskMap(app);
  let entry = map.get(epoch);
  if (!entry) entry = createTask(app, epoch, { onProgress, priority, budget });
  if (entry.result) return Promise.resolve(entry.result);
  entry.waiters++;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      entry.waiters = Math.max(0, entry.waiters - 1);
      fn(value);
    };
    const onAbort = () => {
      finish(reject, abortError(signal));
      // Only the schema-specific producer is owned here. Shared app-level
      // strings/program artifacts are deliberately not globally cancelled.
      if (entry.waiters === 0 && !entry.result) entry.controller.abort(signal?.reason ?? 'no-schema-consumers');
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort, { once:true });
    entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

export function clearSchemaRecoveryTasks(app) {
  const map = TASKS.get(app);
  if (!map) return;
  for (const entry of map.values()) if (!entry.result) entry.controller.abort('schema-task-cleared');
  TASKS.delete(app);
}
