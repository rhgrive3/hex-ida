/**
 * #6257 regression: agent-exposed built-in capabilities must publish an
 * input schema that matches the executor's real argument contract, so that
 * missing required fields are rejected as invalid_tool_call by assertSchema
 * instead of surfacing as native TypeError from BigInt(undefined) deeper in
 * the executor.
 */
import assert from 'node:assert/strict';
import { HEX_CAPABILITIES } from '../js/ai/capabilities/catalog.js';
import { validateSchema } from '../js/ai/validation.js';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';

const byId = new Map(HEX_CAPABILITIES.map((entry) => [entry.id, entry]));

/* required-field contracts per built-in capability, matching executeBuiltIn */
const REQUIRED_FIELDS = Object.freeze({
  'annotation.rename': ['address', 'value'],
  'annotation.comment': ['address', 'value'],
  'annotation.set-type': ['address', 'value'],
  'annotation.struct-field': ['offset'],
  'patch.create': ['address', 'before', 'after'],
  'patch.preview': ['address', 'before', 'after'],
  'patch.revert': ['fileOffset'],
  'runtime.attach': ['runtimeSessionId'],
  'runtime.detach': ['runtimeSessionId'],
  'runtime.breakpoint-remove': ['runtimeSessionId', 'id'],
  'runtime.watchpoint-remove': ['runtimeSessionId', 'id'],
  'runtime.continue': ['runtimeSessionId'],
  'runtime.pause': ['runtimeSessionId'],
  'runtime.step-in': ['runtimeSessionId'],
  'runtime.step-over': ['runtimeSessionId'],
  'runtime.step-out': ['runtimeSessionId'],
  'runtime.registers': ['runtimeSessionId'],
  'runtime.memory-read': ['runtimeSessionId', 'address'],
  'runtime.memory-write': ['runtimeSessionId', 'address', 'bytes', 'expectedBefore'],
  'runtime.experiment': ['runtimeSessionId', 'experiment'],
  'project.restore-known': ['project'],
});

/* 1. every agent-exposed built-in has a real input schema object */
for (const entry of HEX_CAPABILITIES) {
  if (!entry.agentExposed || entry.agentTool || entry.actionKind) continue;
  assert.ok(entry.inputSchema && typeof entry.inputSchema === 'object', `${entry.id} must publish an input schema`);
}

/* 2. missing required args are rejected by the schema, not by native TypeError */
for (const [id, fields] of Object.entries(REQUIRED_FIELDS)) {
  const entry = byId.get(id);
  assert.ok(entry, `catalog entry ${id} must exist`);
  for (const field of fields) {
    const args = {};
    const checked = validateSchema(args, entry.inputSchema);
    assert.equal(checked.ok, false, `${id}: {} must be invalid when ${field} is required`);
    assert.ok(
      checked.errors.some((message) => message.includes(field) && message.includes('required')),
      `${id}: empty args must report ${field} is required, got ${JSON.stringify(checked.errors)}`,
    );
  }
}

/* 3. every runtime-bound schema rejects a missing runtime session identity */
for (const entry of HEX_CAPABILITIES.filter((item) => item.runtimeBound)) {
  const checked = validateSchema({}, entry.inputSchema);
  assert.equal(checked.ok, false, `${entry.id}: runtime-bound capability must reject missing runtimeSessionId`);
  if (!entry.inputSchema.anyOf) {
    assert.ok(
      checked.errors.some((message) => message.includes('runtimeSessionId') && message.includes('required')),
      `${entry.id}: missing session must be reported by schema, got ${JSON.stringify(checked.errors)}`,
    );
  }
}

