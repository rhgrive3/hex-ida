// Regression for #4693: AArch64 conditional branches with a target exactly at
// PC+4 are observationally indistinguishable from fallthrough in a next-PC-only
// trace, so `branchTrace()` must never collapse them to `taken:false`.
// Contract now: the Emulator records the authoritative condition evaluation on
// the trace event (`branch:{conditional,taken,target}`), FunctionSandbox
// projects it into `takenBranches`, and a legacy trace without that field
// reports `taken:null` + `ambiguous:true` for the PC+4 case instead of false.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFunctionSandbox } from '../js/symbolic/function-sandbox.js';
import { LocalFunctionSandboxAdapter } from '../js/adapters/index.js';

function branchIo(instructions) {
  return {
    fetch: async (pc) => instructions[pc.toString()] || null,
    read: async () => null,
    isExecutable: () => true,
  };
}

function sandboxAt(instructions, address, opts = {}) {
  return createFunctionSandbox(branchIo(instructions), opts);
}

test('#4693 cbz with target PC+4 and zero register records taken:true', async () => {
  const sandbox = sandboxAt({
    '4096': { mn: 'cbz', ops: 'x0, #0x1004' },
    '4100': { mn: 'ret', ops: '' },
  }, 0x1000n);
  await sandbox.setup(0x1000n, { args: [0n], objectAsArg0: false, breakpoints: [0x1004n] });
  const result = await sandbox.run({ maxSteps: 10 });
  assert.equal(result.hitBreakpoint, true);
  assert.deepEqual(
    result.takenBranches.map((b) => ({ address: b.address, next: b.next, taken: b.taken })),
    [{ address: 0x1000n, next: 0x1004n, taken: true }],
  );
  assert.equal(result.takenBranches[0].ambiguous, undefined);
  assert.deepEqual(result.trace[0].branch, { conditional: true, taken: true, target: 0x1004n });
});

test('#4693 same cbz-to-PC+4 with nonzero register records authoritative taken:false', async () => {
  const sandbox = sandboxAt({
    '4096': { mn: 'cbz', ops: 'x0, #0x1004' },
    '4100': { mn: 'ret', ops: '' },
  }, 0x1000n);
  await sandbox.setup(0x1000n, { args: [5n], objectAsArg0: false, breakpoints: [0x1004n] });
  const result = await sandbox.run({ maxSteps: 10 });
  assert.equal(result.hitBreakpoint, true);
  assert.equal(result.takenBranches.length, 1);
  assert.equal(result.takenBranches[0].taken, false);
  assert.equal(result.takenBranches[0].ambiguous, undefined);
  assert.deepEqual(result.trace[0].branch, { conditional: true, taken: false, target: null });
});

test('#4693 normal taken branch (target != PC+4) keeps taken:true', async () => {
  const sandbox = sandboxAt({
    '4096': { mn: 'cbz', ops: 'x0, #0x2000' },
    '4100': { mn: 'ret', ops: '' },
    '8192': { mn: 'ret', ops: '' },
  }, 0x1000n);
  await sandbox.setup(0x1000n, { args: [0n], objectAsArg0: false, breakpoints: [0x2000n] });
  const result = await sandbox.run({ maxSteps: 10 });
  assert.deepEqual(
    result.takenBranches.map((b) => ({ address: b.address, next: b.next, taken: b.taken })),
    [{ address: 0x1000n, next: 0x2000n, taken: true }],
  );
});

test('#4693 normal fallthrough (target != PC+4, not taken) keeps taken:false', async () => {
  const sandbox = sandboxAt({
    '4096': { mn: 'cbz', ops: 'x0, #0x2000' },
    '4100': { mn: 'ret', ops: '' },
    '8192': { mn: 'ret', ops: '' },
  }, 0x1000n);
  await sandbox.setup(0x1000n, { args: [7n], objectAsArg0: false, breakpoints: [0x1004n] });
  const result = await sandbox.run({ maxSteps: 10 });
  assert.deepEqual(
    result.takenBranches.map((b) => ({ address: b.address, next: b.next, taken: b.taken })),
    [{ address: 0x1000n, next: 0x1004n, taken: false }],
  );
});

