import assert from 'node:assert/strict';
import test from 'node:test';

import { Emulator } from '../js/emu.js';

function zeroBased(code, executable = [0n, 4n, 8n, 0x100n]) {
  const map = new Map(Object.entries(code).map(([addr, insn]) => [BigInt(addr), insn]));
  const set = new Set(executable);
  return new Emulator({
    fetch: (addr) => map.get(BigInt(addr)) || null,
    isExecutable: (addr) => set.has(BigInt(addr)),
  });
}

test('#3847 branch back to mapped address 0 continues the loop', async () => {
  const emu = zeroBased({
    0: { mn: 'add', ops: 'x0, x0, #1' },
    4: { mn: 'b', ops: '#0' },
  });
  emu.setup(0n, [0]);
  assert.equal((await emu.step()).ok, true);
  assert.equal(emu.pc, 4n);
  const back = await emu.step();
  assert.equal(back.ok, true, `branch to address 0 must not end execution: ${back.reason}`);
  assert.equal(emu.pc, 0n);
  assert.equal((await emu.step()).ok, true);
  assert.equal(emu.get('x0'), 2n);
});

test('#3847 indirect br to mapped address 0 continues execution', async () => {
  const emu = zeroBased({
    0: { mn: 'add', ops: 'x0, x0, #1' },
    4: { mn: 'mov', ops: 'x1, #0' },
    8: { mn: 'br', ops: 'x1' },
  }, [0n, 4n, 8n]);
  emu.setup(0n, [0]);
  await emu.step();
  await emu.step();
  const jump = await emu.step();
  assert.equal(jump.ok, true, `br to address 0 must not end execution: ${jump.reason}`);
  assert.equal(emu.pc, 0n);
  assert.equal((await emu.step()).ok, true);
  assert.equal(emu.get('x0'), 2n);
});

test('#3847 top-level ret still reports the return-to-caller stop', async () => {
  const emu = zeroBased({
    0: { mn: 'ret', ops: '' },
  });
  emu.setup(0n, [0]);
  const r = await emu.step();
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /最初の呼び出し元/);
});

test('#3847 nested ret back into a zero-based caller keeps emulating', async () => {
  const emu = zeroBased({
    0: { mn: 'bl', ops: '#0x100' },
    4: { mn: 'add', ops: 'x0, x0, #1' },
    8: { mn: 'mov', ops: 'x30, #0' },
    12: { mn: 'ret', ops: '' },
    256: { mn: 'ret', ops: '' },
  }, [0n, 4n, 8n, 12n, 0x100n]);
  emu.setup(0n, [0]);
  assert.equal((await emu.step()).ok, true);
  assert.equal(emu.pc, 0x100n);
  const calleeReturn = await emu.step();
  assert.equal(calleeReturn.ok, true, `callee return to a zero-based caller must continue: ${calleeReturn.reason}`);
  assert.equal(emu.pc, 4n);
  assert.equal(emu.callStack.length, 1);
  await emu.step();
  await emu.step();
  const topLevel = await emu.step();
  assert.equal(topLevel.ok, false);
  assert.match(String(topLevel.reason), /最初の呼び出し元/);
});

test('#3847 unmapped zero target faults by mapping policy, not as a sentinel', async () => {
  const emu = zeroBased({
    4: { mn: 'b', ops: '#0' },
  }, [4n]);
  emu.setup(4n, [0]);
  const jump = await emu.step();
  assert.equal(jump.ok, true, `branch to unmapped 0 must not be a return sentinel: ${jump.reason}`);
  assert.equal(emu.pc, 0n);
  const stop = await emu.step();
  assert.equal(stop.ok, false);
  assert.doesNotMatch(String(stop.reason), /最初の呼び出し元/);
});