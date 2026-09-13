import assert from 'node:assert/strict';
import { startParentDevWorkerRuntime } from '../js/userscript/dev/parent-worker-runtime.js';

const POOL_OP = Symbol('worker-pool-original-operation');
let requireLeaseCalls = 0;
let poolCloseCalls = 0;

class FakeController {
  constructor() { this.listeners = new Set(); }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  currentConversation() { return { id: 'supervisor-conversation' }; }
}

function validPool() {
  return {
    start() { return POOL_OP; },
    followup() { return POOL_OP; },
    requireLease() { requireLeaseCalls += 1; throw new Error('completion-bridge wrapper still owns the injected pool.'); },
    async claim() { return { leaseId: 'lease-1' }; },
    async release() { return { released: true }; },
    async waitResult() { return null; },
    status() { return { workers: 0 }; },
    close() { poolCloseCalls += 1; },
  };
}

const controller = new FakeController();
const workerPool = validPool();
const pageInspector = { snapshot() {}, scripts() {}, scriptSource() {} };
const skillRegistry = { list() { return []; }, describe() {}, installCandidate() {}, validateCandidate() {}, activate() {}, rollback() {}, run() {} };

const runtime = await startParentDevWorkerRuntime({
  controller,
  workerPool,
  pageInspector,
  skillRegistry,
  now: () => '2026-09-12T00:00:00.000Z',
  cryptoRef: { getRandomValues(bytes) { return bytes; } },
  taskGraphPollMs: Infinity,
});

{
  assert.equal(runtime.enabled, false, 'a later constructor throw must still yield a disabled runtime');
}

{
  const startResult = workerPool.start({});
  Promise.resolve(startResult).catch(() => {});
  assert.equal(startResult, POOL_OP, 'failed initialization must restore the injected workerPool.start to the original method');
  const followupResult = workerPool.followup({});
  Promise.resolve(followupResult).catch(() => {});
  assert.equal(followupResult, POOL_OP, 'failed initialization must restore the injected workerPool.followup to the original method');
  assert.equal(requireLeaseCalls, 0, 'no completion-bridge wrapper may remain on the injected workerPool');
}

{
  assert.equal(controller.listeners.size, 0, 'failed initialization must close the coordinator and drop its controller subscription');
  assert.equal(poolCloseCalls, 0, 'rollback must not close an externally injected workerPool it does not own');
}

{
  await assert.rejects(() => runtime.poolStart({ leaseId: 'lease-1' }), (error) => !!error.code);
  runtime.close();
}

console.log('issue-5090-parent-runtime-init-rollback: PASS');
