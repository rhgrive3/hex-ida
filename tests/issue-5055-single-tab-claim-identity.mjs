import assert from 'node:assert/strict';
import { SingleConversationWorkerCoordinator } from '../js/userscript/dev/single-tab/single-conversation-worker-coordinator.js';
import { DEV_WORKER_STATE } from '../js/ai/dev/workers/contracts.js';

class FakeController {
  constructor() {
    this.page = { id: 'supervisor-cid', url: 'https://chatgpt.com/c/supervisor-cid' };
    this.listeners = new Set();
    this.state = DEV_WORKER_STATE.STARTING;
    this.active = false;
    this.text = '';
    this.sent = [];
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  currentConversation() { return this.page ? { ...this.page } : null; }
  currentUserAnchors() { return [{ id: 'supervisor-latest', text: 'latest supervisor request' }]; }
  workerConversation() { return null; }
  isActive() { return this.active; }
  async navigateToConversation(conversation) { this.page = { ...conversation }; return this.page; }
  async createChat() { return this.observe(); }
  async send(text) { this.sent.push(text); return { submitted: true, status: this.state }; }
  async followup(text) { this.sent.push(text); return { submitted: true, status: this.state }; }
  async nudge() { return { submitted: true, status: this.state }; }
  async stop() { return { outcome: 'cancel-requested', state: this.state }; }
  observe() { return { state: this.state, chatgptConversationId: null, responseText: this.text, observedAt: new Date().toISOString(), generating: this.active, visibility: 'foreground', observability: 'live' }; }
  result() { return { status: this.state, responseText: this.text, chatgptConversationId: null, observedAt: new Date().toISOString() }; }
}

const controller = new FakeController();
const coordinator = new SingleConversationWorkerCoordinator({ controller, tabNodeId: 'single-tab-5055' });
await coordinator.claim({ runId: 'run-A', workerId: 'worker-A' });

const isMissingIdentity = (error) => error instanceof Error;

// {} must be rejected: no ownership identity means no proof of ownership.
await assert.rejects(() => coordinator.observe({}), isMissingIdentity, 'observe({}) must not bypass ownership verification');
await assert.rejects(() => coordinator.result({}), isMissingIdentity, 'result({}) must not bypass ownership verification');
await assert.rejects(() => coordinator.send({ instruction: 'inject' }), isMissingIdentity, 'send() without identity must not bypass ownership verification');
await assert.rejects(() => coordinator.followup({ text: 'inject' }), isMissingIdentity, 'followup() without identity must not bypass ownership verification');
await assert.rejects(() => coordinator.stop({}), isMissingIdentity, 'stop({}) must not bypass ownership verification');
await assert.rejects(() => coordinator.createChat({}), isMissingIdentity, 'createChat({}) must not bypass ownership verification');
await assert.rejects(() => coordinator.release({}), isMissingIdentity, 'release({}) must not bypass ownership verification');

// The exploit from the issue: release({}) must NOT tear down the run-A/worker-A claim.
assert.equal(coordinator.advertisement().claimed, true, 'release({}) must not clear the active claim');
assert.equal(coordinator.advertisement().runId, 'run-A');
assert.equal(coordinator.advertisement().workerId, 'worker-A');

// Partial identity (one of the two) must be rejected as insufficient proof.
await assert.rejects(() => coordinator.observe({ runId: 'run-A' }), isMissingIdentity, 'missing workerId must be rejected');
await assert.rejects(() => coordinator.observe({ workerId: 'worker-A' }), isMissingIdentity, 'missing runId must be rejected');
await assert.rejects(() => coordinator.release({ workerId: 'worker-A' }), isMissingIdentity, 'partial-identity release must be rejected');
assert.equal(coordinator.advertisement().claimed, true, 'partial-identity release must not clear the claim');

// Both identities present but wrong must be rejected with an ownership error.
await assert.rejects(
  () => coordinator.observe({ runId: 'run-B', workerId: 'worker-B' }),
  (error) => error.code === 'worker-busy',
  'mismatched identity must be rejected',
);
await assert.rejects(
  () => coordinator.release({ runId: 'run-A', workerId: 'worker-B' }),
  (error) => error.code === 'worker-busy',
  'mismatched workerId must be rejected',
);

// Full correct identity continues to work and can release.
await coordinator.observe({ runId: 'run-A', workerId: 'worker-A' });
const released = await coordinator.release({ runId: 'run-A', workerId: 'worker-A' });
assert.equal(released.role, 'available');
assert.equal(released.claimed, false);

coordinator.close();
