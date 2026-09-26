import test from 'node:test';
import assert from 'node:assert/strict';

import { createELFMetadataBudget, ELF_METADATA_LIMITS } from '../../../js/binary/elf-budget.js';
import { createMachOMetadataBudget, MACHO_METADATA_LIMITS } from '../../../js/binary/macho-budget.js';
import { createPEMetadataBudget, PE_METADATA_LIMITS } from '../../../js/binary/pe-loader-core.js';
await import('../../../js/worker-budget.js');
const HexWorkerBudget = globalThis.HexWorkerBudget;
await import('../../../js/objc-stub-recovery.js');

test('deterministic budgets: loader limits default to wallClockMs Infinity and snapshot preserves explicit finite limits', () => {
  assert.equal(ELF_METADATA_LIMITS.wallClockMs, Infinity);
  assert.equal(MACHO_METADATA_LIMITS.wallClockMs, Infinity);
  assert.equal(PE_METADATA_LIMITS.wallClockMs, Infinity);
  assert.equal(HexWorkerBudget.SUPPLEMENTAL_WALL_MS, Infinity);

  const elfImg = { metadata: {}, warnings: [] };
  const elfDefault = createELFMetadataBudget(elfImg);
  assert.equal(elfDefault.limits.wallClockMs, Infinity);
  assert.equal(elfDefault.snapshot().limits.wallClockMs, Infinity);

  const machoImg = { metadata: {}, warnings: [] };
  const machoDefault = createMachOMetadataBudget(machoImg);
  assert.equal(machoDefault.limits.wallClockMs, Infinity);
  assert.equal(machoDefault.snapshot().limits.wallClockMs, Infinity);

  const peImg = { metadata: {}, warnings: [] };
  const peDefault = createPEMetadataBudget(peImg);
  assert.equal(peDefault.limits.wallClockMs, Infinity);
  assert.equal(peImg.metadata.peMetadata.limits.wallClockMs, Infinity);

  const workerDefault = HexWorkerBudget.createSupplementalBudget();
  assert.equal(workerDefault.expired(), false);
  assert.equal(workerDefault.truncated, false);
});

test('deterministic budgets: injected advancing clock cannot cause default loader/worker budgets to halt or truncate', () => {
  const realNow = Date.now;
  let simulatedTime = 1_000_000;
  // Clock jumps forward by 10 minutes (600,000 ms) every read
  Date.now = () => {
    const current = simulatedTime;
    simulatedTime += 600_000;
    return current;
  };

  try {
    // 1. ELF metadata budget under runaway clock
    const elfImg = { metadata: {}, warnings: [] };
    const elfBudget = createELFMetadataBudget(elfImg);
    for (let i = 0; i < 5000; i++) {
      assert.equal(elfBudget.checkpoint(), true);
      assert.equal(elfBudget.take({ operations: 1 }), true);
    }
    assert.equal(elfBudget.stopped, false);
    assert.equal(elfImg.metadata.elfMetadata.complete, true);
    assert.deepEqual(elfImg.metadata.elfMetadata.reasons, []);

    // 2. Mach-O metadata budget under runaway clock
    const machoImg = { metadata: {}, warnings: [] };
    const machoBudget = createMachOMetadataBudget(machoImg);
    for (let i = 0; i < 5000; i++) {
      assert.equal(machoBudget.take({ operations: 1 }), true);
    }
    assert.equal(machoBudget.stopped, false);
    assert.equal(machoImg.metadata.machoMetadata.complete, true);
    assert.deepEqual(machoImg.metadata.machoMetadata.reasons, []);

    // 3. PE metadata budget under runaway clock
    const peImg = { metadata: {}, warnings: [] };
    const peBudget = createPEMetadataBudget(peImg);
    for (let i = 0; i < 5000; i++) {
      assert.equal(peBudget.take({ operations: 1 }), true);
    }
    assert.equal(peBudget.stopped, false);
    assert.equal(peImg.metadata.peMetadata.complete, true);
    assert.deepEqual(peImg.metadata.peMetadata.reasons, []);

    // 4. Worker supplemental budget under runaway clock
    const workerBudget = HexWorkerBudget.createSupplementalBudget();
    for (let i = 0; i < 5000; i++) {
      assert.equal(workerBudget.takeOperation(1), true);
      assert.equal(workerBudget.expired(), false);
    }
    assert.equal(workerBudget.truncated, false);
    assert.equal(workerBudget.truncationReason, null);
  } finally {
    Date.now = realNow;
  }
});

