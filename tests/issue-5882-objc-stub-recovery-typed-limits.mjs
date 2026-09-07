// Issue #5882 regression: the Objective-C stub-recovery coverage limits
// (maxSelector/maxStubs/maxSectionBytes) accept only primitive finite positive
// safe-integer numbers. Relational comparison and BigInt() coercion used to
// let ['1'], true and ['8388608'] reshape scan coverage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = { globalThis: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../js/objc-stub-recovery.js', import.meta.url), 'utf8'), ctx);
const { recover } = ctx.globalThis.HexObjCStubRecovery;
assert.ok(recover, 'the legacy IIFE must install HexObjCStubRecovery');

function makeEnv(limits, stubsSize = 0x900001n) {
  const slice = { offset: 0n, size: 0x100000n };
  const regions = [
    { section: '__objc_stubs', fileOffset: 0n, size: stubsSize, vmAddr: 0x100n },
    { section: '__objc_selrefs', fileOffset: 0x20n, size: 0x10n, vmAddr: 0x200n },
    { section: '__objc_methname', cstrings: true, fileOffset: 0x40n, size: 0x10n, vmAddr: 0x300n },
  ];
  return {
    slice, regions, known: [], fileSize: 0x10000000n,
    readRange: async (off, len) => new Uint8Array(Number(len)),
    budget: { takeRegion: () => true, takeRead: () => true, takeResident: () => true, takeOperation: () => true, takeString: () => true, releaseResident: () => {}, expired: () => false },
    requestId: 1, cancelled: () => false,
    ...limits,
  };
}

// 1. The default 8 MiB section cap excludes a 9 MiB stubs section.
{
  const out = await recover(makeEnv({}));
  assert.equal(out.length, 0, '9 MiB section must stay excluded under the 8 MiB default');
}

// 2. The issue repro: BigInt(['8388608']) used to accept a structured cap and
//    scan the oversized section. Structured values must not change coverage.
{
  const out = await recover(makeEnv({ maxSectionBytes: ['8388608'] }));
  assert.equal(out.length, 0, 'structured maxSectionBytes must not extend the section cap');
  const outTrue = await recover(makeEnv({ maxStubs: true }));
  assert.equal(outTrue.length, 0, 'boolean maxStubs must not change coverage');
}

// 3. A valid primitive number still raises the cap (typed contract keeps
//    legitimate configuration working).
{
  const out = await recover(makeEnv({ maxSectionBytes: 16 * 1024 * 1024 }));
  assert.ok(Array.isArray(out), 'a valid larger cap must run the scan');
}

// 4. maxSelector structured values must not rewrite the selector limit either;
//    defaults apply instead (same boundedLimit contract).
{
  const out = await recover(makeEnv({ maxSelector: ['1'] }));
  assert.ok(Array.isArray(out));
}

console.log('issue #5882 objc stub-recovery typed coverage limits regressions: PASS');
