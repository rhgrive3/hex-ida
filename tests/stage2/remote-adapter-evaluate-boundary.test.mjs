import assert from 'node:assert/strict';
import { RemoteDebugAdapter } from '../../js/adapters/index.js';

const transport = {
  send: async () => {},
  onMessage: () => () => {},
};

const adapter = new RemoteDebugAdapter(transport, { capabilities:{ evaluate:true } });
let captured = null;
adapter.call = async (method, params) => {
  captured = { method, params };
  return { ok:true };
};

const exact = 'x'.repeat(4096);
const context = { threadId:'thread:0' };
await adapter.evaluate(exact, context);
assert.equal(captured.method, 'evaluate');
assert.equal(captured.params.expression, exact, 'supported expressions must be transmitted byte-for-character unchanged');
assert.equal(captured.params.context, context);

captured = null;
await assert.rejects(
  () => adapter.evaluate('x'.repeat(4097), context),
  (error) => error?.code === 'too-large',
  'oversized evaluate requests must be rejected rather than truncated',
);
assert.equal(captured, null, 'rejected expressions must not be sent to the remote provider');