test('#4693 b.cond/cbnz/tbz/tbnz with target PC+4 record taken:true when condition holds', async () => {
  const cases = [
    {
      label: 'b.eq',
      instructions: {
        '4096': { mn: 'cmp', ops: 'x0, #1' },
        '4100': { mn: 'b.eq', ops: '#0x1008' },
        '4104': { mn: 'ret', ops: '' },
        '4108': { mn: 'ret', ops: '' },
      },
      registers: { x0: 1n },
      expect: { address: 0x1004n, next: 0x1008n, taken: true },
    },
    {
      label: 'cbnz',
      instructions: {
        '4096': { mn: 'cbnz', ops: 'x0, #0x1004' },
        '4100': { mn: 'ret', ops: '' },
      },
      registers: { x0: 9n },
      expect: { address: 0x1000n, next: 0x1004n, taken: true },
    },
    {
      label: 'tbz',
      instructions: {
        '4096': { mn: 'tbz', ops: 'x0, #0, #0x1004' },
        '4100': { mn: 'ret', ops: '' },
      },
      registers: { x0: 0n },
      expect: { address: 0x1000n, next: 0x1004n, taken: true },
    },
    {
      label: 'tbnz',
      instructions: {
        '4096': { mn: 'tbnz', ops: 'x0, #0, #0x1004' },
        '4100': { mn: 'ret', ops: '' },
      },
      registers: { x0: 1n },
      expect: { address: 0x1000n, next: 0x1004n, taken: true },
    },
  ];
  for (const c of cases) {
    const sandbox = sandboxAt(c.instructions, 0x1000n);
    await sandbox.setup(0x1000n, { args: [], objectAsArg0: false, registers: c.registers, breakpoints: [c.expect.next] });
    const result = await sandbox.run({ maxSteps: 10 });
    assert.deepEqual(
      result.takenBranches.map((b) => ({ address: b.address, next: b.next, taken: b.taken })),
      [c.expect],
      `${c.label} to PC+4 must record the executed fact`,
    );
  }
});

test('#4693 legacy trace without authoritative field fails closed to taken:null/ambiguous:true', async () => {
  const sandbox = sandboxAt({ '4096': { mn: 'ret', ops: '' } }, 0x1000n);
  await sandbox.setup(0x1000n, { args: [0n], objectAsArg0: false, breakpoints: [0x1000n] });
  sandbox.emulator.trace.push(
    { addr: 0x3000n, text: 'cbz x0, #0x3004' },
    { addr: 0x3004n, text: 'nop' },
    { addr: 0x4000n, text: 'cbnz x0, #0x4008' },
    { addr: 0x4008n, text: 'nop' },
  );
  const result = await sandbox.run({ maxSteps: 10 });
  assert.equal(result.hitBreakpoint, true);
  assert.deepEqual(
    result.takenBranches.map((b) => ({ address: b.address, next: b.next, taken: b.taken, ambiguous: b.ambiguous })),
    [
      { address: 0x3000n, next: 0x3004n, taken: null, ambiguous: true },
      { address: 0x4000n, next: 0x4008n, taken: true, ambiguous: undefined },
    ],
  );
});

test('#4693 adapter stepInto records authoritative taken:true for a PC+4 conditional branch', async () => {
  const adapter = new LocalFunctionSandboxAdapter(branchIo({
    '4096': { mn: 'cbz', ops: 'x0, #0x1004' },
    '4100': { mn: 'ret', ops: '' },
  }));
  await adapter.launch({ address: 0x1000n, registers: { x0: 0n }, objectAsArg0: false, memoryMappings: [] });
  await adapter.stepInto();
  const snapshot = await adapter.trace();
  const branch = snapshot.events.find((event) => event?.type === 'branch');
  assert.ok(branch, 'stepInto must emit a branch trace event');
  assert.equal(branch.address, 0x1000n);
  assert.equal(branch.next, 0x1004n);
  assert.equal(branch.taken, true);
  assert.equal(branch.ambiguous, undefined);
});
