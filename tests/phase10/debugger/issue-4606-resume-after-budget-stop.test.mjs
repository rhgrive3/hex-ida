// Regression for #4606: a resume() that ends because its maxSteps budget was
// spent is a temporary pause, not a terminal execution stop. The adapter must
// clear exactly that machine-readable stop state on the next explicit
// resume(), while terminal return/fault states must never be revived.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LocalFunctionSandboxAdapter } from '../../../js/adapters/index.js';

async function launchedAdapter(fetch) {
  const adapter = new LocalFunctionSandboxAdapter({ fetch }, {});
  await adapter.launch({ address: 0x1000n });
  return adapter;
}
const nops = async () => ({ mn: 'nop', ops: '' });

test('#4606 two maxSteps-budget resumes advance the PC one instruction each', async () => {
  const adapter = await launchedAdapter(nops);
  const first = await adapter.resume({ maxSteps: 1 });
  const pcAfterFirst = (await adapter.readRegisters()).pc;
  assert.equal(first.steps, 1);
  assert.equal(first.stop.kind, 'timeout', 'the budget stop must stay classified as a timeout for consumers');
  assert.equal(pcAfterFirst, 0x1004n);

  const second = await adapter.resume({ maxSteps: 1 });
  const pcAfterSecond = (await adapter.readRegisters()).pc;
  assert.equal(second.steps - first.steps, 1, 'the second resume must execute one instruction, not zero');
  assert.equal(pcAfterSecond, 0x1008n);
});

test('#4606 chunked resumes keep advancing past the budget stop', async () => {
  const adapter = await launchedAdapter(nops);
  let previousSteps = 0;
  for (let round = 1; round <= 4; round++) {
    const result = await adapter.resume({ maxSteps: 2 });
    assert.equal(result.steps - previousSteps, 2, `round ${round} must execute its whole budget`);
    previousSteps = result.steps;
    assert.equal((await adapter.readRegisters()).pc, 0x1000n + BigInt(round * 8));
  }
});

test('#4606 the budget stop is machine-readable and cleared only at the next resume boundary', async () => {
  const adapter = await launchedAdapter(nops);
  await adapter.resume({ maxSteps: 1 });
  assert.equal(adapter.sandbox.emulator.stopCode, 'max-steps');
  assert.equal(typeof adapter.sandbox.emulator.stopped, 'string', 'the human-readable stop text stays for presentation');
  await adapter.resume({ maxSteps: 1 });
  assert.equal(adapter.sandbox.emulator.stopCode, 'max-steps');
  assert.equal((await adapter.readRegisters()).pc, 0x1008n);
});

test('#4606 pause remains resumable and the existing paused marker is still accepted', async () => {
  const adapter = await launchedAdapter(nops);
  assert.equal(adapter.sandbox.emulator.stopped, null);
  adapter.sandbox.emulator.stopped = 'paused';
  const result = await adapter.resume({ maxSteps: 1 });
  assert.equal(result.steps, 1);
  assert.equal((await adapter.readRegisters()).pc, 0x1004n);
});

test('#4606 cancel remains resumable and the existing cancelled marker is still accepted', async () => {
  const adapter = await launchedAdapter(nops);
  adapter.sandbox.emulator.stopped = 'cancelled';
  const result = await adapter.resume({ maxSteps: 1 });
  assert.equal(result.steps, 1);
  assert.equal((await adapter.readRegisters()).pc, 0x1004n);
});

test('#4606 a normal program return is terminal and is never revived by resume', async () => {
  let fetches = 0;
  const adapter = await launchedAdapter(async () => {
    fetches++;
    return fetches <= 2 ? { mn: 'nop', ops: '' } : { mn: 'ret', ops: '' };
  });
  await adapter.resume({ maxSteps: 2 });
  const stopBeforeReturn = await adapter.resume({ maxSteps: 1 });
  assert.equal(stopBeforeReturn.steps - 2, 1);
  const returned = await adapter.resume({ maxSteps: 1 });
  assert.equal(returned.stop.kind, 'return');
  assert.equal(adapter.sandbox.emulator.stopCode, 'program-return');
  const pc = (await adapter.readRegisters()).pc;
  const afterTerminal = await adapter.resume({ maxSteps: 5 });
  assert.equal(afterTerminal.steps, returned.steps, 'a terminated run must not continue executing');
  assert.equal((await adapter.readRegisters()).pc, pc);
});

test('#4606 an unmapped fetch fault is terminal and is never revived by resume', async () => {
  let fetches = 0;
  const adapter = await launchedAdapter(async () => {
    fetches++;
    return fetches <= 2 ? { mn: 'nop', ops: '' } : null;
  });
  await adapter.resume({ maxSteps: 2 });
  const faulted = await adapter.resume({ maxSteps: 1 });
  assert.equal(faulted.steps, 2, 'the failed fetch attempt must not count as an executed step');
  assert.ok(['fault', 'exception'].includes(faulted.stop.kind),
    `the fetch fault must be visible as a fault stop, got ${faulted.stop.kind}`);
  assert.equal(adapter.sandbox.emulator.stopCode, 'instruction-fetch-failed');
  const pc = (await adapter.readRegisters()).pc;
  const afterFault = await adapter.resume({ maxSteps: 5 });
  assert.equal(afterFault.steps, faulted.steps);
  assert.equal((await adapter.readRegisters()).pc, pc);
});

test('#4606 a breakpoint stop is distinguished from the budget stop and stays resumable', async () => {
  const adapter = await launchedAdapter(nops);
  const bp = await adapter.setBreakpoint({ address: 0x1008n });
  const hit = await adapter.resume({ maxSteps: 100 });
  assert.equal(hit.steps, 2);
  assert.equal(hit.stop.kind, 'paused', 'a breakpoint stop must not look like a budget timeout');
  assert.equal(adapter.sandbox.emulator.stopCode, null, 'a breakpoint must not leave a budget stop behind');
  assert.equal(adapter.sandbox.emulator.stopped, null);
  await adapter.removeBreakpoint(bp.id);
  const after = await adapter.resume({ maxSteps: 1 });
  assert.equal(after.steps - hit.steps, 1);
  assert.equal((await adapter.readRegisters()).pc, 0x100cn);
});
