import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter, RemoteDebugAdapter } from '../../js/adapters/index.js';

function expectCode(error, code) {
  assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
  return true;
}

const local = new LocalFunctionSandboxAdapter({});
local.sandbox = { emulator: { dump: async (_address, size) => new Uint8Array(size) } };
local.memoryMap = { assert() {} };
for (const bad of ['8', ['8'], true, { valueOf: () => 8 }]) {
  await assert.rejects(local.readMemory(0n, bad), (error) => expectCode(error, 'invalid-size'));
}
assert.equal((await local.readMemory(0n, 8)).length, 8);
assert.equal((await local.readMemory(0n, null)).length, 8);

local.breakpoints.set('1', { id:'1', kind:'address', address:0n, enabled:false });
await assert.rejects(local.removeBreakpoint(1), (error) => expectCode(error, 'invalid-breakpoint'));
assert.equal(local.breakpoints.has('1'), true);
local.breakpoints.set('bp:a', { id:'bp:a', kind:'address', address:4n, enabled:false });
await assert.rejects(local.removeBreakpoint({ id:['bp:a'] }), (error) => expectCode(error, 'invalid-breakpoint'));
assert.equal(local.breakpoints.has('bp:a'), true);

local.sandbox.setRegister = () => { throw new Error('must not mutate'); };
local.sandbox.getRegister = () => 0n;
await assert.rejects(local.writeRegister(['x0'], 1n), (error) => expectCode(error, 'invalid-register'));

const sent = [];
const remote = new RemoteDebugAdapter({ send: async (packet) => { sent.push(packet); } }, {
  capabilities: { removeBreakpoint:true, writeRegister:true, readMemory:true },
  protocol: { timeoutMs:10000 },
});
for (const bad of ['16', [16], true, { valueOf: () => 16 }]) {
  await assert.rejects(remote.readMemory(0n, bad), (error) => expectCode(error, 'invalid-size'));
}
assert.throws(() => remote.removeBreakpoint({ id:['bp:a'] }), (error) => expectCode(error, 'invalid-breakpoint'));
assert.throws(() => remote.removeBreakpoint(1), (error) => expectCode(error, 'invalid-breakpoint'));
assert.throws(() => remote.writeRegister(['x0'], 1n), (error) => expectCode(error, 'invalid-register'));
assert.equal(sent.length, 0, 'malformed selectors/sizes must not reach remote transport');

// #5807: no remote request may bypass the connect handshake. Before connect(),
// this.capabilities is only the caller's local allow-list — the remote
// advertisement is unverified, so every method fails closed without sending.
{
  const handshake = new RemoteDebugAdapter({ send: (packet) => { sent.push(packet); }, setHandler: () => {} }, {
    capabilities: {
      attach: true,
      launch: true,
      readMemory: true,
      writeMemory: true,
      readRegisters: true,
      breakpointAddress: true,
      objcRuntime: true,
      swiftRuntime: true,
    },
    protocol: { timeoutMs: 10000 },
  });
  await assert.rejects(async () => handshake.attach({ target: 'pid:1' }), (error) => expectCode(error, 'not-connected'));
  await assert.rejects(async () => handshake.launch({ executable: '/tmp/a.out' }), (error) => expectCode(error, 'not-connected'));
  await assert.rejects(async () => handshake.readMemory(0n, 8), (error) => expectCode(error, 'not-connected'));
  await assert.rejects(async () => handshake.writeMemory(0n, new Uint8Array([1, 2])), (error) => expectCode(error, 'not-connected'));
  await assert.rejects(async () => handshake.readRegisters(), (error) => expectCode(error, 'not-connected'));
  assert.throws(() => handshake.setBreakpoint({ kind: 'address', address: 0n }), (error) => expectCode(error, 'not-connected'));
  assert.throws(() => handshake.getObjCRuntimeInfo(), (error) => expectCode(error, 'not-connected'));
  assert.throws(() => handshake.getSwiftRuntimeInfo(), (error) => expectCode(error, 'not-connected'));
  assert.equal(sent.length, 0, 'no remote method request may leave before the connect handshake completed');
  handshake.protocol.close();
}

// The guard must not change post-handshake capability negotiation or lifecycle.
// Advertised operations remain usable; locally allowed but peer-denied methods
// fail before the wire; disconnect invalidates the session and reconnect works.
{
  let receive = () => {};
  const lifecycleSent = [];
  const transport = {
    send(packet) {
      lifecycleSent.push(packet);
      if (packet.type !== 'request') return;
      let result;
      if (packet.method === 'connect') {
        result = { capabilities: { attach: true, launch: false, readMemory: true } };
      } else if (packet.method === 'attach') {
        result = { attached: true };
      } else if (packet.method === 'disconnect') {
        result = { disconnected: true };
      } else {
        return;
      }
      queueMicrotask(() => receive({
        version: packet.version,
        type: 'response',
        id: packet.id,
        epoch: packet.epoch,
        result,
      }));
    },
    onMessage(handler) {
      receive = handler;
      return () => { receive = () => {}; };
    },
  };
  const lifecycle = new RemoteDebugAdapter(transport, {
    capabilities: { attach: true, launch: true, readMemory: true },
    protocol: { timeoutMs: 10000 },
  });

  await lifecycle.connect();
  assert.equal(lifecycle.connected, true);
  assert.equal(lifecycle.capabilities.attach, true);
  assert.equal(lifecycle.capabilities.launch, false);

  const beforeDenied = lifecycleSent.length;
  await assert.rejects(async () => lifecycle.launch({ executable: '/tmp/a.out' }), (error) => expectCode(error, 'unsupported'));
  assert.equal(lifecycleSent.length, beforeDenied, 'peer-denied capability must fail before the wire');

  const attached = await lifecycle.attach({ target: 'pid:1' });
  assert.equal(attached?.attached, true);

  const epochBeforeDisconnect = lifecycle.epoch;
  await lifecycle.disconnect();
  assert.equal(lifecycle.connected, false);
  assert.equal(lifecycle.epoch, epochBeforeDisconnect + 1);
  const afterDisconnect = lifecycleSent.length;
  await assert.rejects(async () => lifecycle.attach({ target: 'pid:1' }), (error) => expectCode(error, 'not-connected'));
  assert.equal(lifecycleSent.length, afterDisconnect, 'post-disconnect operation must not reach the wire');

  await lifecycle.connect();
  assert.equal(lifecycle.connected, true);
  assert.equal((await lifecycle.attach({ target: 'pid:2' }))?.attached, true);
  await lifecycle.disconnect();
  lifecycle.protocol.close();
}

remote.protocol.close();
console.log('adapter strict boundaries: ok');
