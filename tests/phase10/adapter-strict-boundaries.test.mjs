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
remote.protocol.close();
console.log('adapter strict boundaries: ok');
