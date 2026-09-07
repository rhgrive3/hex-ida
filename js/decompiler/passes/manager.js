import { materializeLegacyExactStackValues } from '../legacy-exact-return-repair.js';

function clock() { return globalThis.performance?.now ? globalThis.performance.now() : Date.now(); }

export const DEFAULT_PASS_BUDGET = Object.freeze({ timeBudgetMs: 40, nodeBudget: 12000, maxIterations: 16 });

function validTimeBudgetMs(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function validWorkLimit(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

/* Budget fields are trust boundaries.  Reading only own data descriptors keeps
 * malformed option objects from running valueOf/toPrimitive or a throwing
 * getter while the manager is establishing its limits. */
function ownData(object, key) {
  if (object == null || (typeof object !== 'object' && typeof object !== 'function')) {
    return { present:false, valid:true, value:undefined };
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return { present:false, valid:true, value:undefined };
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return { present:true, valid:false, value:undefined };
    }
    return { present:true, valid:true, value:descriptor.value };
  } catch {
    return { present:true, valid:false, value:undefined };
  }
}

function safeDataProperties(object) {
  const copy = {};
  if (object == null || (typeof object !== 'object' && typeof object !== 'function')) return copy;
  let keys;
  try { keys = Reflect.ownKeys(object); } catch { return copy; }
  for (const key of keys) {
    if (typeof key !== 'string') continue;
    const value = ownData(object, key);
    if (value.present && value.valid) copy[key] = value.value;
  }
  return copy;
}

export class PassManager {
  constructor(passes = [], budget = {}) {
    this.passes = passes.slice();
    this.budget = {
      ...safeDataProperties(budget),
      timeBudgetMs: ownData(budget, 'timeBudgetMs').value,
      nodeBudget: ownData(budget, 'nodeBudget').value,
      maxIterations: ownData(budget, 'maxIterations').value,
    };
    if (!ownData(budget, 'timeBudgetMs').present) this.budget.timeBudgetMs = DEFAULT_PASS_BUDGET.timeBudgetMs;
    if (!ownData(budget, 'nodeBudget').present) this.budget.nodeBudget = DEFAULT_PASS_BUDGET.nodeBudget;
    if (!ownData(budget, 'maxIterations').present) this.budget.maxIterations = DEFAULT_PASS_BUDGET.maxIterations;
    this.budget.timeBudgetMs = validTimeBudgetMs(this.budget.timeBudgetMs, DEFAULT_PASS_BUDGET.timeBudgetMs);
    this.budget.nodeBudget = validWorkLimit(this.budget.nodeBudget, DEFAULT_PASS_BUDGET.nodeBudget);
    this.budget.maxIterations = validWorkLimit(this.budget.maxIterations, DEFAULT_PASS_BUDGET.maxIterations);
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
    const stateOptions = state.opts || {};
    const deterministicOption = ownData(stateOptions, 'deterministicTransforms');
    const externalAbortOption = ownData(stateOptions, 'shouldAbort');
    const deterministic = deterministicOption.present && deterministicOption.valid
      && deterministicOption.value === true;
    const externalAbort = externalAbortOption.present && externalAbortOption.valid
      && typeof externalAbortOption.value === 'function' ? externalAbortOption.value : null;
    const invalidExternalAbort = externalAbortOption.present
      && (!externalAbortOption.valid || typeof externalAbortOption.value !== 'function');
    const totalStart = clock();
    const totalBudget = this.budget.timeBudgetMs;
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
        const passBudget = {
          ...this.budget,
          ...safeDataProperties(pass.budget),
        };
        const passRemaining = Math.max(0, deadline - clock());
        passBudget.timeBudgetMs = Math.min(
          validTimeBudgetMs(passBudget.timeBudgetMs, DEFAULT_PASS_BUDGET.timeBudgetMs),
          passRemaining,
        );
        passBudget.nodeBudget = validWorkLimit(passBudget.nodeBudget, DEFAULT_PASS_BUDGET.nodeBudget);
        passBudget.maxIterations = validWorkLimit(passBudget.maxIterations, DEFAULT_PASS_BUDGET.maxIterations);
        passBudget.remainingTimeMs = passRemaining;
        passBudget.deadline = deadline;
        passBudget.degraded = !!state.degraded;
        passBudget.deterministic = deterministic;
        passBudget.shouldAbort = () => {
          if (invalidExternalAbort) return true;
          if (!deterministic && clock() >= deadline) return true;
          if (!externalAbort) return false;
          try { return externalAbort() === true; } catch { return true; }
        };

        const result = pass.run(state, passBudget);
        if (result && result !== state) Object.assign(state, result);
        const elapsedMs = clock() - start;
        if (clock() >= deadline) state.degraded = true;
        state.passMetrics.push({ name: pass.name, elapsedMs, ok: true, degraded: !!state.degraded });
      } catch (error) {
        state.warnings.push(`${pass.name}: ${error?.message || String(error)}`);
        state.passMetrics.push({ name: pass.name, elapsedMs: clock() - start, ok: false, degraded: true });
        if (pass.required) throw error;
        state.degraded = true;
      }
    }
    materializeLegacyExactStackValues(state, {
      deterministicTransforms:deterministic,
      deadline,
      shouldAbort:() => {
        if (invalidExternalAbort) return true;
        if (!deterministic && clock() >= deadline) return true;
        if (!externalAbort) return false;
        try { return externalAbort() === true; } catch { return true; }
      },
    });
    state.passElapsedMs = clock() - totalStart;
    state.passDeadlineExceeded = !deterministic && state.passElapsedMs > totalBudget;
    return state;
  }
}
