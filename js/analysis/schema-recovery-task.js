import { recoverSchemas } from '../schema.js';

const TASKS = new WeakMap();
const RESULT_META = new WeakMap();

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

function requestedMaxSchemas(budget) {
  const value = budget?.maxSchemas;
  if (value == null) return Infinity;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : Infinity;
}

function taskKey(epoch, maxSchemas) {
  return `${epoch}:${maxSchemas === Infinity ? 'unbounded' : maxSchemas}`;
}

function resultMeta(result) {
  return result && typeof result === 'object' ? RESULT_META.get(result) || null : null;
}

function covers(meta, epoch, maxSchemas) {
  return !!meta && meta.epoch === epoch && (meta.complete === true || meta.maxSchemas >= maxSchemas);
}

function rememberResult(result, epoch, maxSchemas) {
  if (result && typeof result === 'object') {
    RESULT_META.set(result, { epoch, maxSchemas, complete: result.complete === true });
  }
  return result;
}

function shouldPublish(current, nextMeta) {
  const currentMeta = resultMeta(current);
  if (!currentMeta || currentMeta.epoch !== nextMeta.epoch) return true;
  if (nextMeta.complete === true) return currentMeta.complete !== true || nextMeta.maxSchemas >= currentMeta.maxSchemas;
  if (currentMeta.complete === true) return false;
  return nextMeta.maxSchemas >= currentMeta.maxSchemas;
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

function annotateSchemas(value, completeness) {
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
  });
  return schemas;
}

function createTask(app, key, epoch, maxSchemas, { onProgress, priority, budget } = {}) {
  const controller = new AbortController();
  const signal = controller.signal;
  const map = taskMap(app);
  const entry = { key, epoch, maxSchemas, controller, waiters:0, result:null, promise:null, priority, budget };

  entry.promise = (async () => {
    const dependencyOptions = {
      signal,
      priority,
      budget,
    };
    const stringsPromise = Promise.resolve().then(() => app.ensureStrings?.({
      ...dependencyOptions,
      onProgress:(progress) => onProgress?.({ phase:'strings', ...progress }),
    }));
    const programPromise = Promise.resolve().then(() => app.ensureProgram?.({
      ...dependencyOptions,
      onProgress:(progress) => onProgress?.({ phase:'program', ...progress }),
    }));
    const [strings, program] = await Promise.all([stringsPromise, programPromise]);
    throwIfAborted(signal);
    if (epoch !== app.backend?.gen) throw Object.assign(new Error('Schema recovery became stale.'), { name:'StaleRequestError', stale:true });
    if (!program) {
      entry.result = rememberResult(annotateSchemas([], dependencyCompleteness(strings, program)), epoch, maxSchemas);
      const meta = resultMeta(entry.result);
      if (shouldPublish(app.schemas, meta)) app.schemas = entry.result;
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
      limit:maxSchemas === Infinity ? undefined : maxSchemas,
      onProgress:(progress) => onProgress?.({ phase:'recover', ...progress }),
      isCancelled:() => signal.aborted || epoch !== app.backend?.gen,
    });
    throwIfAborted(signal);
    if (epoch !== app.backend?.gen) throw Object.assign(new Error('Schema recovery became stale.'), { name:'StaleRequestError', stale:true });
    entry.result = rememberResult(annotateSchemas(schemas, dependencyCompleteness(strings, program)), epoch, maxSchemas);
    const meta = resultMeta(entry.result);
    if (shouldPublish(app.schemas, meta)) app.schemas = entry.result;
    return entry.result;
  })().catch((error) => {
    if (!entry.result) map.delete(key);
    throw error;
  });
  entry.promise.catch(() => {});
  map.set(key, entry);
  return entry;
}

function coveringEntry(map, epoch, maxSchemas) {
  const entries = [...map.values()].filter((entry) => entry.epoch === epoch && (entry.result?.complete === true || entry.maxSchemas >= maxSchemas));
  entries.sort((a, b) => {
    if ((a.result?.complete === true) !== (b.result?.complete === true)) return a.result?.complete === true ? -1 : 1;
    return a.maxSchemas - b.maxSchemas;
  });
  return entries[0] || null;
}

export function recoverSchemasForUi(app, { signal = null, onProgress = null, priority = 'interactive', budget = null } = {}) {
  const epoch = app?.backend?.gen ?? -1;
  const maxSchemas = requestedMaxSchemas(budget);
  if (app?.schemas && covers(resultMeta(app.schemas), epoch, maxSchemas)) return Promise.resolve(app.schemas);
  const map = taskMap(app);
  let entry = coveringEntry(map, epoch, maxSchemas);
  if (!entry) {
    const key = taskKey(epoch, maxSchemas);
    entry = map.get(key) || createTask(app, key, epoch, maxSchemas, { onProgress, priority, budget });
  }
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
