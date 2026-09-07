// Regression for #5804: RemoteDebugAdapter multiplexes traceCall/traceReturn/
// traceBranch/traceMemoryWrite/traceMemoryRead onto the generic `trace` wire
// method, but the send path re-authorized every multiplexed request against
// `traceFunction`. A peer legitimately advertising `traceCall:true` with
// `traceFunction:false` could never execute traceCall() — the wire request was
// rejected locally as `unsupported`. Multiplexed requests now authorize with
// their own capability; generic trace() keeps requiring traceFunction.
import assert from 'node:assert/strict';
import test from 'node:test';

import { RemoteDebugAdapter } from '../../js/adapters/index.js';

function adapterWith(capabilities) {
  const sent = [];
  const remote = new RemoteDebugAdapter({ send: async () => {} }, {
    capabilities,
    protocol: { timeoutMs: 10000 },
  });
  remote.protocol = {
    async request(method, params) { sent.push({ method, params }); return { events: [{ type: 'call', address: '0x1004' }] }; },
    close() {},
  };
  return { remote, sent };
}

test('#5804 traceCall is executable when traceCall is advertised without traceFunction', async () => {
  const { remote, sent } = adapterWith({ attach: true, traceCall: true, traceFunction: false });
  const result = await remote.traceCall({ limit: 10 });
  const request = sent.find((entry) => entry.method === 'trace');
  assert.ok(request, 'the wire request must be sent');
  assert.equal(request.params.capability, 'traceCall', 'the request carries the multiplexed capability');
  assert.deepEqual(result.events.map((event) => event.type), ['call']);
});

test('#5804 the generic trace() still requires traceFunction', async () => {
  const { remote, sent } = adapterWith({ attach: true, traceCall: true, traceFunction: false });
  await assert.rejects(() => remote.trace({ limit: 10 }), (error) => error.code === 'unsupported');
  assert.equal(sent.length, 0, 'an unauthorized generic trace must not reach the wire');
});

test('#5804 unadvertised specific trace capabilities stay gated', async () => {
  const { remote, sent } = adapterWith({ attach: true, traceCall: true, traceFunction: false });
  await assert.rejects(() => remote.traceBranch({ limit: 5 }), (error) => error.code === 'unsupported');
  assert.equal(sent.length, 0, 'an unadvertised capability must not reach the wire');
});