/* 4. breakpoint/watchpoint schemas preserve the executor's nested and flat forms */
{
  const session = { runtimeSessionId: 'session-6257', binaryId: 'binary-A' };
  const breakpoint = byId.get('runtime.breakpoint-create').inputSchema;
  assert.equal(validateSchema({ ...session, breakpoint: { address: '4096' } }, breakpoint).ok, true);
  assert.equal(validateSchema({ ...session, address: '4096', enabled: true }, breakpoint).ok, true);
  assert.equal(validateSchema({ ...session, function: 'main' }, breakpoint).ok, true);
  assert.equal(validateSchema({ ...session, kind: 'conditional', address: '4096', condition: 'x == 1' }, breakpoint).ok, true);
  assert.equal(validateSchema({ ...session }, breakpoint).ok, false, 'breakpoint create needs an operation target');

  const watchpoint = byId.get('runtime.watchpoint-create').inputSchema;
  assert.equal(validateSchema({ ...session, watchpoint: { address: '8192', size: 4, access: 'write' } }, watchpoint).ok, true);
  assert.equal(validateSchema({ ...session, address: '8192', size: 4, access: 'readwrite', enabled: true }, watchpoint).ok, true);
  assert.equal(validateSchema({ ...session }, watchpoint).ok, false, 'watchpoint create needs an address');

  assert.equal(validateSchema({ ...session, id: 'bp:1' }, byId.get('runtime.breakpoint-remove').inputSchema).ok, true);
  assert.equal(validateSchema({ ...session }, byId.get('runtime.breakpoint-remove').inputSchema).ok, false);
  assert.equal(validateSchema({ ...session, id: 'wp:1' }, byId.get('runtime.watchpoint-remove').inputSchema).ok, true);
}

/* 5. runtime experiment schema reflects runExperiment's object/cases precondition */
{
  const entry = byId.get('runtime.experiment');
  assert.equal(validateSchema({ runtimeSessionId: 'session-6257', experiment: { cases: [] } }, entry.inputSchema).ok, true);
  assert.equal(validateSchema({ runtimeSessionId: 'session-6257', experiment: 'cases' }, entry.inputSchema).ok, false);
  assert.equal(validateSchema({ runtimeSessionId: 'session-6257', experiment: {} }, entry.inputSchema).ok, false);
}

/* 6. schema rejects the wrong primitive for known fields (no silent coercion) */
{
  const checked = validateSchema({ address: true, value: 'x' }, byId.get('annotation.rename').inputSchema);
  assert.equal(checked.ok, false, 'boolean must not pass as an address');
  const checked2 = validateSchema({ address: '4096', value: 42 }, byId.get('annotation.rename').inputSchema);
  assert.equal(checked2.ok, false, 'number must not pass as a string value');
}

/* 7. valid inputs still reach the executor end-to-end */
{
  const names = new Map();
  const app = {
    notes: { setName: (address, value) => names.set(String(address), value), nameOf: (address) => names.get(String(address)) || null },
    symbols: { rename: (address, value) => names.set(String(address), `sym:${value}`) },
    viewer: { setSymbols() {} }, updateChrome() {},
  };
  // #6221: mutations require a live approval from the trusted store.
  const { ProposalStore } = await import('../js/ai/proposals.js');
  const approvalStore = new ProposalStore({ evidenceStore: { has: () => true } });
  const approvalProposal = approvalStore.create({
    kind: 'rename', target: { address: '4096' }, before: null, after: 'renamed', evidenceIds: ['e1'],
  });
  const { approvalToken } = approvalStore.approve(approvalProposal.id);
  const executor = new CapabilityExecutor({ catalog: { get: (id) => byId.get(id) || null }, app, proposalStore: approvalStore });
  const result = await executor.execute('annotation.rename', { address: '4096', value: 'renamed' }, { authorization: { kind: 'proposal', token: approvalToken, proposalId: approvalProposal.id } });
  assert.equal(result.ok, true);
  assert.equal(names.get('4096'), 'sym:renamed');
}

/* 8. executor turns missing args into invalid_tool_call, never native TypeError */
{
  const app = { notes: { setName() {} }, symbols: { rename() {} }, viewer: { setSymbols() {} }, updateChrome() {} };
  // Missing args fail at schema validation before the approval gate, so any
  // shape-valid authorization reaches the same invalid_tool_call path.
  const executor = new CapabilityExecutor({ catalog: { get: (id) => byId.get(id) || null }, app });
  await assert.rejects(
    () => executor.execute('annotation.rename', {}, { authorization: { kind: 'proposal', token: '0123456789abcdef' } }),
    (error) => error.type === 'invalid_tool_call' && /address/.test(error.message),
    'missing address must be an invalid_tool_call domain error',
  );
}

console.log('issue-6257-catalog-input-schemas: ok');
