import { normalizeSchemaRecoveryLimit, recoverSchemas } from '../schema.js';

const TASKS = new WeakMap();

function abortError(signal, fallback = 'Schema recovery aborted') {
  const error = signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason || fallback));
  if (!error.name || error.name === 'Error') error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
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
    const outcome = Promise.resolve(request).then((value) => finish(resolve, value), (error) => finish(reject, error));
    if (signal.aborted) { onAbort(); return outcome; }
    return outcome;
  });
}

function taskMap(app) {
  let map = TASKS.get(app);
  if (!map) { map = new Map(); TASKS.set(app, map); }
  return map;
}

function dependencyCompleteness(strings, program) {
  const reasons = [];
  if (strings?.complete !== true) reasons.push(strings?.truncationReason || 'strings-partial');
  const graph = program?.graphCompleteness;
  const programComplete = !!program && program.unsupported !== true && program.completeness?.complete !== false
    && graph?.callsComplete !== false && graph?.refsComplete !== false;
  if (!programComplete) reasons.push(program?.queryIncompleteReason || graph?.reasons?.[0] || 'program-partial');
  return { complete:reasons.length === 0, reasons:[...new Set(reasons.filter(Boolean))] };
}

function annotateSchemas(value, completeness, { epoch, maxSchemas }) {
  const schemas = Array.isArray(value) ? value : [];
  const ownIncomplete = schemas.complete === false || schemas.truncated === true || schemas.unsupported === true;
  const complete = completeness.complete && !ownIncomplete;
  const reason = !complete
    ? schemas.incompleteReason || schemas.truncationReason || completeness.reasons[0] || 'schema-recovery-partial'
    : null;
  Object.defineProperties(schemas, {
    complete:{ value:complete, enumerable:false, configurable:true },
    incompleteReason:{ value:reason, enumerable:false, configurable:true },
    dependencyReasons:{ value:Object.freeze(completeness.reasons.slice()), enumerable:false, configurable:true },
    schemaRecoveryEpoch:{ value:epoch, enumerable:false, configurable:true },
    schemaRecoveryMaxSchemas:{ value:maxSchemas, enumerable:false, configurable:true },
  });
  return schemas;
}

function taskKey(epoch, maxSchemas) {
  return `${epoch}:${maxSchemas}`;
}

function resultSatisfies(result, epoch, maxSchemas) {
  if (!Array.isArray(result)) return false;
  if (result.schemaRecoveryEpoch != null && result.schemaRecoveryEpoch !== epoch) return false;
  if (result.complete === true) return true;
  return result.schemaRecoveryEpoch === epoch
    && Number.isSafeInteger(result.schemaRecoveryMaxSchemas)
    && result.schemaRecoveryMaxSchemas >= maxSchemas;
}

function entrySatisfies(entry, epoch, maxSchemas) {
  if (!entry || entry.epoch !== epoch) return false;
  if (entry.result) return resultSatisfies(entry.result, epoch, maxSchemas);
  return !entry.controller.signal.aborted && entry.maxSchemas >= maxSchemas;
}

function satisfyingEntry(map, epoch, maxSchemas) {
  let best = null;
  for (const entry of map.values()) {
    if (!entrySatisfies(entry, epoch, maxSchemas)) continue;
    if (entry.result?.complete === true) return entry;
    if (!best || entry.maxSchemas < best.maxSchemas || (entry.result && !best.result)) best = entry;
  }
  return best;
}

function publishBestSchemaResult(app, entry) {
  if (entry.epoch !== app.backend?.gen) return;
  const current = app.schemas;
  if (current?.complete === true && entry.result.complete !== true) return;
  const currentLimit = current?.schemaRecoveryEpoch === entry.epoch
    && Number.isSafeInteger(current?.schemaRecoveryMaxSchemas)
    ? current.schemaRecoveryMaxSchemas
    : -1;
  if (entry.result.complete === true || current?.complete !== true && entry.maxSchemas >= currentLimit) {
    app.schemas = entry.result;
  }
}

function createTask(app, epoch, maxSchemas, { onProgress, priority, budget } = {}) {
  const reportProgress = typeof onProgress === 'function' ? onProgress : null;
  const controller = new AbortController();
  const signal = controller.signal;
  const map = taskMap(app);
  const key = taskKey(epoch, maxSchemas);
  const entry = { key, epoch, maxSchemas, controller, waiters:0, result:null, promise:null, priority, budget };

  entry.promise = (async () => {
    const dependencyOptions = {
      signal,
      priority,
      budget,
    };
    const stringsPromise = Promise.resolve().then(() => app.ensureStrings?.({
      ...dependencyOptions,
      onProgress:(progress) => reportProgress?.({ phase:'strings', ...progress }),
    }));
    const programPromise = Promise.resolve().then(() => app.ensureProgram?.({
      ...dependencyOptions,
      onProgress:(progress) => reportProgress?.({ phase:'program', ...progress }),
    }));
    const [strings, program] = await Promise.all([stringsPromise, programPromise]);
    throwIfAborted(signal);
    if (epoch !== app.backend?.gen) throw Object.assign(new Error('Schema recovery became stale.'), { name:'StaleRequestError', stale:true });
    if (!program) {
      entry.result = annotateSchemas([], dependencyCompleteness(strings, program), { epoch, maxSchemas });
      publishBestSchemaResult(app, entry);
      return entry.result;
    }

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
      limit:maxSchemas,
      onProgress:(progress) => reportProgress?.({ phase:'recover', ...progress }),
      isCancelled:() => signal.aborted || epoch !== app.backend?.gen,
    });
    throwIfAborted(signal);
    if (epoch !== app.backend?.gen) throw Object.assign(new Error('Schema recovery became stale.'), { name:'StaleRequestError', stale:true });
    entry.result = annotateSchemas(schemas, dependencyCompleteness(strings, program), { epoch, maxSchemas });
    publishBestSchemaResult(app, entry);
    return entry.result;
  })().catch((error) => {
    if (!entry.result && map.get(key) === entry) map.delete(key);
    throw error;
  });
  entry.promise.catch(() => {});
  map.set(key, entry);
  return entry;
}

export function recoverSchemasForUi(app, { signal = null, onProgress = null, priority = 'interactive', budget = null } = {}) {
  const epoch = app?.backend?.gen ?? -1;
  const maxSchemas = normalizeSchemaRecoveryLimit(budget?.maxSchemas);
  if (resultSatisfies(app?.schemas, epoch, maxSchemas)) return Promise.resolve(app.schemas);
  const map = taskMap(app);
  let entry = satisfyingEntry(map, epoch, maxSchemas);
  if (!entry) entry = createTask(app, epoch, maxSchemas, { onProgress, priority, budget });
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
      if (entry.waiters === 0 && !entry.result) entry.controller.abort(signal?.reason ?? 'no-schema-consumers');
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort, { once:true });
    const outcome = entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
    if (signal?.aborted) { onAbort(); return outcome; }
    return outcome;
  });
}

export function clearSchemaRecoveryTasks(app) {
  const map = TASKS.get(app);
  if (!map) return;
  for (const entry of map.values()) if (!entry.result) entry.controller.abort('schema-task-cleared');
  TASKS.delete(app);
}
