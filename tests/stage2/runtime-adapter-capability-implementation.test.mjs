import assert from 'node:assert/strict';
import {
  LocalFunctionSandboxAdapter,
  SymbolicAdapter,
  ReplayAdapter,
  LLDBCompatibleAdapter,
  FridaCompatibleAdapter,
} from '../../js/adapters/index.js';
import { DebugAdapter } from '../../js/debug/adapter.js';

const io = {
  fetch: async () => ({ mn:'b', ops:'#0x1000' }),
  read: async () => null,
  isExecutable: () => true,
  symbolFor: () => null,
};
const transport = { send:async () => {}, onMessage:() => () => {} };

const local = new LocalFunctionSandboxAdapter(io);
assert.equal(local.capabilities.cancel, true);
assert.notEqual(local.cancel, DebugAdapter.prototype.cancel, 'advertised local cancel must have an implementation');
assert.equal(local.capabilities.replay, false, 'local replay must not be advertised without an implementation');

const symbolic = new SymbolicAdapter();
const replay = new ReplayAdapter();
assert.equal(symbolic.capabilities.replay, false);
assert.equal(replay.capabilities.replay, false);

const lldb = new LLDBCompatibleAdapter(transport, { capabilities:{ cancel:true } });
const frida = new FridaCompatibleAdapter(transport, { capabilities:{ cancel:true } });
assert.equal(lldb.capabilities.cancel, false, 'remote request cancellation is not a generic adapter cancel implementation');
assert.equal(frida.capabilities.cancel, false, 'remote request cancellation is not a generic adapter cancel implementation');

await local.connect();
await local.launch({ address:0x1000n, objectAsArg0:false });
const running = local.resume({ maxSteps:1_000_000 });
const cancelled = await local.cancel();
const result = await running;
assert.equal(cancelled.cancelled, true);
assert.equal(result.stop.kind, 'cancelled');
await local.disconnect();
