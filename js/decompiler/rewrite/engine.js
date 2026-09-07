import { children, mapChildren, nodeCount, structuralKey } from '../ast/nodes.js';
import { isRewriteProof, isRewriteProofFor } from '../verify/equivalence.js';
import { isEGraphCandidate } from '../phase8/egraph.js';

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
    const stats = {
      iterations: 0, applications: 0, budgetExceeded: false, elapsedMs: 0, byRule: {},
      proofChecked: 0, proofAccepted: 0, proofWithheld: 0,
    };
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
          const proofRequired = context.requireProof === true || context.proofRequired === true || rule.requiresProof === true;
          let verifierProof = null;
          if (proofRequired) {
            stats.proofChecked += 1;
            if (typeof context.proofGate !== 'function') {
              stats.proofWithheld += 1;
              continue;
            }
            try { verifierProof = context.proofGate(candidate, next, { rule, match, context, evidence }); }
            catch { verifierProof = null; }
            // The synchronous bridge must never mistake a pending Promise or a
            // copied `{ verdict: 'proved' }` object for proof. Callers with the
            // production async verifier use rewriteAsync below.
            if (verifierProof == null || typeof verifierProof.then === 'function'
                || !isRewriteProof(verifierProof)
                || !isRewriteProofFor(verifierProof, candidate, next, {
                  ...context,
                  proofOptions: context.proofOptions ?? context,
                })) {
              stats.proofWithheld += 1;
              continue;
            }
            stats.proofAccepted += 1;
          }
          const proofEntry = { rule: rule.name, phase: rule.phase, before: beforeKey, after: afterKey, evidence };
          if (verifierProof != null) proofEntry.verifierProof = verifierProof;
          proof.push(proofEntry);
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

  /**
   * Async counterpart used by the optional proof-gated production lane.  The
   * ordinary synchronous decompiler remains unchanged; opting into this path
   * makes every selected rule wait for an exact branded proof token.
   */
  async rewriteAsync(root, context = {}) {
    const started = now();
    const deterministicOption = ownData(context, 'deterministicTransforms');
    const callbackOption = ownData(context, 'shouldAbort');
    const deadlineOption = ownData(context, 'deadline');
    const contextInvalid = (deterministicOption.present && !deterministicOption.valid)
      || (callbackOption.present && (!callbackOption.valid || typeof callbackOption.value !== 'function'))
      || (deadlineOption.present && (!deadlineOption.valid || !validDeadline(deadlineOption.value)));
    const deterministic = (deterministicOption.present && deterministicOption.valid && deterministicOption.value === true)
      || this.budget.deterministic === true;
    const localDeadline = deterministic ? Infinity : started + this.budget.timeBudgetMs;
    const contextDeadline = deadlineOption.present && deadlineOption.valid ? deadlineOption.value : Infinity;
    const deadline = !deterministic && Number.isFinite(contextDeadline) ? Math.min(localDeadline, contextDeadline) : localDeadline;
    const proof = [];
    const stats = {
      iterations: 0, applications: 0, budgetExceeded: false, elapsedMs: 0, byRule: {},
      proofChecked: 0, proofAccepted: 0, proofWithheld: 0,
    };
    const phases = [...new Set(this.rules.map((r) => r.phase))];
    let current = root;
    let cancelled = contextInvalid;
    const overBudget = (candidate = current) => {
      if (cancelled) return true;
      if (stats.applications >= this.budget.maxApplications) return true;
      if (nodeCount(candidate, new Set(), this.budget.nodeBudget) > this.budget.nodeBudget) return true;
      if (!deterministic && now() >= deadline) { cancelled = true; return true; }
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
    const visitAsync = async (rootNode, rules) => {
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
          for (let i = kids.length - 1; i >= 0; i -= 1) if (kids[i] && !rewritten.has(kids[i])) stack.push({ n: kids[i], exit: false });
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
          const proofRequired = context.requireProof === true || context.proofRequired === true || rule.requiresProof === true;
          let verifierProof = null;
          if (proofRequired) {
            stats.proofChecked += 1;
            if (typeof context.proofGate !== 'function') { stats.proofWithheld += 1; continue; }
            try {
              verifierProof = await context.proofGate(candidate, next, { rule, match, context, evidence });
            } catch {
              verifierProof = null;
            }
            if (overBudget(candidate)) { stats.budgetExceeded = true; break; }
            if (!isRewriteProof(verifierProof)
                || !isRewriteProofFor(verifierProof, candidate, next, {
                  ...context,
                  proofOptions: context.proofOptions ?? context,
                })) { stats.proofWithheld += 1; continue; }
            stats.proofAccepted += 1;
          }
          const proofEntry = { rule: rule.name, phase: rule.phase, before: beforeKey, after: afterKey, evidence };
          if (verifierProof != null) proofEntry.verifierProof = verifierProof;
          proof.push(proofEntry);
          stats.applications += 1;
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
        stats.iterations += 1;
        const before = structuralKey(current);
        current = await visitAsync(current, rules);
        const after = structuralKey(current);
        if (before === after || stats.budgetExceeded) break;
      }
      if (stats.budgetExceeded) break;
    }
    stats.elapsedMs = now() - started;
    if (cancelled) { current = root; proof.length = 0; }
    return { root: current, proof, stats };
  }
}