test('deterministic budgets: explicit opt-in wallClockMs still bounds execution with wall-clock reasons', () => {
  const realNow = Date.now;
  let simulatedTime = 1_000_000;
  Date.now = () => simulatedTime;

  try {
    // 1. ELF explicit wallClockMs
    const elfImg = { metadata: {}, warnings: [] };
    const elfBudget = createELFMetadataBudget(elfImg, { limits: { wallClockMs: 50 } });
    assert.equal(elfBudget.take({ operations: 1 }), true);
    simulatedTime += 100;
    assert.equal(elfBudget.checkpoint(), false);
    assert.equal(elfBudget.stopped, true);
    assert.equal(elfImg.metadata.elfMetadata.complete, false);
    assert.deepEqual(elfImg.metadata.elfMetadata.reasons, ['budget:wall-clock']);

    // 2. Mach-O explicit wallClockMs
    const machoImg = { metadata: {}, warnings: [] };
    const machoBudget = createMachOMetadataBudget(machoImg, { limits: { wallClockMs: 50 } });
    assert.equal(machoBudget.take({ operations: 1 }), true);
    simulatedTime += 100;
    assert.equal(machoBudget.take({ operations: 1024 }), false);
    assert.equal(machoBudget.stopped, true);
    assert.equal(machoImg.metadata.machoMetadata.complete, false);
    assert.deepEqual(machoImg.metadata.machoMetadata.reasons, ['budget:wall-clock']);

    // 3. PE explicit wallClockMs
    const peImg = { metadata: {}, warnings: [] };
    const peBudget = createPEMetadataBudget(peImg, { limits: { wallClockMs: 50 } });
    assert.equal(peBudget.take({ operations: 1 }), true);
    simulatedTime += 100;
    assert.equal(peBudget.take({ operations: 1024 }), false);
    assert.equal(peBudget.stopped, true);
    assert.equal(peImg.metadata.peMetadata.complete, false);
    assert.deepEqual(peImg.metadata.peMetadata.reasons, ['budget:wall-clock']);

    // 4. Worker supplemental explicit maxWallMs
    const workerBudget = HexWorkerBudget.createSupplementalBudget({ limits: { maxWallMs: 50 } });
    assert.equal(workerBudget.takeOperation(1), true);
    simulatedTime += 100;
    assert.equal(workerBudget.expired(), true);
    assert.equal(workerBudget.takeOperation(1), false);
    assert.equal(workerBudget.truncated, true);
    assert.equal(workerBudget.truncationReason, 'budget:wall-clock');
  } finally {
    Date.now = realNow;
  }
});

test('deterministic budgets: worker supplemental symbol recovery surfaces explicit truncation flag when deterministic budget is hit', async () => {
  // Test that HexObjCStubRecovery attaches truncated flag and truncationReason when budget is exhausted
  const { recover } = globalThis.HexObjCStubRecovery;

  // Environment where budget limits are hit
  const STUBS_FILE = 0x1000n;
  const SELREFS_FILE = 0x2000n;
  const TEXT_FILE = 0x3000n;
  const STUBS_VM = 0x100000n;
  const SELREFS_VM = 0x200000n;
  const TEXT_VM = 0x300000n;

  const selector = 'abc';
  const selectorBytes = Uint8Array.from([...selector].map((ch) => ch.charCodeAt(0)).concat(0));
  const selrefBytes = new Uint8Array(8);
  let v = TEXT_VM;
  for (let i = 0; i < 8; i++) {
    selrefBytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }

  // 10 stubs worth of words: [1, 2, 3] * 10
  const words = Array.from({ length: 10 }, () => [1, 2, 3]).flat();
  const code = new Uint8Array(words.length * 4);
  const dv = new DataView(code.buffer);
  words.forEach((w, i) => dv.setUint32(i * 4, w, true));

  const regions = [
    { section: '__objc_stubs', fileOffset: STUBS_FILE, size: BigInt(code.length), vmAddr: STUBS_VM },
    { section: '__objc_selrefs', fileOffset: SELREFS_FILE, size: 8n, vmAddr: SELREFS_VM },
    { section: '__objc_methname', cstrings: true, fileOffset: TEXT_FILE, size: BigInt(selectorBytes.length), vmAddr: TEXT_VM },
  ];

  const makeTestEnv = (budget) => ({
    slice: { offset: 0n, size: 0x2000000n, regions },
    known: [],
    fileSize: 0x2000000n,
    Words: {
      KIND: { BRANCH: 'branch', RET: 'ret', OTHER: 'other' },
      pcRelTarget: (word) => word === 1 ? { reg: 0, value: SELREFS_VM } : null,
      pairedOffset: (word) => word === 2 ? { load: true, rn: 0, rd: 1, imm: 0n } : null,
      classifyWord: (word) => word === 3 ? 'branch' : 'other',
    },
    readRange: async (off, len) => {
      off = BigInt(off);
      if (off >= STUBS_FILE && off < STUBS_FILE + BigInt(code.length)) {
        const rel = Number(off - STUBS_FILE);
        return code.slice(rel, rel + len);
      }
      if (off >= SELREFS_FILE && off < SELREFS_FILE + 8n) {
        const rel = Number(off - SELREFS_FILE);
        return selrefBytes.slice(rel, rel + len);
      }
      if (off >= TEXT_FILE && off < TEXT_FILE + BigInt(selectorBytes.length)) {
        const rel = Number(off - TEXT_FILE);
        return selectorBytes.slice(rel, rel + len);
      }
      return new Uint8Array(0);
    },
    budget,
    requestId: 1,
    cancelled: () => false,
    sanitizePointer: (val) => val,
  });

  // Case 1: Normal run with plenty of budget -> not truncated
  {
    const budget = HexWorkerBudget.createSupplementalBudget();
    const result = await recover(makeTestEnv(budget));
    assert.equal(result.length, 10);
    assert.equal(result.truncated, false);
    assert.equal(result.truncationReason, null);
  }

  // Case 2: Deterministic count limit reached (e.g. maxStubs: 2) -> truncated: true
  {
    const budget = HexWorkerBudget.createSupplementalBudget();
    const env = makeTestEnv(budget);
    env.maxStubs = 2;
    const result = await recover(env);
    assert.equal(result.length, 2);
    assert.equal(result.truncated, true);
    assert.ok(result.truncationReason);
  }

  // Case 3: Deterministic operation/name budget limit reached -> truncated: true
  {
    const budget = HexWorkerBudget.createSupplementalBudget();
    // artifically exhaust budget.takeName by setting used
    let nameCount = 0;
    const originalTakeName = budget.takeName;
    budget.takeName = (n = 1) => {
      nameCount++;
      if (nameCount > 3) {
        budget.markTruncated('budget:names');
        return false;
      }
      return originalTakeName(n);
    };
    const result = await recover(makeTestEnv(budget));
    assert.equal(result.length, 3);
    assert.equal(result.truncated, true);
    assert.equal(result.truncationReason, 'budget:names');
  }
});
