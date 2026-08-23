import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../../js/adapters/index.js';

const io = {
  fetch: async () => ({ mn:'ret', ops:'' }),
  read: async () => null,
  isExecutable: () => true,
  symbolFor: () => null,
};

const adapter = new LocalFunctionSandboxAdapter(io);
await adapter.connect();
await adapter.launch({ address:0x1000n, objectAsArg0:false });

await adapter.setBreakpoint({ id:'shared:a', address:0x1004n });
await adapter.setBreakpoint({ id:'shared:b', address:0x1004n });
assert.equal(adapter.sandbox.emulator.breakpoints.has(String(0x1004n)), true);

await adapter.removeBreakpoint('shared:a');
assert.deepEqual((await adapter.listBreakpoints()).map((bp) => bp.id), ['shared:b']);
assert.equal(adapter.sandbox.emulator.breakpoints.has(String(0x1004n)), true, 'removing one logical owner must preserve the shared physical breakpoint');

await adapter.removeBreakpoint('shared:b');
assert.equal(adapter.sandbox.emulator.breakpoints.has(String(0x1004n)), false, 'last logical owner removal must remove the physical breakpoint');

await adapter.setBreakpoint({ id:'move:1', address:0x1004n });
await adapter.setBreakpoint({ id:'move:1', address:0x1008n });
assert.equal(adapter.sandbox.emulator.breakpoints.has(String(0x1004n)), false, 'moving a stable breakpoint id must remove the old physical address');
assert.equal(adapter.sandbox.emulator.breakpoints.has(String(0x1008n)), true);

await adapter.setBreakpoint({ id:'move:1', address:0x1008n, enabled:false });
assert.equal(adapter.sandbox.emulator.breakpoints.has(String(0x1008n)), false, 'disabling a breakpoint must remove its physical address');
assert.equal((await adapter.listBreakpoints())[0].enabled, false);

await adapter.disconnect();
