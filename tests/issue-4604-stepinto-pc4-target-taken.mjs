import test from 'node:test';
import assert from 'node:assert/strict';

import { LocalFunctionSandboxAdapter } from '../js/adapters/index.js';

// Issue #4604: AArch64 conditional branches may legally target PC+4, so the
// executed next PC equals the fallthrough even when the condition held. The
// adapter must use the emulator's authoritative condition evaluation instead
// of inferring `taken` from `after.pc !== before.pc + 4n`.

function branchIo(instructions) {
  return {
    fetch: async (pc) => instructions[pc.toString()] || null,
    read: async () => null,
    isExecutable: () => true,
  };
}

const PROGRAM = {
  '4092': { mn: 'cmp', ops: 'x0, #1' },
  '4096': { mn: 'b.eq', ops: '#0x1004' },
  '4100': { mn: 'ret', ops: '' },
};

async function stepToBranch(x0) {
  const adapter = new LocalFunctionSandboxAdapter(branchIo(PROGRAM));
  await adapter.launch({ address: 0xffcn, registers: { x0 }, objectAsArg0: false, memoryMappings: [] });
  await adapter.stepInto();
  const step = await adapter.stepInto();
  assert.equal(step.ok, true);
  const snapshot = await adapter.trace();
  const branch = snapshot.events.find((event) => event?.type === 'branch');
  assert.ok(branch, 'stepInto must emit a branch trace event for b.eq');
  return branch;
}

test('#4604 stepInto records taken:true for a satisfied conditional branch targeting PC+4', async () => {
  const branch = await stepToBranch(1n);
  assert.equal(branch.address, 0x1000n);
  assert.equal(branch.next, 0x1004n);
  assert.equal(branch.taken, true, 'b.eq to PC+4 with a satisfied condition is taken');
  assert.equal(branch.ambiguous, undefined);
});

test('#4604 stepInto records taken:false for an unsatisfied conditional branch targeting PC+4', async () => {
  const branch = await stepToBranch(0n);
  assert.equal(branch.address, 0x1000n);
  assert.equal(branch.next, 0x1004n);
  assert.equal(branch.taken, false);
  assert.equal(branch.ambiguous, undefined);
});
