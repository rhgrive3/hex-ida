// Issue #4606 regression: LocalFunctionSandboxAdapter.resume() must clear a
// resumable maxSteps budget stop (Emulator.run() records it as a temporary
// "いったん止めました" pause, not a terminal stop) so the next explicit
// resume() continues from the current PC instead of exiting with 0 steps.
// Only the resumable budget/pause/cancel states may be cleared; a breakpoint
// stop, a normal program return, or an instruction/memory fault must stay put.
import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../js/adapters/index.js';

const cases = [];
function it(name, fn) { cases.push([name, fn]); }
function pcHex(pc) { return '0x' + pc.toString(16); }
async function pcOf(adapter) { return (await adapter.readRegisters()).pc; }
async function nopAdapter() {
  const adapter = new LocalFunctionSandboxAdapter({ async fetch() { return { mn: 'nop', ops: '' }; } });
  await adapter.launch({ address: 0x1000n });
  return adapter;
}

it('#4606 resume({maxSteps:1}) twice advances the PC by 2 instructions total', async () => {
  const adapter = await nopAdapter();
  await adapter.resume({ maxSteps: 1 });
  assert.equal(await pcOf(adapter), 0x1004n, 'the first budget resume must execute exactly one instruction');
  await adapter.resume({ maxSteps: 1 });
  const pc = await pcOf(adapter);
  assert.equal(pc, 0x1008n, `the second budget resume must continue from PC (stuck at ${pcHex(pc)})`);
});

it('#4606 chunked resume (3 x maxSteps:2) keeps executing across every budget', async () => {
  const adapter = await nopAdapter();
  for (let i = 0; i < 3; i++) await adapter.resume({ maxSteps: 2 });
  const pc = await pcOf(adapter);
  assert.equal(pc, 0x1018n, `3 chunked resumes of 2 steps = 6 instructions (got ${pcHex(pc)})`);
});

it('#4606 a paused stop is still cleared by the next resume (existing behaviour kept)', async () => {
  const adapter = await nopAdapter();
  adapter.sandbox.emulator.stopped = 'paused';
  await adapter.resume({ maxSteps: 1 });
  assert.equal(await pcOf(adapter), 0x1004n, 'resume after pause must keep executing');
});

it('#4606 a cancelled stop is cleared only by an explicit new resume (policy kept)', async () => {
  const adapter = await nopAdapter();
  adapter.sandbox.emulator.stopped = 'cancelled';
  await adapter.resume({ maxSteps: 1 });
  assert.equal(await pcOf(adapter), 0x1004n, 'a fresh resume may proceed after a cancelled run');
});

it('#4606 a normal program return is not re-executed by a later resume', async () => {
  const adapter = new LocalFunctionSandboxAdapter({ async fetch() { return { mn: 'ret', ops: '' }; } });
  await adapter.launch({ address: 0x1000n });
  const first = await adapter.resume({ maxSteps: 5 });
  assert.equal(first.stop.kind, 'return', 'running to the caller must classify as a return stop');
  assert.equal(await pcOf(adapter), 0x0n, 'return leaves PC at the caller address');
  const second = await adapter.resume({ maxSteps: 5 });
  assert.equal(await pcOf(adapter), 0x0n, 'a resume after return must not run the program again');
  assert.equal(second.stop.kind, 'return', 'the terminal return stop must survive a resume attempt');
});

it('#4606 an unsupported-instruction fault is not auto-resumed', async () => {
  const adapter = new LocalFunctionSandboxAdapter({ async fetch() { return { mn: 'frobnicate', ops: '' }; } });
  await adapter.launch({ address: 0x1000n });
  const first = await adapter.resume({ maxSteps: 1 });
  assert.equal(first.stop.kind, 'unsupported', 'an unsupported instruction must classify as unsupported');
  const second = await adapter.resume({ maxSteps: 1 });
  assert.equal(second.stop.kind, 'unsupported', 'the fault stop must not be cleared for a resume');
  assert.equal(await pcOf(adapter), 0x1000n, 'a faulted step must not advance the PC');
});

it('#4606 an unmapped-memory fault is not auto-resumed', async () => {
  const adapter = new LocalFunctionSandboxAdapter({
    async fetch(address) { return address === 0x1000n ? { mn: 'ldr', ops: 'x0, [x1]' } : { mn: 'nop', ops: '' }; },
    async read() { return null; },
  });
  await adapter.launch({
    address: 0x1000n,
    registers: { x1: 0x5000n },
    memoryMappings: [{ start: 0x5000n, size: 0x1000, kind: 'mapped', permissions: 'r' }],
  });
  const first = await adapter.resume({ maxSteps: 1 });
  assert.equal(first.stop.kind, 'fault', `an unmapped read must classify as a fault, got ${first.stop.kind}`);
  const second = await adapter.resume({ maxSteps: 1 });
  assert.equal(second.stop.kind, 'fault', 'the memory fault must not be cleared for a resume');
  assert.equal(await pcOf(adapter), 0x1000n, 'the PC must stay parked on the faulting instruction');
});

it('#4606 a breakpoint stop is distinguished from a budget stop', async () => {
  const adapter = new LocalFunctionSandboxAdapter({ async fetch() { return { mn: 'nop', ops: '' }; } });
  await adapter.launch({ address: 0x1000n });
  await adapter.setBreakpoint({ id: 'b1', address: 0x1004n });
  const stopped = await adapter.resume({ maxSteps: 10 });
  assert.equal(await pcOf(adapter), 0x1004n, 'execution halts at the breakpoint address');
  assert.equal(stopped.stop.kind, 'paused', 'a breakpoint stop is not reported as a budget/timeout stop');
  assert.equal(adapter.sandbox.emulator.stopped, null, 'a breakpoint stop leaves no lingering budget message');
  await adapter.removeBreakpoint('b1');
  await adapter.resume({ maxSteps: 1 });
  assert.equal(await pcOf(adapter), 0x1008n, 'resume continues cleanly once the breakpoint is removed');
});

let failed = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (error) { failed++; console.log(`  FAIL ${name}: ${error.message}`); }
}
if (failed) { console.log(`issue #4606 resume-after-budget regressions: ${failed} failing`); process.exit(1); }
console.log(`issue #4606 resume-after-budget regressions: PASS (${cases.length} cases)`);
