import { materializeLegacyExactStackValues } from '../legacy-exact-return-repair.js';

function clock() { return globalThis.performance?.now ? globalThis.performance.now() : Date.now(); }

export const DEFAULT_PASS_BUDGET = Object.freeze({ timeBudgetMs: 40, nodeBudget: 12000, maxIterations: 16 });

function validTimeBudgetMs(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

// A subtree that is entirely frozen, and holds no collection whose internal
// slots `Object.freeze` does not protect (Map/Set/Date/RegExp/buffers), cannot
// be mutated by a pass and so never needs a rollback pre-image. Canonical
// artifacts such as the deep-frozen semantic IR are shared unchanged across
// every optional pass; recognizing one once and caching the answer stops the
// manager from re-snapshotting the same immutable graph on every pass. A `true`
// answer is stable forever (a frozen graph cannot gain a mutable descendant); a
// stale `false` only snapshots something we did not strictly need to, which is
// always safe. The skip mirrors `capturePassState`'s own traversal predicate:
// a value that traversal would not snapshot anyway (a function, a class
// instance, a WeakMap) is treated as immutable here too, so the two agree about
// what is pass-owned data.
const deepImmutableCache = new WeakMap();
function isDeepImmutable(value) {
  if (value === null || typeof value !== 'object') return true;
  const cached = deepImmutableCache.get(value);
  if (cached !== undefined) return cached;
  const stack = [value];
  const seen = new Set();
  const parent = new WeakMap();
  let immutable = true;
  let mutableWitness = null;
  while (stack.length) {
    const current = stack.pop();
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const known = deepImmutableCache.get(current);
    if (known === true) continue;
    if (known === false) { immutable = false; mutableWitness = current; break; }
    if (current instanceof Map || current instanceof Set || current instanceof Date
        || current instanceof RegExp || current instanceof ArrayBuffer || ArrayBuffer.isView(current)) {
      immutable = false; mutableWitness = current; break;
    }
    const proto = Object.getPrototypeOf(current);
    // Anything the traversal below would not snapshot is also not snapshotted
    // here, so it can be ignored rather than forcing a conservative fallback.
    if (!Array.isArray(current) && proto !== Object.prototype && proto !== null) continue;
    if (!Object.isFrozen(current)) { immutable = false; mutableWitness = current; break; }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if ('value' in descriptor) {
        const child = descriptor.value;
        if (child !== null && typeof child === 'object' && !parent.has(child) && child !== value) parent.set(child, current);
        stack.push(child);
      }
    }
  }
  if (immutable) {
    // Every traversed object is itself deep-immutable too. Cache the whole
    // certified subgraph, not just the entry root: pass state commonly keeps
    // many frozen wrapper roots that share canonical IR descendants, and
    // root-only caching makes each wrapper re-walk the same large graph.
    // `true` is permanent because a fully frozen plain-data graph cannot gain
    // a mutable descendant.
    for (const current of seen) deepImmutableCache.set(current, true);
  } else {
    // A stale false only causes an unnecessary rollback snapshot, never an
    // unsafe skip. Cache the actual failing path, not unrelated visited
    // siblings: shared frozen wrappers often converge on the same mutable
    // descendant, and root-only negative caching makes every wrapper re-walk
    // that whole path.
    let current = mutableWitness;
    while (current !== null && typeof current === 'object') {
      deepImmutableCache.set(current, false);
      if (current === value) break;
      current = parent.get(current) ?? null;
    }
    deepImmutableCache.set(value, false);
  }
  return immutable;
}

