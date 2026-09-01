import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../../js/adapters/index.js';
import { RemoteProtocolClient } from '../../js/debug/remote-protocol.js';

// #2962: model the exact lost-abort window. The first read used to initialize
// run.cancelled observes false; the signal becomes aborted before subscription.
// Correct code must still subscribe from that initial snapshot and catch the
// post-registration recheck.
const local = new LocalFunctionSandboxAdapter({});
let localListenerRegistered = false;
let localAbortedReads = 0;
const localSignal = {
  get aborted() {
    localAbortedReads++;
    return localAbortedReads === 1 ? false : true;
  },
  get reason() { return 'cancelled-before-subscription'; },
  addEventListener(type) {
    assert.equal(type, 'abort');
    localListenerRegistered = true;
  },
  removeEventListener() {},
};
local.sandbox = {
  emulator: { stopped:null },
  run: async () => {
    assert.equal(local.sandbox.emulator.stopped, 'cancelled', 'local abort in the initial-read→subscribe window must not be lost');
    throw new Error('local-race-observed');
  },
};
await assert.rejects(local.resume({ signal:localSignal }), /local-race-observed/);
assert.equal(localListenerRegistered, true, 'local adapter must subscribe when the initial cancellation snapshot was false');
assert.equal(local.cancelled, true, 'local adapter must retain cancelled state after the raced abort');

// #2963: abort during remote listener registration must see the pending entry,
// cancel it, and prevent the request packet from being sent.
const sent = [];
const transport = { send: async (packet) => { sent.push(packet); } };
const client = new RemoteProtocolClient(transport, { timeoutMs:1000 });
let aborted = false;
const signal = {
  get aborted() { return aborted; },
  get reason() { return 'cancelled-in-registration-window'; },
  addEventListener(type, listener) {
    assert.equal(type, 'abort');
    aborted = true;
    listener();
  },
  removeEventListener() {},
};
await assert.rejects(client.request('readMemory', {}, { signal }), /cancelled/);
await Promise.resolve();
assert.equal(sent.some((packet) => packet?.type === 'request'), false, 'cancelled request must not be sent');
assert.equal(client.pending.size, 0, 'cancelled request must not remain pending');

console.log('cancellation races 2962/2963: PASS');
