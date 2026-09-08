import assert from 'node:assert/strict';
import { createApi } from '../js/script.js';
import { classItems, externalItems } from '../js/ui/product.js';

// ── #2627: hex.findStrings(query, limit) early termination and parity ──
{
  let accessed = 0;
  const strings = Array.from({ length: 60_000 }, (_, i) => ({
    addr: BigInt(0x1000 + i * 16),
    get text() {
      accessed++;
      return `str_${i}_needle_${i % 100}`;
    },
  }));

  const fakeApp = {
    stringIndex: strings,
  };

  const out = { log() {}, warn() {}, error() {} };
  const { api: hex } = createApi(fakeApp, out);

  // Common match with small limit should break early
  accessed = 0;
  const res1 = hex.findStrings('needle', 10);
  assert.equal(res1.length, 10);
  assert.equal(accessed, 10, `expected 10 string accesses with early break, got ${accessed}`);

  // Empty query with limit
  accessed = 0;
  const res2 = hex.findStrings('', 5);
  assert.equal(res2.length, 5);
  assert.equal(accessed, 5, `expected 5 string accesses with early break, got ${accessed}`);

  // Case insensitive match
  accessed = 0;
  const res3 = hex.findStrings('STR_0_NEEDLE', 1);
  assert.equal(res3.length, 1);
  assert.equal(res3[0].addr, 0x1000n);
}

// ── #5900: findStrings no-match must be bounded by a scan budget and abortable ──
{
  let accessed = 0;
  const strings = Array.from({ length: 50_000 }, (_, i) => ({
    addr: BigInt(0x1000 + i * 16),
    get text() { accessed++; return 'A'.repeat(128) + i; },
  }));
  const fakeApp = { stringIndex: strings };
  const out = { log() {}, warn() {}, error() {} };
  const { api: hex } = createApi(fakeApp, out);

  // No-match over a large index must stop at the scan budget, not walk all
  // 50k entries (pre-fix this scanned every item).
  accessed = 0;
  const noMatch = hex.findStrings('__never_exists__', 1, { scanLimit: 1000 });
  assert.equal(noMatch.length, 0);
  assert.equal(accessed, 1000, `expected the scan budget to bound text accesses, got ${accessed}`);
  assert.equal(noMatch.complete, false);
  assert.equal(noMatch.completeness, 'partial');
  assert.equal(noMatch.truncationReason, 'scan-budget');
  assert.equal(noMatch.scannedItems, 1000);

  // Malformed/non-string entries still consume the hard item denominator, and
  // the candidate getter is never touched after that denominator is exhausted.
  let malformedAccessed = 0;
  const malformed = Array.from({ length: 2000 }, () => ({
    get text() { malformedAccessed++; return null; },
  }));
  const { api: malformedHex } = createApi({ stringIndex: malformed }, out);
  const malformedResult = malformedHex.findStrings('__never_exists__', 1, { scanLimit: 37 });
  assert.equal(malformedResult.scannedItems, 37);
  assert.equal(malformedAccessed, 37, 'item budget must be charged before candidate.text access');
  assert.equal(malformedResult.scannedTextBytes, 0, 'non-string text must not consume the text-byte denominator');
  assert.equal(malformedResult.complete, false);
  assert.equal(malformedResult.truncationReason, 'scan-budget');

  // context.scanLimit can lower but never raise the default budget.
  let raiseAccessed = 0;
  const small = Array.from({ length: 3000 }, (_, i) => ({
    addr: BigInt(0x5000 + i * 8),
    get text() { raiseAccessed++; return `needle_${i}`; },
  }));
  const smallApp = { stringIndex: small };
  const { api: hex2 } = createApi(smallApp, out);
  raiseAccessed = 0;
  const capped = hex2.findStrings('__never_exists__', 1, { scanLimit: 500 });
  assert.equal(capped.scannedItems, 500, 'context.scanLimit must lower the scan budget');
  assert.equal(raiseAccessed, 500);
  assert.equal(capped.complete, false);
  raiseAccessed = 0;
  const attempted = hex2.findStrings('__never_exists__', 1, { scanLimit: 999_999_999 });
  assert.equal(attempted.scannedItems, 3000, 'context.scanLimit must never raise the default budget');
  assert.equal(raiseAccessed, 3000);
  assert.equal(attempted.complete, true, 'full walk of a small index is complete, not truncated');

  // Full-walk completion keeps legacy Array parity and reports completion.
  raiseAccessed = 0;
  const found = hex2.findStrings('needle_2999', 10);
  assert.equal(found.length, 1);
  assert.equal(found.complete, true);
  assert.equal(found.completeness, 'complete');
  assert.equal(found.truncationReason, null);
  assert.equal(found.scannedItems, 3000);

  // Abort before the scan starts must throw instead of scanning.
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => hex2.findStrings('needle', 5, { signal: controller.signal }), (e) => e.name === 'AbortError');

  // A timer-scheduled abort must be deliverable after scanning starts. The
  // signal-aware path yields every chunk, so it stops before the raw scan cap.
  let cancelAccessed = 0;
  const rawCap = 10_000;
  const cancellable = Array.from({ length: rawCap }, (_, i) => ({
    addr: BigInt(0x9000 + i * 8),
    get text() { cancelAccessed++; return `row_${i}`; },
  }));
  const { api: cancellableHex } = createApi({ stringIndex: cancellable }, out);
  const midController = new AbortController();
  const abortTimer = setTimeout(() => midController.abort(), 0);
  await assert.rejects(
    cancellableHex.findStrings('__never_exists__', 1, { signal: midController.signal, scanLimit: rawCap }),
    (e) => e.name === 'AbortError'
  );
  clearTimeout(abortTimer);
  assert.ok(cancelAccessed > 0, 'mid-scan regression must begin scanning before cancellation');
  assert.ok(cancelAccessed < rawCap, `scheduled abort must stop before raw cap; accessed ${cancelAccessed}`);

  // Small text-byte boundaries: the scan must preflight the byte fit before
  // processing a candidate, so an over-budget candidate can never be searched
  // and a final over-budget candidate can never report a complete scan.
  const byteFitApp = { stringIndex: [{ text: 'abc' }] };
  const { api: byteFitHex } = createApi(byteFitApp, out);
  const overBudget = byteFitHex.findStrings('abc', 1, { scanBytes: 4 });
  assert.equal(overBudget.length, 0, 'a candidate larger than the byte budget must not be searched');
  assert.equal(overBudget.scannedTextBytes, 0, 'an over-budget candidate must not be charged');
  assert.equal(overBudget.complete, false);
  assert.equal(overBudget.truncationReason, 'scan-budget');
  const exactFit = byteFitHex.findStrings('abc', 1, { scanBytes: 6 });
  assert.equal(exactFit.length, 1, 'an exact-fit candidate is searched');
  assert.equal(exactFit.complete, true, 'exact fit consumes the whole budget but finishes the walk');
  assert.equal(exactFit.truncationReason, null);
  assert.equal(exactFit.scannedTextBytes, 6);
  // Final-candidate completeness: the last matching candidate is charged and
  // the result stays complete even though the byte budget is now exhausted.
  const finalCandidate = byteFitHex.findStrings('abc', 1, { scanBytes: 12 });
  assert.equal(finalCandidate.length, 1);
  assert.equal(finalCandidate.complete, true);
  assert.equal(finalCandidate.truncationReason, null);
  // A second candidate after the byte budget is exhausted must truncate.
  const twoCandidates = { stringIndex: [{ text: 'ab' }, { text: 'cd' }] };
  const { api: twoHex } = createApi(twoCandidates, out);
  const exhausted = twoHex.findStrings('__never_exists__', 1, { scanBytes: 4 });
  assert.equal(exhausted.scannedTextBytes, 4);
  assert.equal(exhausted.complete, false, 'byte-budget exhaustion after the first candidate is partial');
  assert.equal(exhausted.truncationReason, 'scan-budget');
}

