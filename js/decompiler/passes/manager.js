import { materializeLegacyExactStackValues } from '../legacy-exact-return-repair.js';

function clock() { return globalThis.performance?.now ? globalThis.performance.now() : Date.now(); }

export const DEFAULT_PASS_BUDGET = Object.freeze({ timeBudgetMs: 40, nodeBudget: 12000, maxIterations: 16 });

function validTimeBudgetMs(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function capturePassState(state) {
  const pending = [state], seen = new Set(), records = [];
  while (pending.length) {
    const value = pending.pop();
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
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
    return state;
  }
}