function capturePassState(state) {
  const __t0 = globalThis.__hexPerfProbe ? performance.now() : 0; // PERF-PROBE
  const pending = [state], seen = new Set(), records = [];
  while (pending.length) {
    const value = pending.pop();
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    if (isDeepImmutable(value)) continue;
    seen.add(value);
    const proto = Object.getPrototypeOf(value);
    const map = value instanceof Map, set = value instanceof Set, date = value instanceof Date;
    // Live adapters/class instances are not pass-owned plain data. Do not
    // traverse them or invoke accessors while capturing the rollback state.
    if (!map && !set && !date && !(value instanceof RegExp) && !Array.isArray(value)
        && proto !== Object.prototype && proto !== null) continue;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entries = map ? [...value.entries()] : set ? [...value.values()] : null;
    records.push({ value, proto, descriptors, entries, map, set, time:date ? value.getTime() : null });
    for (const key of Reflect.ownKeys(descriptors)) {
      if ('value' in descriptors[key]) pending.push(descriptors[key].value);
    }
    if (map) for (const [key, entry] of entries) pending.push(key, entry);
    if (set) for (const entry of entries) pending.push(entry);
  }
  if (globalThis.__hexPerfProbe) globalThis.__hexPerfProbe.recordCapturePassState?.(performance.now() - __t0, records.length); // PERF-PROBE
  return () => {
    for (const { value, proto, descriptors, entries, map, set, time } of records) {
      if (Object.getPrototypeOf(value) !== proto) Object.setPrototypeOf(value, proto);
      for (const key of Reflect.ownKeys(value)) {
        if (!Object.hasOwn(descriptors, key) && !Reflect.deleteProperty(value, key)) {
          throw new Error('pass-rollback-nonconfigurable-property');
        }
      }
      Object.defineProperties(value, descriptors);
      if (map) { Map.prototype.clear.call(value); for (const [key, entry] of entries) Map.prototype.set.call(value, key, entry); }
      if (set) { Set.prototype.clear.call(value); for (const entry of entries) Set.prototype.add.call(value, entry); }
      if (time !== null) Date.prototype.setTime.call(value, time);
    }
  };
}

export class PassManager {
  constructor(passes = [], budget = {}) {
    this.passes = passes.slice();
    this.budget = { ...DEFAULT_PASS_BUDGET, ...budget };
    this.budget.timeBudgetMs = validTimeBudgetMs(this.budget.timeBudgetMs, DEFAULT_PASS_BUDGET.timeBudgetMs);
  }

