// Regression for #5685: Emulator.mapZero() marked every touched page fully
// valid (loadedValid = PAGE), so a synthetic mapping declared as
// [0x1003, 0x1004) silently enabled reads/writes across the whole 4 KiB page.
// Contract now: a mapZero-created page backs exactly the union of its
// declared [lo, hi) windows; bytes outside stay unmapped-memory unless real
// backing (file page, stack, heap) provides them.
import assert from 'node:assert/strict';
import { Emulator } from '../js/emu.js';

const PAGE = 4096;

async function expectUnmapped(fn, label) {
  await assert.rejects(fn, (error) => {
    assert.equal(error.code, 'unmapped-memory', `${label}: expected unmapped-memory, got ${error.code}`);
    return true;
  }, label);
}

// 1. The issue's exact scenario: 1-byte mapping at an unaligned address.
{
  const emu = new Emulator({});
  emu.mapZero(0x1003n, 1);
  assert.equal(await emu.load(0x1003n, 1), 0n, 'the declared byte is readable');
  await expectUnmapped(() => emu.load(0x1002n, 1), 'byte below the mapping');
  await expectUnmapped(() => emu.load(0x1004n, 1), 'byte above the mapping');
  await expectUnmapped(() => emu.store(0x1fffn, 1, 0x41n), 'write at page tail');
  await emu.store(0x1003n, 1, 0x41n);
  assert.equal(await emu.load(0x1003n, 1), 0x41n, 'write inside the mapping persists');
}

// 2. A page-aligned full-page mapping keeps whole-page validity.
{
  const emu = new Emulator({});
  emu.mapZero(0x2000n, BigInt(PAGE));
  assert.equal(await emu.load(0x2000n, 1), 0n);
  assert.equal(await emu.load(0x2000n + BigInt(PAGE - 1), 1), 0n, 'last byte of the page is inside the mapping');
  await expectUnmapped(() => emu.load(0x2000n + BigInt(PAGE), 1), 'next page stays unmapped');
}

// 3. A mapping spanning several pages keeps both boundary pages exact.
{
  const emu = new Emulator({});
  emu.mapZero(0x3005n, 0x2000n);
  assert.equal(await emu.load(0x3005n, 1), 0n);
  await expectUnmapped(() => emu.load(0x3004n, 1), 'head page lower boundary');
  assert.equal(await emu.load(0x5004n, 1), 0n, 'tail page upper boundary byte');
  await expectUnmapped(() => emu.load(0x5005n, 1), 'byte past the end');
}

// 4. Several mapZero windows on one page form a union; outside stays unmapped.
{
  const emu = new Emulator({});
  emu.mapZero(0x6003n, 1);
  emu.mapZero(0x6008n, 2);
  assert.equal(await emu.load(0x6003n, 1), 0n, 'first window readable');
  assert.equal(await emu.load(0x6009n, 1), 0n, 'second window readable');
  await expectUnmapped(() => emu.load(0x6004n, 1), 'between the windows');
  await expectUnmapped(() => emu.load(0x6007n, 1), 'between the windows (upper)');
}

// 5. Extending a mapping widens its window on the same page.
{
  const emu = new Emulator({});
  emu.mapZero(0x7003n, 1);
  emu.mapZero(0x7004n, 2);
  assert.equal(await emu.load(0x7003n, 3), 0n, 'the joined window is readable');
  await expectUnmapped(() => emu.load(0x7002n, 1), 'below the joined window');
  await expectUnmapped(() => emu.load(0x7006n, 1), 'above the joined window');
}

// 6. A page with real file backing keeps it; the synthetic window is additive.
{
  const file = new Uint8Array(PAGE);
  for (let i = 0; i < 100; i++) file[i] = 0xaa;
  const emu = new Emulator({ read: async () => file.subarray(0, 100) });
  assert.equal(await emu.load(0x8010n, 1), 0xaan, 'real file bytes are readable');
  emu.mapZero(0x8080n, 4);
  assert.equal(await emu.load(0x8010n, 1), 0xaan, 'real backing survives mapZero on the same page');
  assert.equal(await emu.load(0x8083n, 1), 0n, 'the synthetic window is readable');
  await expectUnmapped(() => emu.load(0x8090n, 1), 'beyond real extent and window');
}

// 7. FunctionSandbox with an unaligned objectBase: the sandbox's own
//    synthetic object mapping is exact (the issue's integration boundary).
//    maxObjectSize is clamped to a 0x100 minimum by the sandbox contract.
{
  const { FunctionSandbox } = await import('../js/symbolic/function-sandbox.js');
  const sandbox = new FunctionSandbox({}, { objectBase: 0x9010n, maxObjectSize: 0x18 });
  await sandbox.setup(0x8000n, {});
  const emu = sandbox.emulator;
  // The sandbox object was mapped by FunctionSandbox itself via mapZero,
  // clamped to [0x9010, 0x9110) by the 0x100 minimum object size.
  const objectEnd = 0x9010n + 0x100n;
  await emu.store(0x9020n, 4, 0x11223344n);
  assert.equal(await emu.load(0x9020n, 4), 0x11223344n, 'field write inside the object works');
  await emu.store(0x9108n, 8, 0x42n);
  assert.equal(await emu.load(0x9108n, 8), 0x42n, 'the last object field reads back');
  await expectUnmapped(() => emu.load(0x900fn, 1), 'byte before the object');
  await expectUnmapped(() => emu.load(objectEnd, 1), 'byte after the object');
}

// 8. A run through FunctionSandbox cannot read/write outside the declared
//    object: a guest store past the object end faults instead of hitting
//    whole-page synthetic backing.
{
  const { FunctionSandbox } = await import('../js/symbolic/function-sandbox.js');
  const sandbox = new FunctionSandbox({}, { objectBase: 0xa010n, maxObjectSize: 0x100 });
  await sandbox.setup(0x8000n, {});
  const emu = sandbox.emulator;
  await expectUnmapped(() => emu.store(0xa120n, 4, 1n), 'guest write past the object end');
  await expectUnmapped(() => emu.load(0xa120n, 4), 'guest read past the object end');
}

console.log('issue-5685 emu mapZero exact synthetic range: ok');
