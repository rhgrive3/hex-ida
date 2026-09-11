// Regression test for #5935: ProposalStore must preserve authoritative
// patch before/after payloads without display truncation in executionView,
// preventing data loss for proposals exceeding 1000 bytes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProposalStore } from '../../../js/ai/proposals.js';
import { ProposalExecutor } from '../../../js/ai/interaction/proposal-executor.js';

const evidenceStore = { has: (id) => id === 'verified-evidence' };

test('#5935: 1000-byte patch proposal applies cleanly', async () => {
  const store = new ProposalStore({ evidenceStore });
  const before = new Array(1000).fill(0x11);
  const after = new Array(1000).fill(0x22);
  const proposal = store.create({
    kind: 'patch',
    target: { address: '0x1000' },
    before,
    after,
    evidenceIds: ['verified-evidence'],
  });

  let executedArgs = null;
  const executor = new ProposalExecutor({
    store,
    capabilityExecutor: {
      async execute(_cap, args) {
        executedArgs = args;
        return { after: args.after };
      },
    },
    app: {
      backend: {
        async readAt(_addr, len) {
          return { found: true, bytes: new Uint8Array(len).fill(0x11) };
        },
      },
    },
  });

  await executor.approveAndApply(proposal.id);
  assert.equal(executedArgs.before.length, 1000);
  assert.equal(executedArgs.after.length, 1000);
  assert.equal(store.get(proposal.id).status, 'applied');
});

test('#5935: 1001-byte patch proposal preserves full payload in execution and apply', async () => {
  const store = new ProposalStore({ evidenceStore });
  const before = new Array(1001).fill(0xaa);
  before[1000] = 0xab;
  const after = new Array(1001).fill(0xba);
  after[1000] = 0xbb;

  const proposal = store.create({
    kind: 'patch',
    target: { address: '0x2000' },
    before,
    after,
    evidenceIds: ['verified-evidence'],
  });

  // Public record is bounded for display/wire consumers
  assert.equal(proposal.before.length, 1000, 'public record before is truncated to 1000');
  assert.equal(proposal.after.length, 1000, 'public record after is truncated to 1000');

  // Execution view preserves full authoritative payload
  const execView = store.executionView(proposal.id);
  assert.equal(execView.before.length, 1001, 'execution view before retains 1001 bytes');
  assert.equal(execView.after.length, 1001, 'execution view after retains 1001 bytes');
  assert.equal(execView.before[1000], 0xab);
  assert.equal(execView.after[1000], 0xbb);

  let executedArgs = null;
  const executor = new ProposalExecutor({
    store,
    capabilityExecutor: {
      async execute(_cap, args) {
        executedArgs = args;
        return { after: args.after };
      },
    },
    app: {
      backend: {
        async readAt(_addr, len) {
          const arr = new Uint8Array(len).fill(0xaa);
          arr[1000] = 0xab;
          return { found: true, bytes: arr };
        },
      },
    },
  });

  await executor.approveAndApply(proposal.id);
  assert.ok(executedArgs, 'capability execution ran');
  assert.equal(executedArgs.before.length, 1001, 'applied before receives full 1001 bytes');
  assert.equal(executedArgs.after.length, 1001, 'applied after receives full 1001 bytes');
  assert.equal(executedArgs.before[1000], 0xab);
  assert.equal(executedArgs.after[1000], 0xbb);
  assert.equal(store.get(proposal.id).status, 'applied');
});

test('#5935: changing 1001st before byte in live state rejects proposal as stale', async () => {
  const store = new ProposalStore({ evidenceStore });
  const before = new Array(1001).fill(0xaa);
  before[1000] = 0xab;
  const after = new Array(1001).fill(0xba);
  after[1000] = 0xbb;

  const proposal = store.create({
    kind: 'patch',
    target: { address: '0x3000' },
    before,
    after,
    evidenceIds: ['verified-evidence'],
  });

  const executor = new ProposalExecutor({
    store,
    capabilityExecutor: {
      async execute() {
        return {};
      },
    },
    app: {
      backend: {
        async readAt(_addr, len) {
          const arr = new Uint8Array(len).fill(0xaa);
          arr[1000] = 0xff; // Modified 1001st byte in live state!
          return { found: true, bytes: arr };
        },
      },
    },
  });

  await assert.rejects(
    executor.approveAndApply(proposal.id),
    (err) => err.type === 'tool_failed' && /target changed/.test(err.message),
    'must reject as stale when 1001st byte does not match',
  );
  assert.equal(store.get(proposal.id).status, 'failed');
});
