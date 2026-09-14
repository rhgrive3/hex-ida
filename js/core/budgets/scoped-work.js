/** Cooperative query work on the canonical ResourceBudget owner. */
import { ResourceBudget, BudgetExceededError } from './index.js';
import { deepFreeze } from '../identity/index.js';
import { exactInteger, exactString, recordFields, snapshotContractData, contractFail } from '../identity/structured.js';

export const SCOPED_WORK_SCHEMA = 'scoped-work/v1';
export const INTERACTIVE_QUERY_LIMITS = Object.freeze({
  workUnits: 100000, bytesRead: 8 * 1024 * 1024, residentBytes: 16 * 1024 * 1024,
  artifactsMaterialized: 256, pagesFetched: 512, queueOperations: 100000,
  nodes: 16384, edges: 65536, results: 256, calls: 128,
  deadlineMs: 1000, yieldEvery: 256,
});
export const MAXIMUM_QUERY_LIMITS = Object.freeze({
  workUnits: 100000000, bytesRead: 1024 * 1024 * 1024, residentBytes: 256 * 1024 * 1024,
  artifactsMaterialized: 100000, pagesFetched: 100000, queueOperations: 100000000,
  nodes: 1000000, edges: 4000000, results: 100000, calls: 100000,
  deadlineMs: 120000, yieldEvery: 4096,
});
let nextScope = 0;
const SCOPES = new WeakSet();
const now = () => globalThis.performance?.now?.() ?? Date.now();

export class AnalysisWorkStopped extends Error {
  constructor(status, reason, cost = null) {
    super(reason); this.name = 'AnalysisWorkStopped'; this.code = status; this.status = status; this.cost = cost;
  }
}

export function normalizeQueryLimits(input = {}) {
  const data = snapshotContractData(input);
  recordFields(data, Object.keys(INTERACTIVE_QUERY_LIMITS), 'query-budget-unknown-field');
  const limits = {};
  for (const [name, value] of Object.entries(INTERACTIVE_QUERY_LIMITS)) {
    limits[name] = exactInteger(Object.hasOwn(data, name) ? data[name] : value, `query-budget-invalid:${name}`, {
      min: name === 'yieldEvery' ? 1 : 0, max: MAXIMUM_QUERY_LIMITS[name],
    });
  }
  return Object.freeze(limits);
}

/**
 * The only counters live in ResourceBudget. The wrapper adds finite elapsed-time
 * limits and cooperative yields, never a second scheduler. A timeout bounds our
 * await, not arbitrary provider CPU: providers still need worker/process isolation.
 */
