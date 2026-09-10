// Regression for #5685: mapZero-created pages must authorize exactly the
// union of declared [lo, hi) windows without revoking pre-existing backing.
import assert from 'node:assert/strict';
import { Emulator } from '../../../js/emu.js';

const PAGE = 4096;

async function expectUnmapped(fn, label) {
  await assert.rejects(fn, (error) => {
    assert.equal(error.code, 'unmapped-memory', `${label}: expected unmapped-memory, got ${error.code}`);
    return true;
  }, label);
}

{
  const emu = new Emulator({});
  emu.mapZero(0x1003n, 1);
  assert.equal(await emu.load(0x1003n, 1), 0n);
  await expectUnmapped(() => emu.load(0x1002n, 1), 'byte below the mapping');
  await expectUnmapped(() => emu.load(0x1004n, 1), 'byte above the mapping');
  await expectUnmapped(() => emu.store(0x1fffn, 1, 0x41n), 'write at page tail');
  await emu.store(0x1003n, 1, 0x41n);
  assert.equal(await emu.load(0x1003n, 1), 0x41n);
}

{
  const emu = new Emulator({});
  emu.mapZero(0x2000n, BigInt(PAGE));
  assert.equal(await emu.load(0x2000n, 1), 0n);
  assert.equal(await emu.load(0x2000n + BigInt(PAGE - 1), 1), 0n);
  await expectUnmapped(() => emu.load(0x2000n + BigInt(PAGE), 1), 'next page stays unmapped');
}

{
  const emu = new Emulator({});
  emu.mapZero(0x3005n, 0x2000n);
  assert.equal(await emu.load(0x3005n, 1), 0n);
  await expectUnmapped(() => emu.load(0x3004n, 1), 'head page lower boundary');
  assert.equal(await emu.load(0x5004n, 1), 0n);
  await expectUnmapped(() => emu.load(0x5005n, 1), 'byte past the end');
}

{
  const emu = new Emulator({});
  emu.mapZero(0x6003n, 1);
  emu.mapZero(0x6008n, 2);
  assert.equal(await emu.load(0x6003n, 1), 0n);
  assert.equal(await emu.load(0x6009n, 1), 0n);
  await expectUnmapped(() => emu.load(0x6004n, 1), 'between the windows');
  await expectUnmapped(() => emu.load(0x6007n, 1), 'between the windows upper');
}

{
  const emu = new Emulator({});
  emu.mapZero(0x7003n, 1);
  emu.mapZero(0x7004n, 2);
  assert.equal(await emu.load(0x7003n, 3), 0n);
  await expectUnmapped(() => emu.load(0x7002n, 1), 'below the joined window');
  await expectUnmapped(() => emu.load(0x7006n, 1), 'above the joined window');
}

{
  const file = new Uint8Array(PAGE);
  for (let i = 0; i < 100; i++) file[i] = 0xaa;
  const emu = new Emulator({ read: async () => file.subarray(0, 100) });
  assert.equal(await emu.load(0x8010n, 1), 0xaan);
  emu.mapZero(0x8080n, 4);
  assert.equal(await emu.load(0x8010n, 1), 0xaan, 'real backing survives a disjoint mapZero');
  assert.equal(await emu.load(0x8083n, 1), 0n, 'synthetic window is additive');
  await expectUnmapped(() => emu.load(0x8090n, 1), 'gap beyond real extent/window');
}

{
  const { FunctionSandbox } = await import('../../../js/symbolic/function-sandbox.js');
  const sandbox = new FunctionSandbox({}, { objectBase: 0x9010n, maxObjectSize: 0x18 });
  await sandbox.setup(0x8000n, {});
  const emu = sandbox.emulator;
  const objectEnd = 0x9010n + 0x100n;
  await emu.store(0x9020n, 4, 0x11223344n);
  assert.equal(await emu.load(0x9020n, 4), 0x11223344n);
  await emu.store(0x9108n, 8, 0x42n);
  assert.equal(await emu.load(0x9108n, 8), 0x42n);
  await expectUnmapped(() => emu.load(0x900fn, 1), 'byte before the object');
  await expectUnmapped(() => emu.load(objectEnd, 1), 'byte after the object');
}

{
  const { FunctionSandbox } = await import('../../../js/symbolic/function-sandbox.js');
  const sandbox = new FunctionSandbox({}, { objectBase: 0xa010n, maxObjectSize: 0x100 });
  await sandbox.setup(0x8000n, {});
  const emu = sandbox.emulator;
  await expectUnmapped(() => emu.store(0xa120n, 4, 1n), 'guest write past the object end');
  await expectUnmapped(() => emu.load(0xa120n, 4), 'guest read past the object end');
}

console.log('issue-5685 emu mapZero exact synthetic range: ok');