function sourceList(source, plural, singular) {
  const value = source?.[plural] ?? source?.[singular];
  return (Array.isArray(value) ? value : value == null ? [] : [value]).map(String);
}

function candidateOriginCoversRoot(root, origin) {
  if (!origin || typeof origin !== 'object') return false;
  const rootSource = root?.source || {};
  for (const [plural, singular] of [['addresses', 'address'], ['rows', 'row'], ['ir', 'irId'], ['ssaDefs', 'ssaDef'], ['ssaUses', 'ssaUse']]) {
    const required = sourceList(rootSource, plural, singular);
    const provided = sourceList(origin, plural, singular);
    if (required.some((value) => !provided.includes(value))) return false;
  }
  return true;
}

/**
 * Consume bounded e-graph proposals only after the exact symbolic verifier
 * returns a branded proof token. Invalid, stale, unsupported, cancelled and
 * unproved candidates stay withheld and the input expression remains the
 * published value.
 */
export async function adoptProofGatedCandidates(root, candidates = [], options = {}) {
  const started = now();
  const proofGate = options.proofGate;
  const shouldAbort = options.shouldAbort;
  const maxApplications = Number.isSafeInteger(options.maxApplications) && options.maxApplications >= 0
    ? options.maxApplications : 1;
  let current = root;
  const adopted = [];
  const withheld = [];
  const metrics = { considered: 0, adopted: 0, withheld: 0, elapsedMs: 0 };
  const abort = () => {
    try { return typeof shouldAbort === 'function' && shouldAbort() === true; }
    catch { return true; }
  };
  if (typeof proofGate !== 'function') {
    metrics.withheld = Array.isArray(candidates) ? candidates.length : 0;
    metrics.elapsedMs = now() - started;
    return Object.freeze({
      status: 'unknown', root, adopted: Object.freeze([]),
      withheld: Object.freeze(Array.isArray(candidates) ? [...candidates] : []),
      metrics: Object.freeze(metrics),
    });
  }
  if (!Array.isArray(candidates)) {
    metrics.elapsedMs = now() - started;
    return Object.freeze({ status: 'unknown', root, adopted: Object.freeze([]), withheld: Object.freeze([]), metrics: Object.freeze(metrics) });
  }
  for (const candidate of candidates) {
    metrics.considered += 1;
    if (abort()) {
      withheld.push({ candidate, reason: 'cancelled' });
      for (const rest of candidates.slice(metrics.considered)) withheld.push({ candidate: rest, reason: 'cancelled' });
      metrics.withheld = withheld.length;
      metrics.elapsedMs = now() - started;
      return Object.freeze({ status: 'cancelled', root, adopted: Object.freeze([]), withheld: Object.freeze(withheld), metrics: Object.freeze(metrics) });
    }
    if (!isEGraphCandidate(candidate) || candidate.proofRequired !== true) {
      withheld.push({ candidate, reason: 'unbranded-or-unproof-required-candidate' });
      continue;
    }
    if (typeof candidate.inputDigest !== 'string' || !candidate.inputDigest
        || !candidateOriginCoversRoot(root, candidate.origin)) {
      withheld.push({ candidate, reason: 'candidate-identity-or-origin-mismatch' });
      continue;
    }
    if (options.expectedInputDigest != null && candidate.inputDigest !== options.expectedInputDigest) {
      withheld.push({ candidate, reason: 'candidate-input-digest-mismatch' });
      continue;
    }
    if (!candidate.expression || structuralKey(candidate.expression) === structuralKey(current)) {
      withheld.push({ candidate, reason: 'candidate-does-not-change-expression' });
      continue;
    }
    if (adopted.length >= maxApplications) {
      withheld.push({ candidate, reason: 'adoption-budget-exceeded' });
      continue;
    }
    let token = null;
    try { token = await proofGate(current, candidate.expression, {
      candidate,
      phase: 'egraph-adoption',
      proofOptions: options.proofOptions ?? options,
    }); }
    catch { token = null; }
    // A deadline/cancellation can fire while the exact solver is running.  A
    // late answer is not adoptable, even if it is otherwise a valid token.
    if (abort()) {
      withheld.push({ candidate, reason: 'cancelled-after-proof' });
      for (const rest of candidates.slice(metrics.considered)) withheld.push({ candidate: rest, reason: 'cancelled' });
      metrics.withheld = withheld.length;
      metrics.elapsedMs = now() - started;
      return Object.freeze({ status: 'cancelled', root, adopted: Object.freeze([]), withheld: Object.freeze(withheld), metrics: Object.freeze(metrics) });
    }
    if (!isRewriteProof(token) || !isRewriteProofFor(token, current, candidate.expression, {
      candidate,
      phase: 'egraph-adoption',
      proofOptions: options.proofOptions ?? options,
    })) {
      withheld.push({ candidate, reason: 'proof-unknown-or-ineligible' });
      continue;
    }
    current = candidate.expression;
    adopted.push({ candidate, proof: token });
  }
  metrics.adopted = adopted.length;
  metrics.withheld = withheld.length;
  metrics.elapsedMs = now() - started;
  return Object.freeze({
    status: adopted.length > 0 ? 'complete' : 'unknown',
    root: current,
    adopted: Object.freeze(adopted),
    withheld: Object.freeze(withheld),
    metrics: Object.freeze(metrics),
  });
}

