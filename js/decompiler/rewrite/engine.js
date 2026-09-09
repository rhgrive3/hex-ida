import { children, mapChildren, nodeCount, sourceOf, structuralKey } from '../ast/nodes.js';

export const DEFAULT_REWRITE_BUDGET = Object.freeze({
  maxIterations: 12,
  nodeBudget: 4096,
  timeBudgetMs: 18,
  maxApplications: 2048,
  maxHistoryOrigins: 512,
});

function now() { return globalThis.performance?.now ? globalThis.performance.now() : Date.now(); }

// A historical source snapshot, not a new AST/semantic identity. Do not retain
// mutable nodes or evidence chains here: later rewrites and callers may mutate
// them, and recursively retaining proof evidence would grow the history.
function sourceSnapshot(node, cap) {
  const { evidence, ...origins } = sourceOf(node?.source);
  let remaining = cap, truncated = false;
  const snapshot = {};
  for (const [kind, values] of Object.entries(origins)) {
    const retained = values.slice(0, remaining);
    remaining -= retained.length;
    truncated ||= retained.length !== values.length;
    snapshot[kind] = Object.freeze(retained);
  }
  return { origins:Object.freeze(snapshot), truncated };
}

// Shared by real expression producers, including CFG-backed recovery passes.
// This records history only; it grants neither rewrite admission nor a binding.
export function expressionOriginHistory(before, after, maximum = 512) {
  const cap = Number.isSafeInteger(maximum) && maximum >= 0 ? Math.min(maximum, 512) : 512;
  const left = sourceSnapshot(before, cap), right = sourceSnapshot(after, cap);
  return Object.freeze({ before:left.origins, after:right.origins,
    truncated:left.truncated || right.truncated });
}

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
    this.budget = { ...DEFAULT_REWRITE_BUDGET, ...budget };
    this.budget.timeBudgetMs = validTimeBudgetMs(this.budget.timeBudgetMs, DEFAULT_REWRITE_BUDGET.timeBudgetMs);
    this.budget.maxIterations = validWorkLimit(this.budget.maxIterations, DEFAULT_REWRITE_BUDGET.maxIterations);
    this.budget.nodeBudget = validWorkLimit(this.budget.nodeBudget, DEFAULT_REWRITE_BUDGET.nodeBudget);
    this.budget.maxApplications = validWorkLimit(this.budget.maxApplications, DEFAULT_REWRITE_BUDGET.maxApplications);
    this.budget.maxHistoryOrigins = validWorkLimit(this.budget.maxHistoryOrigins, DEFAULT_REWRITE_BUDGET.maxHistoryOrigins);
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
    const deterministic = context.deterministicTransforms === true || this.budget.deterministic === true;
    const localDeadline = deterministic ? Infinity : started + Math.max(0, Number(this.budget.timeBudgetMs));
    const contextDeadline = Number(context.deadline);
    const deadline = !deterministic && Number.isFinite(contextDeadline)
      ? Math.min(localDeadline, contextDeadline)
      : localDeadline;
    const proof = [];
    const stats = { iterations: 0, applications: 0, budgetExceeded: false, elapsedMs: 0, byRule: {} };
    const phases = [...new Set(this.rules.map((r) => r.phase))];
    let current = root;

    const overBudget = (candidate = current) => {
      if (stats.applications >= this.budget.maxApplications) return true;
      if (nodeCount(candidate, new Set(), this.budget.nodeBudget) > this.budget.nodeBudget) return true;
      if (now() >= deadline || context.shouldAbort?.()) return true;
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
          const beforeOrigins = sourceSnapshot(candidate, this.budget.maxHistoryOrigins);
          const next = rule.rewrite(candidate, match, context);
          if (!next) continue;
          const afterKey = structuralKey(next);
          if (beforeKey === afterKey) continue;
          const beforeCost = Number(rule.cost(candidate, context) ?? 0);
          const afterCost = Number(rule.cost(next, context) ?? 0);
          if (!rule.allowExpansion && afterCost > beforeCost) continue;
          const evidence = typeof rule.proof === 'function' ? rule.proof(candidate, next, match, context) : rule.proof;
          if (!evidence) continue;
          const afterOrigins = sourceSnapshot(next, this.budget.maxHistoryOrigins);
          proof.push({ rule: rule.name, phase: rule.phase, before: beforeKey, after: afterKey, evidence,
            originHistory:Object.freeze({ before:beforeOrigins.origins, after:afterOrigins.origins,
              truncated:beforeOrigins.truncated || afterOrigins.truncated }) });
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
    return { root: current, proof, stats };
  }
}

// A bounded journal around the existing engine, not another optimizer. Recovery
// may explore a subtree and later reject it; marks let that producer discard
// tentative history instead of presenting it as an applied output transform.
export class RewriteHistoryJournal {
  constructor(engine, maximum = 1024) {
    this.engine = engine;
    this.maximum = Number.isSafeInteger(maximum) && maximum >= 0 ? Math.min(maximum, 1024) : 1024;
    this.records = [];
    this.truncated = false;
  }

  rewrite(root, context = {}) {
    const result = this.engine.rewrite(root, context);
    for (const record of result.proof) {
      if (this.records.length < this.maximum) this.records.push(Object.freeze(record));
      else this.truncated = true;
    }
    return result;
  }

  mark() { return { length:this.records.length, truncated:this.truncated }; }
  rollback(mark) { this.records.length = mark.length; this.truncated = mark.truncated; }
  recordsSince(mark) { return Object.freeze(this.records.slice(mark.length)); }
}
