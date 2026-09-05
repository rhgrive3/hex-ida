import assert from 'node:assert/strict';
import test from 'node:test';
import { ProposalStore } from '../js/ai/proposals.js';
import { ProposalExecutor } from '../js/ai/interaction/proposal-executor.js';
import { createCapabilityCatalog } from '../js/ai/capabilities/catalog.js';
import { createCapabilityExecutor } from '../js/ai/capabilities/executor.js';
import { PatchSet } from '../js/patch.js';
import { AIError } from '../js/ai/schema.js';

const evidenceStore = { has: (id) => id === 'e1' };
const authorization = { kind: 'proposal', token: '0123456789abcdef' };

function fakeApp(bytes) {
  const backing = Uint8Array.from(bytes);
  return {
    file: new Blob([backing]),
    patches: new PatchSet(),
    backend: { readAt: async (address, length) => ({ found: true, bytes: backing.slice(Number(BigInt(address) - 4096n), Number(BigInt(address) - 4096n) + length) }) },
    store: { get: (key) => (key === 'regions' ? [{ vmAddr: 4096n, fileOffset: 0n, size: 8n, exec: true }] : key === 'fileInfo' ? { size: 8 } : null) },
  };
}

function patchProposal(before, after) {
  const store = new ProposalStore({ evidenceStore });
  const proposal = store.create({ kind: 'patch', target: { address: '4096' }, before, after, evidenceIds: ['e1'] });
  return { store, proposal };
}

test('issue #6171 - canonical byte arrays and Uint8Array still pass the proposal path', async () => {
  const app = fakeApp([1, 2, 3, 4]);
  const catalog = createCapabilityCatalog();
  const capabilityExecutor = createCapabilityExecutor({ catalog, app, binaryId: 'bin-A' });
  const store = new ProposalStore({ evidenceStore });
  const proposal = store.create({ kind: 'patch', target: { address: '4096' }, before: [1, 2, 3, 4], after: Uint8Array.from([4, 3, 2, 1]), evidenceIds: ['e1'] });
  const executor = new ProposalExecutor({ store, capabilityExecutor, app });
  const { proposal: applied } = await executor.approveAndApply(proposal.id);
  assert.equal(applied.status, 'applied');
});

test('issue #6171 - currentState rejects numeric-string bytes instead of coercing them', async () => {
  const { store, proposal } = patchProposal(['1', '2'], ['3', '4']);
  const executor = new ProposalExecutor({ store, capabilityExecutor: {}, app: fakeApp([1, 2, 3, 4]) });
  await assert.rejects(executor.currentState(proposal), (error) => (
    error instanceof AIError && error.type === 'invalid_tool_call' && /non-byte/.test(error.message)
  ));
});

test('issue #6171 - proposalArguments does not launder structured bytes into canonical bytes', async () => {
  const { store, proposal } = patchProposal(['1'], ['2']);
  const executor = new ProposalExecutor({ store, capabilityExecutor: {}, app: fakeApp([1, 2, 3, 4]) });
  await assert.rejects(executor.currentState(proposal), (error) => error instanceof AIError && error.type === 'invalid_tool_call');
});

test('issue #6171 - boolean/null/object bytes fail closed before CapabilityExecutor', async () => {
  for (const [before, after] of [[true, 1], [false, 0], [null, 0], [{ value: 1 }, [1]]]) {
    const { store, proposal } = patchProposal([before], [after]);
    const executor = new ProposalExecutor({ store, capabilityExecutor: {}, app: fakeApp([1, 2, 3, 4]) });
    await assert.rejects(executor.currentState(proposal), (error) => (
      error instanceof AIError && error.type === 'invalid_tool_call' && /non-byte/.test(error.message)
    ), `before ${JSON.stringify(before)} must not become a canonical byte`);
  }
});

test('issue #6171 - out-of-range integers fail closed at the proposal boundary', async () => {
  const { store: invalidStore, proposal: invalidProposal } = patchProposal([1], [256]);
  const executorInvalid = new ProposalExecutor({ store: invalidStore, capabilityExecutor: {}, app: fakeApp([1, 2, 3, 4]) });
  await assert.rejects(executorInvalid.verifyPostcondition(invalidProposal, { after: [256] }), (error) => error instanceof AIError && error.type === 'invalid_tool_call');

  const { store: validStore, proposal: validProposal } = patchProposal([1], [2]);
  const executorValid = new ProposalExecutor({ store: validStore, capabilityExecutor: {}, app: fakeApp([1, 2, 3, 4]) });
  await assert.rejects(executorValid.verifyPostcondition(validProposal, { after: [1.5] }), (error) => error instanceof AIError && error.type === 'invalid_tool_call');
  await assert.rejects(executorValid.verifyPostcondition(validProposal, { after: [-1] }), (error) => error instanceof AIError && error.type === 'invalid_tool_call');
});

test('issue #6171 - full apply path rejects string bytes before patch.create executes', async () => {
  const app = fakeApp([1, 2, 3, 4]);
  const catalog = createCapabilityCatalog();
  let patchCreateCalled = 0;
  const capabilityExecutor = createCapabilityExecutor({ catalog, app, binaryId: 'bin-A' });
  const originalExecute = capabilityExecutor.execute.bind(capabilityExecutor);
  capabilityExecutor.execute = async (id, ...rest) => {
    if (id === 'patch.create') patchCreateCalled++;
    return originalExecute(id, ...rest);
  };
  const store = new ProposalStore({ evidenceStore });
  const proposal = store.create({ kind: 'patch', target: { address: '4096' }, before: ['1', '2', '3', '4'], after: [4, 3, 2, 1], evidenceIds: ['e1'] });
  const executor = new ProposalExecutor({ store, capabilityExecutor, app });
  await assert.rejects(executor.approveAndApply(proposal.id), (error) => (
    error instanceof AIError && error.type === 'invalid_tool_call' && /non-byte/.test(error.message)
  ));
  assert.equal(patchCreateCalled, 0, 'strict CapabilityExecutor byte validation must not be pre-empted by coercion');
});

test('issue #6171 - CapabilityExecutor direct patch.create matches proposal-path byte contract', async () => {
  const app = fakeApp([1, 2, 3, 4]);
  const catalog = createCapabilityCatalog();
  const capabilityExecutor = createCapabilityExecutor({ catalog, app, binaryId: 'bin-A' });
  await assert.rejects(
    capabilityExecutor.execute('patch.create', { address: '4096', before: ['1'], after: [2] }, { authorization }),
    (error) => error instanceof AIError && error.type === 'invalid_tool_call',
  );
  await assert.rejects(
    capabilityExecutor.execute('patch.create', { address: '4096', before: [true], after: [2] }, { authorization }),
    (error) => error instanceof AIError && error.type === 'invalid_tool_call',
  );
  // The canonical contract accepts the same values through both paths.
  const patch = await capabilityExecutor.execute('patch.create', { address: '4096', before: [1, 2, 3, 4], after: [4, 3, 2, 1] }, { authorization });
  assert.deepEqual(patch.after, [4, 3, 2, 1]);
});
