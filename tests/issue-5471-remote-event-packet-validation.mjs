// Regression for #5471: validateRemotePacket() enforced the request method
// grammar but never validated an event packet's `event` identifier — packets
// with a missing, structured, or oversized event name passed wire validation
// and were dispatched to listeners as ordinary events.
// Contract now: `type:'event'` requires a 1..128 character string event name,
// exactly like a request method.
import assert from 'node:assert/strict';
import { RemoteProtocolClient, validateRemotePacket } from '../js/debug/remote-protocol.js';
import { DEBUG_PROTOCOL_VERSION } from '../js/debug/adapter.js';

function makeTransport() {
  return { async send() {}, onMessage() { return () => {}; } };
}

function eventPacket(event) {
  return { version: DEBUG_PROTOCOL_VERSION, type: 'event', epoch: 0, event, data: {} };
}

function expectMalformed(packet, label) {
  assert.throws(() => validateRemotePacket(packet), (error) => {
    assert.equal(error.code, 'malformed-packet', `${label}: expected malformed-packet, got ${error.code}`);
    return true;
  }, label);
}

// 1. Wire validation rejects malformed event identifiers.
expectMalformed(eventPacket(undefined), 'missing event name');
expectMalformed(eventPacket({}), 'structured event object');
expectMalformed(eventPacket(['stopped']), 'array event name');
expectMalformed(eventPacket(7), 'numeric event name');
expectMalformed(eventPacket(''), 'empty event name');
expectMalformed(eventPacket('x'.repeat(129)), 'oversized event name');

// 2. Canonical event names keep flowing through validation.
{
  const packet = validateRemotePacket(eventPacket('stopped'));
  assert.equal(packet.event, 'stopped');
  const boundary = validateRemotePacket(eventPacket('x'.repeat(128)));
  assert.equal(boundary.event.length, 128, 'the 128-character boundary is still accepted');
}

// 3. The client surface refuses to dispatch malformed events to listeners:
//    receive() swallows the wire rejection and returns false.
{
  const client = new RemoteProtocolClient(makeTransport());
  const received = [];
  client.onEvent((packet) => received.push(packet));
  assert.equal(client.receive(eventPacket({})), false, 'a structured event identifier must not be accepted');
  assert.equal(client.receive({ version: DEBUG_PROTOCOL_VERSION, type: 'event', epoch: 0, data: {} }), false,
    'an omitted event name must not be accepted');
  assert.equal(client.receive(eventPacket('x'.repeat(129))), false, 'an oversized event name must not be accepted');
  assert.equal(received.length, 0, 'no malformed event reached a listener');
}

// 4. Well-formed events still dispatch.
{
  const client = new RemoteProtocolClient(makeTransport());
  const received = [];
  client.onEvent((packet) => received.push(packet));
  client.receive(eventPacket('module-load'));
  assert.equal(received.length, 1);
  assert.equal(received[0].event, 'module-load');
}

console.log('issue-5471 remote event packet identifier validation: ok');
