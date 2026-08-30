import test from 'node:test';
import assert from 'node:assert/strict';
import { DEBUG_PROTOCOL_VERSION } from '../../../js/debug/adapter.js';
import { RemoteProtocolClient, validateRemotePacket } from '../../../js/debug/remote-protocol.js';

function requestPacket(overrides = {}) {
  return {
    version:DEBUG_PROTOCOL_VERSION,
    type:'request',
    id:1,
    epoch:0,
    method:'readMemory',
    params:{},
    ...overrides,
  };
}

test('remote request method is a strict non-empty string boundary', async () => {
  assert.throws(() => validateRemotePacket(requestPacket({ method:{} })), (error) => error?.code === 'malformed-packet');
  assert.throws(() => validateRemotePacket(requestPacket({ method:[] })), (error) => error?.code === 'malformed-packet');
  assert.throws(() => validateRemotePacket(requestPacket({ method:'' })), (error) => error?.code === 'malformed-packet');
  assert.throws(() => validateRemotePacket(requestPacket({ method:'x'.repeat(129) })), (error) => error?.code === 'malformed-packet');
  assert.equal(validateRemotePacket(requestPacket({ method:'x'.repeat(128) })).method.length, 128);

  const sent = [];
  const client = new RemoteProtocolClient({ send:async (packet) => sent.push(packet) });
  await assert.rejects(client.request({}, {}), (error) => error?.code === 'malformed-packet');
  await assert.rejects(client.request('exec', {}), (error) => error?.code === 'blocked-method');
  assert.equal(sent.length, 0, 'invalid methods must fail before transport.send');
  client.close();
});

test('remote client epoch rejects coercible non-number generations', async () => {
  const sent = [];
  const client = new RemoteProtocolClient({ send:async (packet) => sent.push(packet) });

  for (const value of [[], [1], '', '1', false, true, {}]) {
    assert.throws(() => client.setEpoch(value), (error) => error?.code === 'invalid-epoch');
    await assert.rejects(client.request('readMemory', {}, { epoch:value }), (error) => error?.code === 'invalid-epoch');
  }
  assert.equal(sent.length, 0, 'invalid epochs must fail before transport.send');

  assert.equal(client.setEpoch(2), 2);
  const pending = client.request('readMemory', {}, { epoch:2 });
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'readMemory');
  assert.equal(sent[0].epoch, 2);
  assert.equal(client.receive({
    version:DEBUG_PROTOCOL_VERSION,
    type:'response',
    id:sent[0].id,
    epoch:2,
    result:{ ok:true },
  }), true);
  assert.deepEqual(await pending, { ok:true });
  client.close();
});
