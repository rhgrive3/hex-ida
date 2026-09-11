import { materializeLegacyExactStackValues } from '../legacy-exact-return-repair.js';

function clock() { return globalThis.performance?.now ? globalThis.performance.now() : Date.now(); }

export const DEFAULT_PASS_BUDGET = Object.freeze({ timeBudgetMs: 40, nodeBudget: 12000, maxIterations: 16 });

function validTimeBudgetMs(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function forkValue(value, seen) {
  if (value === null || typeof value !== 'object') return value;
  const cached = seen.get(value);
  if (cached !== undefined) return cached;
  if (value instanceof Date) {
    const forked = new Date(value.getTime());
    seen.set(value, forked);
    return forked;
  }
  if (value instanceof RegExp) {
    const forked = new RegExp(value.source, value.flags);
    seen.set(value, forked);
    return forked;
  }
  if (value instanceof Map) {
    const forked = new Map();
    seen.set(value, forked);
    for (const [key, entry] of value) {
      // Primitive leaves need no graph lookup or recursive call. Keep reads
      // and recursive object visits in the original depth-first order.
      forked.set(
        key !== null && typeof key === 'object' ? forkValue(key, seen) : key,
        entry !== null && typeof entry === 'object' ? forkValue(entry, seen) : entry,
      );
    }
    return forked;
  }
  if (value instanceof Set) {
    const forked = new Set();
    seen.set(value, forked);
    for (const entry of value) {
      forked.add(entry !== null && typeof entry === 'object' ? forkValue(entry, seen) : entry);
    }
    return forked;
  }
  if (Array.isArray(value)) {
    const forked = new Array(value.length);
    seen.set(value, forked);
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      forked[index] = entry !== null && typeof entry === 'object' ? forkValue(entry, seen) : entry;
    }
    return forked;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const forked = {};
  seen.set(value, forked);
  for (const key of Object.keys(value)) {
    const entry = value[key];
    forked[key] = entry !== null && typeof entry === 'object' ? forkValue(entry, seen) : entry;
  }
  return forked;
}

function commitFork(state, forked) {
  for (const key of Object.keys(state)) {
    if (!Object.prototype.hasOwnProperty.call(forked, key)) delete state[key];
  }
  Object.assign(state, forked);
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

        // #5113: optional passes run on a pass-local fork of the state and commit
        // atomically on success. Plain data (objects/arrays/Map/Set/Date/RegExp)
        // is deep-forked with cycles preserved; functions and class instances
        // keep their identity (live opts/adapters must stay shared). A failed
        // optional pass contributes nothing: the fork is discarded, the failure
        // is recorded, and the pipeline continues on the last valid state.
        const forked = forkValue(state, new Map());
        try {
          const result = pass.run(forked, passBudget);
          if (result && result !== forked) Object.assign(forked, result);
          commitFork(state, forked);
          const elapsedMs = clock() - start;
          if (clock() >= passDeadline) state.degraded = true;
          state.passMetrics.push({ name: pass.name, elapsedMs, ok: true, degraded: !!state.degraded });
        } catch (error) {
          state.warnings.push(`${pass.name}: ${error?.message || String(error)}`);
          state.passMetrics.push({ name: pass.name, elapsedMs: clock() - start, ok: false, degraded: true });
          state.degraded = true;
        }
      } catch (error) {
        state.warnings.push(`${pass.name}: ${error?.message || String(error)}`);
        state.passMetrics.push({ name: pass.name, elapsedMs: clock() - start, ok: false, degraded: true });
        if (pass.required) throw error;
        state.degraded = true;
      }
    }
    materializeLegacyExactStackValues(state);
    state.passElapsedMs = clock() - totalStart;
    state.passDeadlineExceeded = state.passElapsedMs > totalBudget;
    return state;
  }
}
