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

function stableBudgetKey(value, seen = new Set()) {
  if (value == null) return 'default';
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value) ? `n:${value}` : `n:${String(value)}`;
  if (type === 'string') return `s:${value}`;
  if (type === 'boolean') return `b:${value}`;
  if (type !== 'object') return `${type}:${String(value)}`;
  if (seen.has(value)) return 'cycle';
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => stableBudgetKey(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${key}:${stableBudgetKey(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
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

function createTask(app, taskKey, epoch, { onProgress, priority, budget } = {}) {
  const controller = new AbortController();
  const signal = controller.signal;
  const map = taskMap(app);
  const entry = { controller, waiters:0, result:null, promise:null, priority, budget };

  entry.promise = (async () => {
    // Both dependencies are reusable shared artifacts. Pass the schema consumer
    // contract through so closing the sheet detaches this consumer end-to-end;
    // shared producers remain alive only when another consumer is still attached.
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
    if (!program) return annotateSchemas([], dependencyCompleteness(strings, program));

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
    entry.result = annotateSchemas(schemas, dependencyCompleteness(strings, program));
    // Preserve the existing app-level cache contract, but only publish fresh,
    // completed-or-explicitly-partial schema recovery—not an aborted/stale result.
    if (entry.result.complete === true) app.schemas = entry.result;
    return entry.result;
  })().catch((error) => {
    if (!entry.result) map.delete(taskKey);
    throw error;
  });
  map.set(taskKey, entry);
  return entry;
}

export function recoverSchemasForUi(app, { signal = null, onProgress = null, priority = 'interactive', budget = null } = {}) {
  if (app?.schemas?.complete === true) return Promise.resolve(app.schemas);
  const epoch = app?.backend?.gen ?? -1;
  const map = taskMap(app);
  const taskKey = `${epoch}:${stableBudgetKey(budget)}`;
  let entry = map.get(taskKey);
  if (!entry) entry = createTask(app, taskKey, epoch, { onProgress, priority, budget });
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
      // The shared dependency producers own their own waiter counts. Aborting
      // this task signal detaches only this schema consumer from those artifacts.
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
