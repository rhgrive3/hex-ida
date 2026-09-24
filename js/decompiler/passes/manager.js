import { materializeLegacyExactStackValues } from '../legacy-exact-return-repair.js';

function clock() { return globalThis.performance?.now ? globalThis.performance.now() : Date.now(); }

export const DEFAULT_PASS_BUDGET = Object.freeze({ timeBudgetMs: 40, nodeBudget: 12000, maxIterations: 16 });

function validTimeBudgetMs(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function markDegraded(state, reason = null) {
  state.degraded = true;
  if (reason == null) return;
  const reasons = state.degradationReasons instanceof Set
    ? state.degradationReasons
    : (state.degradationReasons = new Set(state.degradationReasons || []));
  reasons.add(reason);
}

function publicReason(state, fallback = null) {
  if (state.transformWorkBudgetExceeded) return 'transform-work-budget';
  if (state.transformDeadlineReason) return state.transformDeadlineReason;
  const reasons = state.degradationReasons;
  if (reasons instanceof Set) {
    for (const reason of ['transform-safety-ceiling', 'transform-time-budget', 'transform-work-budget']) {
      if (reasons.has(reason)) return reason;
    }
  }
  return fallback;
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

function capturePassState(state, shouldAbort = null) {
  const __t0 = globalThis.__hexPerfProbe ? performance.now() : 0; // PERF-PROBE
  const pending = [state], seen = new Set(), records = [];
  let checked = 0;
  while (pending.length) {
    // Snapshot preparation is part of the optional pass budget. It only reads
    // state, so abandoning an incomplete pre-image is safe: simply do not run
    // the pass that would have needed rollback.
    if ((checked & 0xfff) === 0 && typeof shouldAbort === 'function' && shouldAbort()) {
      if (globalThis.__hexPerfProbe) globalThis.__hexPerfProbe.recordCapturePassState?.(performance.now() - __t0, records.length);
      return null;
    }
    checked++;
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
    const externalShouldAbort = typeof state.opts?.shouldAbort === 'function' ? state.opts.shouldAbort : null;
    const now = typeof this.budget.clock === 'function' ? this.budget.clock : clock;
    const totalStart = now();
    const totalBudget = Math.max(0, Number(this.budget.timeBudgetMs ?? DEFAULT_PASS_BUDGET.timeBudgetMs));
    const configuredDeadline = this.budget.deadline == null ? NaN : Number(this.budget.deadline);
    const deadline = deterministic ? Infinity
      : Number.isFinite(configuredDeadline) ? Math.min(configuredDeadline, totalStart + totalBudget)
        : totalStart + totalBudget;
    const deadlineReason = this.budget.deadlineReason || 'transform-time-budget';
    let budgetWarned = false;

    // One run-level cancellation predicate backs both views of the deadline:
    // the `passBudget.shouldAbort` handed to every pass and the
    // `opts.shouldAbort` hook that pass bodies already read through
    // `state.opts` (provenance captures, history observations, idiom walks).
    // The manager publishes it here so a synchronous pass can observe the
    // safety ceiling from inside its own loops instead of only being checked
    // after it returns. The poll counter makes an overrun attributable: a
    // pass that crossed the deadline without ever polling is reported as
    // ignoring it, never silently.
    const deadlinePolls = { calls: 0, reason: null };
    const pollDeadline = () => {
      deadlinePolls.calls += 1;
      // The published hook is called on bounded but tight intervals (per
      // observed node, per recorded selection), so the clock itself is read
      // on a bounded sample of those calls: a per-node consumer cannot burn
      // one clock read per visited node, and the injected-clock determinism
      // contract sees the same sampling on every host. Detection latency is
      // capped at 63 hook calls after the deadline is crossed, each a bounded
      // node/selection check.
      if ((deadlinePolls.calls & 63) === 1 && !deterministic && now() >= deadline) {
        deadlinePolls.reason ||= deadlineReason;
        state.transformDeadlineReason ||= deadlineReason;
        return true;
      }
      if (externalShouldAbort) {
        try {
          if (externalShouldAbort() === true) {
            deadlinePolls.reason ||= 'transform-cancelled';
            return true;
          }
        } catch {
          deadlinePolls.reason ||= 'transform-cancelled';
          return true;
        }
      }
      return false;
    };
    pollDeadline.__hexTransformDeadlinePredicate = true;
    const optsTarget = state.opts && typeof state.opts === 'object' ? state.opts : null;
    const optsAbort = optsTarget && typeof optsTarget.shouldAbort === 'function' ? optsTarget.shouldAbort : null;
    // Caller precedence: an explicit `opts.shouldAbort` is never replaced. A
    // predicate published by an earlier manager run over the same options
    // object is replaced with this run's fresh deadline, and a frozen options
    // object keeps its own view.
    if (optsTarget && Object.isExtensible(optsTarget) && optsAbort !== pollDeadline
        && (optsAbort == null || optsAbort.__hexTransformDeadlinePredicate === true)) {
      try { optsTarget.shouldAbort = pollDeadline; } catch { /* frozen caller options keep their own view */ }
    }

    const phase8Reason = state.phase8?.stopReason;
    if (['transform-safety-ceiling', 'transform-time-budget', 'transform-work-budget', 'phase8-time-budget'].includes(phase8Reason)) {
      const reason = phase8Reason === 'phase8-time-budget' ? 'transform-time-budget' : phase8Reason;
      markDegraded(state, reason);
      const warning = reason === 'transform-work-budget'
        ? 'Decompiler Phase 8 work budget reached; the phase was conservatively withheld.'
        : 'Decompiler pass budget exhausted before semantic transforms; optional passes were skipped.';
      if (!state.warnings.includes(warning)) state.warnings.push(warning);
    }

    for (const pass of this.passes) {
      let rollbackFailed = false;
      const start = now();
      const remainingMs = Math.max(0, deadline - start);
      if (remainingMs <= 0 && !pass.required) {
        if (!budgetWarned) state.warnings.push(`Decompiler pass budget exhausted before ${pass.name}; optional passes were skipped.`);
        budgetWarned = true;
        markDegraded(state, deadlineReason);
        state.transformDeadlineReason ||= deadlineReason;
        state.passMetrics.push({ name: pass.name, elapsedMs: 0, ok: true, skipped: true, reason: 'deadline', degradationReason: deadlineReason, degraded: true });
        continue;
      }

      if (remainingMs <= 0) {
        if (!budgetWarned) state.warnings.push(`Decompiler pass budget exhausted before ${pass.name}; only required finalization may continue.`);
        budgetWarned = true;
        markDegraded(state, deadlineReason);
        state.transformDeadlineReason ||= deadlineReason;
      }

      try {
        // Passes receive an absolute deadline and a cheap synchronous cancellation
        // predicate. Expensive passes are expected to poll shouldAbort() at bounded
        // intervals; once the deadline is crossed the manager never starts another
        // optional pass. Required representation/finalization passes still run so the
        // public result remains structurally valid.
        const passBudget = { ...this.budget, ...(pass.budget || {}) };
        const passRemaining = remainingMs;
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
        const passStart = start;
        const passDeadline = deterministic || passLocalBudget == null
          ? deadline
          : Math.min(deadline, passStart + passLocalBudget);
        passBudget.remainingTimeMs = Math.max(0, passDeadline - start);
        passBudget.deadline = passDeadline;
        passBudget.degraded = !!state.degraded;
        passBudget.deterministic = deterministic;
        let lastAbortReason = null;
        passBudget.deadlineReason = deadlineReason;
        passBudget.abortReason = () => lastAbortReason;
        passBudget.shouldAbort = () => {
          // Counted against the run-level poll counter so the manager can
          // tell whether this pass polled the deadline while it ran.
          deadlinePolls.calls += 1;
          if (!deterministic && now() >= passDeadline) {
            lastAbortReason = deadlineReason;
            state.transformDeadlineReason ||= deadlineReason;
            return true;
          }
          if (externalShouldAbort) {
            try {
              if (externalShouldAbort() === true) {
                lastAbortReason = 'transform-cancelled';
                return true;
              }
            } catch {
              lastAbortReason = 'transform-cancelled';
              return true;
            }
          }
          return false;
        };

        if (pass.required) {
          const pollsBeforeBody = deadlinePolls.calls;
          const result = pass.run(state, passBudget);
          if (result && result !== state) Object.assign(state, result);
          const endedAt = now();
          const elapsedMs = endedAt - start;
          const deadlineHit = !deterministic && endedAt >= passDeadline;
          const overrunMs = deadlineHit ? endedAt - passDeadline : 0;
          const polledDuringBody = deadlinePolls.calls > pollsBeforeBody;
          if (deadlineHit) {
            state.transformDeadlineReason ||= deadlineReason;
            state.passOverrunMs = Math.max(Number(state.passOverrunMs) || 0, overrunMs);
            markDegraded(state, deadlineReason);
            if (!budgetWarned) {
              state.warnings.push(`Decompiler pass budget exhausted while running ${pass.name}; output was conservatively degraded.`);
              budgetWarned = true;
            }
          }
          const degradationReason = publicReason(state, lastAbortReason);
          if (degradationReason) markDegraded(state, degradationReason);
          state.passMetrics.push({ name: pass.name, elapsedMs, ok: true,
            ...(degradationReason ? { degradationReason } : {}), degraded: !!state.degraded,
            ...(deadlineHit ? { overrunMs: Math.round(overrunMs), polledDeadline: polledDuringBody } : {}) });
          continue;
        }

        // #5113 rollback must not replace canonical IR/expression identities on
        // success: provenance producers use private identity-bound observations.
        // Run synchronously on the real graph; retain descriptors and collection
        // entries so a failure restores pass-owned data in place (including
        // aliases/cycles). This does not roll back external adapter side effects.
        const restore = capturePassState(state, passBudget.shouldAbort);
        if (restore == null || passBudget.shouldAbort()) {
          if (!budgetWarned) state.warnings.push(`Decompiler pass budget exhausted while preparing ${pass.name}; optional pass was skipped.`);
          budgetWarned = true;
          const abortReason = lastAbortReason || deadlineReason;
          if (abortReason === deadlineReason) state.transformDeadlineReason ||= deadlineReason;
          markDegraded(state, abortReason);
          state.passMetrics.push({
            name: pass.name,
            elapsedMs: now() - start,
            ok: true,
            skipped: true,
            reason: 'snapshot-deadline',
            degradationReason: abortReason,
            degraded: true,
          });
          continue;
        }
        try {
          const pollsBeforeBody = deadlinePolls.calls;
          const result = pass.run(state, passBudget);
          if (result && result !== state) Object.assign(state, result);
          const endedAt = now();
          const elapsedMs = endedAt - start;
          const deadlineHit = !deterministic && endedAt >= passDeadline;
          const overrunMs = deadlineHit ? endedAt - passDeadline : 0;
          const polledDuringBody = deadlinePolls.calls > pollsBeforeBody;
          if (deadlineHit) {
            state.transformDeadlineReason ||= deadlineReason;
            state.passOverrunMs = Math.max(Number(state.passOverrunMs) || 0, overrunMs);
            markDegraded(state, deadlineReason);
            if (!budgetWarned) {
              state.warnings.push(`Decompiler pass budget exhausted while running ${pass.name}; output was conservatively degraded.`);
              budgetWarned = true;
            }
          }
          if (state.transformWorkBudgetExceeded) markDegraded(state, 'transform-work-budget');
          const degradationReason = publicReason(state, lastAbortReason);
          if (degradationReason) markDegraded(state, degradationReason);
          state.passMetrics.push({ name: pass.name, elapsedMs, ok: true,
            ...(degradationReason ? { degradationReason } : {}), degraded: !!state.degraded,
            ...(deadlineHit ? { overrunMs: Math.round(overrunMs), polledDeadline: polledDuringBody } : {}) });
        } catch (error) {
          try { restore(); } catch (rollbackError) {
            // Irreversible descriptor changes cannot be called a recovered
            // optional failure. Stop before any finalizer consumes corrupt data.
            rollbackFailed = true;
            throw new Error('optional-pass-rollback-failed', { cause:rollbackError });
          }
          state.warnings.push(`${pass.name}: ${error?.message || String(error)}`);
          state.passMetrics.push({ name: pass.name, elapsedMs: now() - start, ok: false, degraded: true });
          markDegraded(state, 'transform-pass-failure');
        }
      } catch (error) {
        state.warnings.push(`${pass.name}: ${error?.message || String(error)}`);
        state.passMetrics.push({ name: pass.name, elapsedMs: now() - start, ok: false, degraded: true });
        if (pass.required || rollbackFailed) throw error;
        markDegraded(state, 'transform-pass-failure');
      }
    }
    materializeLegacyExactStackValues(state);
    const endedAt = now();
    state.passElapsedMs = endedAt - totalStart;
    state.passDeadlineExceeded = !deterministic && endedAt >= deadline;
    globalThis.__hexPerfProbe?.recordPasses?.(state.passMetrics, state.passElapsedMs); // PERF-PROBE
    return state;
  }
}
