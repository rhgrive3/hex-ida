import { children, mapChildren, nodeCount, structuralKey } from '../ast/nodes.js';

export const DEFAULT_REWRITE_BUDGET = Object.freeze({
  maxIterations: 12,
  nodeBudget: 4096,
  timeBudgetMs: 18,
  maxApplications: 2048,
});

function now() { return globalThis.performance?.now ? globalThis.performance.now() : Date.now(); }

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

/* Read option values without invoking a getter or a coercion hook.  Rewrite
 * budgets are a resource boundary, so an object which can execute code while
 * being converted to a number must be rejected rather than evaluated. */
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

function strictBudget(budget, key, fallback) {
  const option = ownData(budget, key);
  return option.present && option.valid ? option.value : fallback;
}

function validDeadline(value) {
  return typeof value === 'number' && (Number.isFinite(value) || value === Infinity);
}

function validateRule(rule) {
  for (const key of ['name', 'phase', 'match', 'rewrite', 'proof']) {
    if (rule?.[key] == null) throw new TypeError(`rewrite rule missing ${key}`);
  }
  if (typeof rule.match !== 'function' || typeof rule.rewrite !== 'function') throw new TypeError(`rewrite rule ${rule.name} has invalid callbacks`);
  if (rule.precondition != null && typeof rule.precondition !== 'function') throw new TypeError(`rewrite rule ${rule.name} has invalid precondition`);
  return Object.freeze({ cost: () => 0, repeatability: 'fixed-point', ...rule });
}

export class RewriteEngine {
  constructor(rules = [], budget = {}) {
    this.rules = rules.map(validateRule);
    this.budget = {
      maxIterations: strictBudget(budget, 'maxIterations', DEFAULT_REWRITE_BUDGET.maxIterations),
      nodeBudget: strictBudget(budget, 'nodeBudget', DEFAULT_REWRITE_BUDGET.nodeBudget),
      timeBudgetMs: strictBudget(budget, 'timeBudgetMs', DEFAULT_REWRITE_BUDGET.timeBudgetMs),
      maxApplications: strictBudget(budget, 'maxApplications', DEFAULT_REWRITE_BUDGET.maxApplications),
    };
    const deterministic = ownData(budget, 'deterministic');
    if (deterministic.present && deterministic.valid && typeof deterministic.value === 'boolean') {
      this.budget.deterministic = deterministic.value;
    }
    this.budget.timeBudgetMs = validTimeBudgetMs(this.budget.timeBudgetMs, DEFAULT_REWRITE_BUDGET.timeBudgetMs);
    this.budget.maxIterations = validWorkLimit(this.budget.maxIterations, DEFAULT_REWRITE_BUDGET.maxIterations);
    this.budget.nodeBudget = validWorkLimit(this.budget.nodeBudget, DEFAULT_REWRITE_BUDGET.nodeBudget);
    this.budget.maxApplications = validWorkLimit(this.budget.maxApplications, DEFAULT_REWRITE_BUDGET.maxApplications);
  }

