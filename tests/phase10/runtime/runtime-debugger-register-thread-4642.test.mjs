import assert from 'node:assert/strict';

import { DebuggerProvider } from '../../../js/runtime/debugger-provider.js';

const writes = [];
const adapter = {
  id: 'remote-4642',
  kind: 'remote',
  connected: false,
  capabilities: {
    writeRegister: true,
    modules: false,
  },
  async writeRegister(register, value, threadId) {
    writes.push({ register, value, threadId });
    return { ok: true, threadId };
  },
};

const provider = new DebuggerProvider(adapter);
const session = await provider.openSession({
  binaryId: 'binary-4642',
  processKey: 'process-4642',
  sessionNonce: 'nonce-4642',
}, {
  connect: false,
});

const first = await session.facets.debugger.writeRegister('x0', 1n, {
  threadId: 'thread-1',
});
assert.equal(writes[0].threadId, 'thread-1');
assert.equal(first.intervention.parentInterventionIds.length, 0);

const second = await session.facets.debugger.writeRegister('x1', 2n, {
  threadId: 'thread-7',
  parentInterventionIds: [first.intervention.interventionId],
});
assert.equal(writes[1].threadId, 'thread-7');
assert.equal(typeof writes[1].threadId, 'string');
assert.deepEqual(
  second.intervention.parentInterventionIds,
  [first.intervention.interventionId],
);

await session.facets.debugger.writeRegister('x2', 3n, {});
assert.equal(writes[2].threadId, undefined);

await session.facets.debugger.writeRegister('x3', 4n, 'legacy-thread');
assert.equal(
  writes[3].threadId,
  'legacy-thread',
  'legacy scalar threadId remains supported by the compatibility facet',
);

await session.close();

console.log('runtime debugger register thread routing #4642: PASS');