/** Synchronous companion for callers that provide an already-cached proof gate. */
export function adoptProofGatedCandidatesSync(root, candidates = [], options = {}) {
  const proofGate = options.proofGate;
  const maxApplications = Number.isSafeInteger(options.maxApplications) && options.maxApplications >= 0
    ? options.maxApplications : 1;
  let current = root;
  const adopted = [];
  const withheld = [];
  const metrics = { considered: 0, adopted: 0, withheld: 0 };
  const abort = () => {
    try { return typeof options.shouldAbort === 'function' && options.shouldAbort() === true; }
    catch { return true; }
  };
  if (typeof proofGate !== 'function' || !Array.isArray(candidates)) {
    return Object.freeze({
      status: 'unknown', root, adopted: Object.freeze([]),
      withheld: Object.freeze(Array.isArray(candidates) ? [...candidates] : []),
      metrics: Object.freeze({ ...metrics, withheld: Array.isArray(candidates) ? candidates.length : 0 }),
    });
  }
  for (const candidate of candidates) {
    metrics.considered += 1;
    if (abort()) {
      withheld.push({ candidate, reason: 'cancelled' });
      for (const rest of candidates.slice(metrics.considered)) withheld.push({ candidate: rest, reason: 'cancelled' });
      metrics.withheld = withheld.length;
      return Object.freeze({ status: 'cancelled', root, adopted: Object.freeze([]), withheld: Object.freeze(withheld), metrics: Object.freeze(metrics) });
    }
    if (!isEGraphCandidate(candidate) || candidate.proofRequired !== true) {
      withheld.push({ candidate, reason: 'unbranded-or-unproof-required-candidate' });
      continue;
    }
    if (typeof candidate.inputDigest !== 'string' || !candidate.inputDigest
        || !candidateOriginCoversRoot(root, candidate.origin)) {
      withheld.push({ candidate, reason: 'candidate-identity-or-origin-mismatch' });
      continue;
    }
    if (options.expectedInputDigest != null && candidate.inputDigest !== options.expectedInputDigest) {
      withheld.push({ candidate, reason: 'candidate-input-digest-mismatch' });
      continue;
    }
    if (!candidate.expression || structuralKey(candidate.expression) === structuralKey(current)) {
      withheld.push({ candidate, reason: 'candidate-does-not-change-expression' });
      continue;
    }
    if (adopted.length >= maxApplications) {
      withheld.push({ candidate, reason: 'adoption-budget-exceeded' });
      continue;
    }
    let token = null;
    try { token = proofGate(current, candidate.expression, {
      candidate,
      phase: 'egraph-adoption',
      proofOptions: options.proofOptions ?? options,
    }); }
    catch { token = null; }
    if (token != null && typeof token.then === 'function') token = null;
    if (!isRewriteProof(token) || !isRewriteProofFor(token, current, candidate.expression, {
      candidate,
      phase: 'egraph-adoption',
      proofOptions: options.proofOptions ?? options,
    })) {
      withheld.push({ candidate, reason: 'proof-unknown-or-ineligible' });
      continue;
    }
    current = candidate.expression;
    adopted.push({ candidate, proof: token });
  }
  metrics.adopted = adopted.length;
  metrics.withheld = withheld.length;
  return Object.freeze({
    status: adopted.length > 0 ? 'complete' : 'unknown',
    root: current,
    adopted: Object.freeze(adopted),
    withheld: Object.freeze(withheld),
    metrics: Object.freeze(metrics),
  });
}
