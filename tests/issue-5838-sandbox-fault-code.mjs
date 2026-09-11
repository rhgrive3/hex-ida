// Issue #5838 regression: the structured EmulatorFault.code must survive the
// Emulator.run() -> FunctionSandbox.run() aggregation path so the local
// FunctionSandbox stop taxonomy is decided by the machine-readable fault code,
// not by regex-matching the human-readable `stopped` message. Memory backend
// faults (`memory-read-failed`, message without oob/unmapped/permission/fault)
// used to be exposed as generic `exception` stops.
import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../js/adapters/index.js';

// `ldr x0, [x1]` with x1=0x5000 in a read-only mapping whose backend read throws.
function makeAdapter(readError) {
  const io = {
    async fetch(address) { if (address === 0x1000n) return { mn:'ldr', ops:'x0, [x1]' }; return null; },
    async read() { throw readError; },
  };
  const adapter = new LocalFunctionSandboxAdapter(io);
  return adapter.launch({
    address: 0x1000n,
    registers: { x1: 0x5000n },
    memoryMappings: [{ start: 0x5000n, size: 0x1000, kind: 'mapped', permissions: 'r' }],
  }).then(() => adapter);
}

// Backend failure with a message matching none of the fault regexes: the stop
// must be a fault carrying the structured EmulatorFault.code.
{
  const adapter = await makeAdapter(new Error('backend offline'));
  const result = await adapter.resume({ maxSteps: 1 });
  assert.equal(result.stop.kind, 'fault', `memory backend failure must classify as fault, got ${result.stop.kind}`);
  assert.equal(result.stop.code, 'memory-read-failed', 'structured fault code must survive to the result');
  assert.equal(result.fault, 'backing read failed at 0x5000');
  assert.equal(result.exception, null, 'memory fault must not be exposed as a generic exception');
}

// `unmapped-memory` from a nullish backend response keeps the code too.
{
  const io = {
    async fetch(address) { if (address === 0x1000n) return { mn:'ldr', ops:'x0, [x1]' }; return null; },
    async read() { return null; },
  };
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.launch({
    address: 0x1000n,
    registers: { x1: 0x5000n },
    memoryMappings: [{ start: 0x5000n, size: 0x1000, kind: 'mapped', permissions: 'r' }],
  });
  const result = await adapter.resume({ maxSteps: 1 });
  assert.equal(result.stop.kind, 'fault');
  assert.equal(result.stop.code, 'unmapped-memory');
}

// stepInto publishes the same structured taxonomy from the step-result code.
{
  const io = {
    async fetch(address) { if (address === 0x1000n) return { mn:'ldr', ops:'x0, [x1]' }; return null; },
    async read() { throw new Error('backend offline'); },
  };
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.launch({
    address: 0x1000n,
    registers: { x1: 0x5000n },
    memoryMappings: [{ start: 0x5000n, size: 0x1000, kind: 'mapped', permissions: 'r' }],
  });
  const result = await adapter.stepInto();
  assert.equal(result.stop.kind, 'fault', `stepInto must classify the memory fault, got ${result.stop.kind}`);
  assert.equal(result.stop.code, 'memory-read-failed');
  const repeated = await adapter.stepInto();
  assert.equal(repeated.stop.kind, 'fault', 'a repeated step after a fault retains the structured taxonomy');
  assert.equal(repeated.stop.code, 'memory-read-failed');
}

console.log('issue #5838 sandbox fault code preservation regressions: PASS');
