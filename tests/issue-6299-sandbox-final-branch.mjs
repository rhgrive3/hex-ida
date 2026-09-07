import test from 'node:test';
import assert from 'node:assert/strict';

import { createFunctionSandbox } from '../js/symbolic/function-sandbox.js';

const io = {
  fetch: async (pc) => {
    if (pc === 0x1000n) return { mn: 'cbz', ops: 'x0, #0x2000' };
    if (pc === 0x1004n) return { mn: 'ret', ops: '' };
    if (pc === 0x2000n) return { mn: 'ret', ops: '' };
    return null;
  },
  isExecutable: () => true,
};

test('#6299 taken cbz into a target breakpoint keeps the final branch in takenBranches', async () => {
  const sandbox = createFunctionSandbox(io, {});
  await sandbox.setup(0x1000n, { args: [0n], objectAsArg0: false, breakpoints: [0x2000n] });
  const result = await sandbox.run({ maxSteps: 10 });
  assert.equal(result.hitBreakpoint, true);
  assert.equal(sandbox.emulator.pc, 0x2000n);
  assert.deepEqual(
    result.takenBranches.map((b) => ({ address: b.address, next: b.next, taken: b.taken })),
    [{ address: 0x1000n, next: 0x2000n, taken: true }],
  );
});

test('#6299 not-taken cbz into a fallthrough breakpoint keeps taken:false evidence', async () => {
  const sandbox = createFunctionSandbox(io, {});
  await sandbox.setup(0x1000n, { args: [5n], objectAsArg0: false, breakpoints: [0x1004n] });
  const result = await sandbox.run({ maxSteps: 10 });
  assert.equal(result.hitBreakpoint, true);
  assert.equal(sandbox.emulator.pc, 0x1004n);
  assert.deepEqual(
    result.takenBranches.map((b) => ({ address: b.address, next: b.next, taken: b.taken })),
    [{ address: 0x1000n, next: 0x1004n, taken: false }],
  );
});

test('#6299 breakpoint stop before any branch executes fabricates no branch events', async () => {
  const sandbox = createFunctionSandbox(io, {});
  await sandbox.setup(0x1000n, { args: [0n], objectAsArg0: false, breakpoints: [0x1000n] });
  const result = await sandbox.run({ maxSteps: 10 });
  assert.equal(result.hitBreakpoint, true);
  assert.equal(result.trace.length, 0);
  assert.deepEqual(result.takenBranches, []);
});

test('#6299 breakpoint stop after a non-branch instruction fabricates no branch events', async () => {
  const sandbox = createFunctionSandbox(io, {});
  await sandbox.setup(0x1004n, { args: [0n], objectAsArg0: false, breakpoints: [0x2000n] });
  const result = await sandbox.run({ maxSteps: 10 });
  assert.deepEqual(result.trace.map((event) => event.addr), [0x1004n]);
  assert.ok(result.trace.every((event) => !/^((b\.[a-z]+)|cbz|cbnz|tbz|tbnz)\b/i.test(event.text || '')));
  assert.deepEqual(result.takenBranches, []);
});

test('#6299 breakpoint-free runs keep the previously observable branch trace', async () => {
  const sandbox = createFunctionSandbox(io, {});
  await sandbox.setup(0x1000n, { args: [0n], objectAsArg0: false });
  const result = await sandbox.run({ maxSteps: 10 });
  assert.equal(result.hitBreakpoint, false);
  assert.deepEqual(
    result.takenBranches.map((b) => ({ address: b.address, next: b.next, taken: b.taken })),
    [{ address: 0x1000n, next: 0x2000n, taken: true }],
  );
});