export class ScopedAnalysisWork {
  #budget; #limits; #controller; #externalSignal; #abortListener; #started;
  #disposed = false; #sinceYield = 0; #parent; #name; #timer; #parentAbortListener;
  constructor({ limits = {}, parentBudget = null, signal = null, name = 'semantic-query' } = {}) {
    exactString(name, 'query-work-name', 128);
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) contractFail('query-work-name');
    if (parentBudget !== null && !(parentBudget instanceof ResourceBudget)) contractFail('query-parent-budget-required');
    this.#limits = normalizeQueryLimits(limits);
    this.#controller = new AbortController();
    this.#externalSignal = signal;
    this.#abortListener = () => this.#controller.abort(signal.reason ?? new AnalysisWorkStopped('cancelled', 'query-cancelled'));
    if (signal?.aborted) this.#abortListener();
    else signal?.addEventListener('abort', this.#abortListener, { once: true });
    const resourceLimits = Object.fromEntries(Object.entries(this.#limits).filter(([key]) => !['deadlineMs', 'yieldEvery'].includes(key)));
    this.#name = `${name}.${++nextScope}`;
    this.#parent = parentBudget;
    this.#parentAbortListener = () => this.#controller.abort(parentBudget.signal.reason
      ?? new AnalysisWorkStopped('cancelled', 'parent-query-cancelled'));
    if (parentBudget?.signal?.aborted) this.#parentAbortListener();
    else parentBudget?.signal?.addEventListener('abort', this.#parentAbortListener, { once: true });
    this.#budget = new ResourceBudget(resourceLimits, { parent: parentBudget, name: this.#name, signal: this.#controller.signal });
    this.#started = now();
    this.#timer = setTimeout(() => this.#controller.abort(new AnalysisWorkStopped('timeout', 'query-deadline')), this.#limits.deadlineMs);
    // Kept referenced while work is active: a hung provider Promise alone does
    // not keep a Node host alive long enough to observe an unref'ed deadline.
    SCOPES.add(this);
  }
  get signal() { return this.#controller.signal; }
  get limits() { return this.#limits; }
  checkpoint() {
    if (this.#disposed) throw new AnalysisWorkStopped('cancelled', 'query-work-disposed', this.cost());
    if (this.signal.aborted) {
      if (this.signal.reason instanceof AnalysisWorkStopped) throw this.signal.reason;
      throw new AnalysisWorkStopped('cancelled', 'query-cancelled', this.cost());
    }
    this.#parent?.checkCancelled();
    if (now() - this.#started >= this.#limits.deadlineMs) {
      const error = new AnalysisWorkStopped('timeout', 'query-deadline', this.cost());
      this.#controller.abort(error); throw error;
    }
  }
  charge(resource = 'workUnits', amount = 1) {
    this.checkpoint();
    if (!Object.hasOwn(MAXIMUM_QUERY_LIMITS, resource) || ['deadlineMs', 'yieldEvery'].includes(resource)) contractFail('query-budget-resource');
    exactInteger(amount, 'query-budget-charge');
    try { this.#budget.consume(resource, amount); }
    catch (error) {
      if (error instanceof BudgetExceededError) throw new AnalysisWorkStopped('budget-exhausted', error.message, this.cost());
      throw error;
    }
    if (resource === 'workUnits') this.#sinceYield += amount;
    return this;
  }
  remaining(resource) {
    if (!Object.hasOwn(MAXIMUM_QUERY_LIMITS, resource) || ['deadlineMs', 'yieldEvery'].includes(resource)) contractFail('query-budget-resource');
    return this.#budget.remaining(resource);
  }
  async yieldIfNeeded(force = false) {
    this.checkpoint();
    if (!force && this.#sinceYield < this.#limits.yieldEvery) return;
    this.#sinceYield = 0;
    // Macrotask: Promise.resolve alone starves cancellation on Safari workers.
    await this.await(() => new Promise((resolve) => setTimeout(resolve, 0)), { chargeCall: false });
    this.checkpoint();
  }
  async await(operation, { chargeCall = true } = {}) {
    this.checkpoint();
    if (typeof operation !== 'function') contractFail('query-operation-required');
    if (chargeCall) this.charge('calls');
    const signal = this.signal;
    let cancel;
    const stopped = new Promise((_, reject) => {
      cancel = () => reject(signal.reason instanceof AnalysisWorkStopped ? signal.reason : new AnalysisWorkStopped('cancelled', 'query-cancelled', this.cost()));
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
    try {
      const value = await Promise.race([Promise.resolve().then(() => { this.checkpoint(); return operation(signal); }), stopped]);
      this.checkpoint();
      return value;
    } finally { signal.removeEventListener('abort', cancel); }
  }
  cost() {
    return deepFreeze({ schema: SCOPED_WORK_SCHEMA, limits: this.#limits, used: { ...this.#budget.snapshot().used }, elapsedMs: Math.max(0, now() - this.#started) });
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#timer);
    this.#externalSignal?.removeEventListener('abort', this.#abortListener);
    this.#parent?.signal?.removeEventListener('abort', this.#parentAbortListener);
    if (!this.signal.aborted) this.#controller.abort(new AnalysisWorkStopped('cancelled', 'query-work-disposed'));
    // Parent totals remain charged; only the finished child registry entry is released.
    if (this.#parent?.children.get(this.#name) === this.#budget) this.#parent.children.delete(this.#name);
  }
}
export function assertScopedAnalysisWork(work) {
  if (!SCOPES.has(work)) contractFail('query-work-noncanonical');
  return work;
}
export function workStopStatus(error, signal = null) {
  if (error instanceof AnalysisWorkStopped) return error.status;
  if (error instanceof BudgetExceededError) return 'budget-exhausted';
  if (signal?.aborted || error?.name === 'AbortError') return 'cancelled';
  return null;
}
