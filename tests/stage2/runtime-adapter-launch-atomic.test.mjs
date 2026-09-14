import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../../js/adapters/index.js';

const io = {
  fetch: async () => ({ mn:'ret', ops:'' }),
  read: async () => null,
  isExecutable: () => true,
  symbolFor: () => null,
};

const failingSpec = {
  address:0x1000n,
  objectAsArg0:false,
  objectMemory:[{ offset:0, size:1024 * 1024, value:0n }],
};

const fresh = new LocalFunctionSandboxAdapter(io);
await fresh.connect();
await assert.rejects(fresh.launch(failingSpec));
await assert.rejects(
  fresh.readRegisters(),
  (error) => error?.code === 'not-launched',
  'a failed first launch must not publish a partial sandbox',
);
assert.equal(fresh.memoryMap, null);
assert.equal(fresh.epoch, 0);
await fresh.disconnect();

const relaunched = new LocalFunctionSandboxAdapter(io);
await relaunched.connect();
await relaunched.launch({ address:0x1000n, objectAsArg0:false });
const previousSandbox = relaunched.sandbox;
const previousMemoryMap = relaunched.memoryMap;
const previousEpoch = relaunched.epoch;

await assert.rejects(relaunched.launch(failingSpec));
assert.equal(relaunched.sandbox, previousSandbox, 'failed relaunch must preserve the last committed sandbox');
assert.equal(relaunched.memoryMap, previousMemoryMap, 'failed relaunch must preserve the last committed memory map');
assert.equal(relaunched.epoch, previousEpoch, 'failed relaunch must not publish a new epoch');
await relaunched.readRegisters();
await relaunched.disconnect();
