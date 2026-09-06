import assert from 'node:assert/strict';
import { ProposalExecutor } from '../js/ai/interaction/proposal-executor.js';

function proposalStore(proposal) {
  return {
    approve(id) {
      assert.equal(id, proposal.id);
      return { proposal, approvalToken: 'approval-token' };
    },
    executionView() { return proposal; },
    async apply(id, { apply }) {
      assert.equal(id, proposal.id);
      await apply(proposal);
      return { ...proposal, status: 'applied' };
    },
  };
}

const previousDocument = globalThis.document;
const documentTarget = new EventTarget();
globalThis.document = documentTarget;

try {
  {
    const controller = new AbortController();
    let liveName = null;
    let executed = false;
    const app = {
      notes: { id: null, nameOf: () => null },
      noteAttachController: controller,
      symbols: { nameAt: () => null },
    };
    const proposal = { id: 'p-ready', kind: 'rename', target: { address: '4096' }, before: null, after: 'ready_name' };
    const capabilityExecutor = {
      async execute(id, args) {
        assert.equal(id, 'annotation.rename');
        assert.equal(app.notes.id, 'binary-1', 'mutation must not run against the unbound NoteStore');
        executed = true;
        liveName = args.value;
        return { ok: true };
      },
    };
    const executor = new ProposalExecutor({ store: proposalStore(proposal), capabilityExecutor, app });
    const pending = executor.approveAndApply(proposal.id);
    await Promise.resolve();
    assert.equal(executed, false, 'proposal must wait while NoteStore identity is still attaching');

    app.notes = { id: 'binary-1', nameOf: () => liveName };
    documentTarget.dispatchEvent(new Event('hex:notes-attached'));
    const result = await pending;
    assert.equal(result.proposal.status, 'applied');
    assert.equal(executed, true);
    assert.equal(liveName, 'ready_name');
  }

  {
    const controller = new AbortController();
    let executed = false;
    const app = {
      notes: { id: null, nameOf: () => null },
      noteAttachController: controller,
      symbols: { nameAt: () => null },
    };
    const proposal = { id: 'p-abort', kind: 'rename', target: { address: '8192' }, before: null, after: 'stale_name' };
    const executor = new ProposalExecutor({
      store: proposalStore(proposal),
      capabilityExecutor: { async execute() { executed = true; return { ok: true }; } },
      app,
    });
    const pending = executor.approveAndApply(proposal.id);
    await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, (error) => error?.type === 'tool_failed' && /binding changed|binding was replaced/.test(error.message));
    assert.equal(executed, false, 'a proposal must fail closed when its file binding is replaced');
  }
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}

console.log('ai-proposal-note-readiness: ok');