  run(initialState) {
    const state = initialState || {};
    state.passMetrics ||= [];
    state.warnings ||= [];
    // `deterministicTransforms` is the documented measurement contract: output
    // must be a function of the input and the rules, not of the host. The
    // wall-clock valve stays a production constraint, but a measurement run
    // that silently skipped optional passes under runner load published a
    // degraded fallback (generic prototypes, raw slot names) while the same
    // input on a fast host produced the full projection — measuring the host,
    // not the decompiler. Disable only the deadline here; work bounds are
    // untouched, exactly like the rewrite engine's contract.
    const deterministic = state.opts?.deterministicTransforms === true;
    const totalStart = clock();
    const totalBudget = Math.max(0, Number(this.budget.timeBudgetMs ?? DEFAULT_PASS_BUDGET.timeBudgetMs));
    const deadline = deterministic ? Infinity : totalStart + totalBudget;
    let budgetWarned = false;

    for (const pass of this.passes) {
      let rollbackFailed = false;
      const start = clock();
      const remainingMs = Math.max(0, deadline - start);
      if (remainingMs <= 0 && !pass.required) {
        if (!budgetWarned) state.warnings.push(`Decompiler pass budget exhausted before ${pass.name}; optional passes were skipped.`);
        budgetWarned = true;
        state.degraded = true;
        state.passMetrics.push({ name: pass.name, elapsedMs: 0, ok: true, skipped: true, reason: 'deadline', degraded: true });
        continue;
      }

      if (remainingMs <= 0) {
        if (!budgetWarned) state.warnings.push(`Decompiler pass budget exhausted before ${pass.name}; only required finalization may continue.`);
        budgetWarned = true;
        state.degraded = true;
      }

      try {
        // Passes receive an absolute deadline and a cheap synchronous cancellation
        // predicate. Expensive passes are expected to poll shouldAbort() at bounded
        // intervals; once the deadline is crossed the manager never starts another
        // optional pass. Required representation/finalization passes still run so the
        // public result remains structurally valid.
        const passBudget = { ...this.budget, ...(pass.budget || {}) };
        const passRemaining = Math.max(0, deadline - clock());
        passBudget.timeBudgetMs = Math.min(
          validTimeBudgetMs(passBudget.timeBudgetMs, DEFAULT_PASS_BUDGET.timeBudgetMs),
          passRemaining,
        );
        // #5024: a pass that declares its own timeBudgetMs must actually be bounded
        // by it. The effective pass deadline is min(global deadline, passStart +
        // local budget) and deadline/remainingTimeMs/shouldAbort are all derived
        // from that single value. Passes without a pass-local budget keep the
        // global deadline contract; deterministic mode keeps ignoring only the
        // wall-clock valve.
        const passLocalBudget = pass.budget && pass.budget.timeBudgetMs != null
          ? validTimeBudgetMs(pass.budget.timeBudgetMs, DEFAULT_PASS_BUDGET.timeBudgetMs)
          : null;
        const passStart = clock();
        const passDeadline = deterministic || passLocalBudget == null
          ? deadline
          : Math.min(deadline, passStart + passLocalBudget);
        passBudget.remainingTimeMs = Math.max(0, passDeadline - clock());
        passBudget.deadline = passDeadline;
        passBudget.degraded = !!state.degraded;
        passBudget.deterministic = deterministic;
        passBudget.shouldAbort = () => !deterministic && clock() >= passDeadline;

        if (pass.required) {
          const result = pass.run(state, passBudget);
          if (result && result !== state) Object.assign(state, result);
          const elapsedMs = clock() - start;
          if (clock() >= passDeadline) state.degraded = true;
          state.passMetrics.push({ name: pass.name, elapsedMs, ok: true, degraded: !!state.degraded });
          continue;
        }

        // #5113 rollback must not replace canonical IR/expression identities on
        // success: provenance producers use private identity-bound observations.
        // Run synchronously on the real graph; retain descriptors and collection
        // entries so a failure restores pass-owned data in place (including
        // aliases/cycles). This does not roll back external adapter side effects.
        const restore = capturePassState(state);
        try {
          const result = pass.run(state, passBudget);
          if (result && result !== state) Object.assign(state, result);
          const elapsedMs = clock() - start;
          if (clock() >= passDeadline) state.degraded = true;
          state.passMetrics.push({ name: pass.name, elapsedMs, ok: true, degraded: !!state.degraded });
        } catch (error) {
          try { restore(); } catch (rollbackError) {
            // Irreversible descriptor changes cannot be called a recovered
            // optional failure. Stop before any finalizer consumes corrupt data.
            rollbackFailed = true;
            throw new Error('optional-pass-rollback-failed', { cause:rollbackError });
          }
          state.warnings.push(`${pass.name}: ${error?.message || String(error)}`);
          state.passMetrics.push({ name: pass.name, elapsedMs: clock() - start, ok: false, degraded: true });
          state.degraded = true;
        }
      } catch (error) {
        state.warnings.push(`${pass.name}: ${error?.message || String(error)}`);
        state.passMetrics.push({ name: pass.name, elapsedMs: clock() - start, ok: false, degraded: true });
        if (pass.required || rollbackFailed) throw error;
        state.degraded = true;
      }
    }
    materializeLegacyExactStackValues(state);
    state.passElapsedMs = clock() - totalStart;
    state.passDeadlineExceeded = state.passElapsedMs > totalBudget;
    globalThis.__hexPerfProbe?.recordPasses?.(state.passMetrics, state.passElapsedMs); // PERF-PROBE
    return state;
  }
}