// ── #2628: Product Explorer Classes caching and filtering ──
{
  const classesMap = new Map();
  for (let i = 0; i < 500; i++) {
    classesMap.set(`Class_${i}`, {
      methods: ['init', 'run'],
      ivars: ['_count'],
      superName: 'NSObject',
    });
  }

  const app = {
    fields: { classes: classesMap },
  };

  const all = classItems(app, '');
  assert.equal(all.length, 500);
  assert.equal(all[0].name, 'Class_0');

  const filtered = classItems(app, 'class_10');
  assert.ok(filtered.some((c) => c.name === 'Class_10'));

  // Object-based classes
  const appObj = {
    objcModel: {
      classes: [
        { name: 'MyController', superclass: 'UIViewController', methods: ['viewDidLoad'], ivars: [] },
      ],
    },
  };
  const objcAll = classItems(appObj, 'mycontroller');
  assert.equal(objcAll.length, 1);
  assert.equal(objcAll[0].name, 'MyController');
}

// ── #2629: Product Explorer External caching and deduplication ──
{
  const fileInfo = { format: 'Mach-O' };
  const app = {
    store: {
      get: (k) => k === 'fileInfo' ? fileInfo : null,
    },
    currentSlice: () => ({
      info: {
        dylibs: ['/usr/lib/libSystem.B.dylib', '/System/Library/Frameworks/Foundation.framework/Foundation'],
      },
    }),
    symbols: {
      imports: [
        { name: '_malloc', addr: 0x2000n },
        { name: '_free', addr: 0x2008n },
      ],
    },
  };

  const all = externalItems(app, '');
  assert.equal(all.length, 4);

  const filtered = externalItems(app, 'malloc');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].name, '_malloc');
  assert.equal(filtered[0].kind, 'import');

  const dylibFiltered = externalItems(app, 'foundation');
  assert.equal(dylibFiltered.length, 1);
  assert.equal(dylibFiltered[0].kind, 'dylib');
}

console.log('Issue #2627, #2628, #2629 regression tests PASS!');