  rewrite(root, context = {}) {
    const started = now();
    /*
     * The wall-clock valve exists so a pathological function cannot hang an
     * interactive iPad session, and that is a real release constraint. But it
     * makes the rewrite fixed point a function of machine speed: the same input
     * reaches a different fixed point on different runs, and the difference is
     * visible in the output. Measurement therefore has to be able to turn it
     * off, or a Phase 8 quality baseline would be measuring the host, not the
     * decompiler.
     *
     * `deterministicTransforms` disables only the time-based cutoff. The work
     * bounds (iterations, applications, node budget) still apply, so this is not
     * an unbounded mode — it is the same engine bounded by work instead of by
     * clock. Production defaults are unchanged.
     */
    const deterministicOption = ownData(context, 'deterministicTransforms');
    const callbackOption = ownData(context, 'shouldAbort');
    const deadlineOption = ownData(context, 'deadline');
    const contextInvalid = (deterministicOption.present && !deterministicOption.valid)
      || (callbackOption.present && (!callbackOption.valid || typeof callbackOption.value !== 'function'))
      || (deadlineOption.present && (!deadlineOption.valid || !validDeadline(deadlineOption.value)));
    const deterministic = (deterministicOption.present && deterministicOption.valid
      && deterministicOption.value === true) || this.budget.deterministic === true;
    const localDeadline = deterministic ? Infinity : started + this.budget.timeBudgetMs;
    const contextDeadline = deadlineOption.present && deadlineOption.valid ? deadlineOption.value : Infinity;
    const deadline = !deterministic && Number.isFinite(contextDeadline)
      ? Math.min(localDeadline, contextDeadline)
      : localDeadline;
    const proof = [];
    const stats = { iterations: 0, applications: 0, budgetExceeded: false, elapsedMs: 0, byRule: {} };
    const phases = [...new Set(this.rules.map((r) => r.phase))];
    let current = root;
    let cancelled = contextInvalid;

    const overBudget = (candidate = current) => {
      if (cancelled) return true;
      if (stats.applications >= this.budget.maxApplications) return true;
      if (nodeCount(candidate, new Set(), this.budget.nodeBudget) > this.budget.nodeBudget) return true;
      if (now() >= deadline) { cancelled = true; return true; }
      if (callbackOption.present) {
        try {
          if (callbackOption.value() === true) { cancelled = true; return true; }
        } catch {
          cancelled = true;
          return true;
        }
      }
      return false;
    };

    const visitIterative = (rootNode, rules) => {
      if (!rootNode) return rootNode;
      const rewritten = new Map();
      const active = new Set();
      const stack = [{ n: rootNode, exit: false }];
      while (stack.length) {
        const frame = stack.pop();
        const n = frame.n;
        if (!n || rewritten.has(n)) continue;
        if (overBudget(n)) { stats.budgetExceeded = true; rewritten.set(n, n); continue; }
        if (!frame.exit) {
          if (active.has(n)) { rewritten.set(n, n); continue; }
          active.add(n);
          stack.push({ n, exit: true });
          const kids = children(n);
          for (let i = kids.length - 1; i >= 0; i--) if (kids[i] && !rewritten.has(kids[i])) stack.push({ n: kids[i], exit: false });
          continue;
        }

        let candidate = mapChildren(n, (child) => rewritten.get(child) || child);
        for (const rule of rules) {
          if (overBudget(candidate)) { stats.budgetExceeded = true; break; }
          const match = rule.match(candidate, context);
          if (!match) continue;
          if (rule.precondition && !rule.precondition(candidate, match, context)) continue;
          const beforeKey = structuralKey(candidate);
          const next = rule.rewrite(candidate, match, context);
          if (!next) continue;
          const afterKey = structuralKey(next);
          if (beforeKey === afterKey) continue;
          const beforeCost = Number(rule.cost(candidate, context) ?? 0);
          const afterCost = Number(rule.cost(next, context) ?? 0);
          if (!rule.allowExpansion && afterCost > beforeCost) continue;
          const evidence = typeof rule.proof === 'function' ? rule.proof(candidate, next, match, context) : rule.proof;
          if (!evidence) continue;
          proof.push({ rule: rule.name, phase: rule.phase, before: beforeKey, after: afterKey, evidence });
          stats.applications++;
          stats.byRule[rule.name] = (stats.byRule[rule.name] || 0) + 1;
          candidate = next;
          if (rule.repeatability === 'once') break;
        }
        rewritten.set(n, candidate);
        active.delete(n);
      }
      return rewritten.get(rootNode) || rootNode;
    };

    for (const phase of phases) {
      const rules = this.rules.filter((r) => r.phase === phase);
      let iterations = 0;
      while (iterations++ < this.budget.maxIterations) {
        if (overBudget(current)) { stats.budgetExceeded = true; break; }
        stats.iterations++;
        const before = structuralKey(current);
        current = visitIterative(current, rules);
        const after = structuralKey(current);
        if (before === after || stats.budgetExceeded) break;
      }
      if (stats.budgetExceeded) break;
    }
    stats.elapsedMs = now() - started;
    // A caller cancellation or deadline may arrive after one or more local
    // rewrites.  Do not publish that partial fixed point as if the pass had
    // completed: the recovery wrappers can then remain transaction-like.
    if (cancelled) {
      current = root;
      // Proof entries describe the candidate tree that was rejected by the
      // cancellation boundary; retaining them would let a caller publish
      // evidence for a rewrite which is no longer present.
      proof.length = 0;
    }
    return { root: current, proof, stats };
  }
}
