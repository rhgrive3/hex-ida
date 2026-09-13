import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi } from '../js/script.js';

test('issue #5900: hex.findStrings respects cancellation signal and scan budget', async (t) => {
  await t.test('pre-aborted signal throws immediately without scanning', () => {
    let accessed = 0;
    const strings = Array.from({ length: 1000 }, (_, i) => ({
      addr: BigInt(0x1000 + i * 16),
      get text() {
        accessed++;
        return `str_${i}`;
      },
    }));

    const fakeApp = { stringIndex: strings };
    const out = { log() {}, warn() {}, error() {} };
    const { api: hex } = createApi(fakeApp, out);

    const controller = new AbortController();
    controller.abort(new Error('custom-abort-reason'));

    assert.throws(
      () => hex.findStrings('needle', 10, { signal: controller.signal }),
      (err) => err.message === 'custom-abort-reason',
    );
    assert.equal(accessed, 0, 'no strings should be accessed when signal is already aborted');
  });

  await t.test('aborted signal during scan terminates early', () => {
    let accessed = 0;
    const controller = new AbortController();
    const strings = Array.from({ length: 10_000 }, (_, i) => ({
      addr: BigInt(0x1000 + i * 16),
      get text() {
        accessed++;
        if (accessed === 2000) {
          controller.abort(new Error('cancelled-mid-scan'));
        }
        return `nomatch_${i}`;
      },
    }));

    const fakeApp = { stringIndex: strings };
    const out = { log() {}, warn() {}, error() {} };
    const { api: hex } = createApi(fakeApp, out);

    assert.throws(
      () => hex.findStrings('needle', 10, { signal: controller.signal }),
      (err) => err.message === 'cancelled-mid-scan',
    );
    assert.ok(accessed < 10_000, `expected scan to abort before 10,000 items, got ${accessed}`);
  });

  await t.test('context maxScanned caps scan work and surfaces partial completeness', () => {
    let accessed = 0;
    const strings = Array.from({ length: 10_000 }, (_, i) => ({
      addr: BigInt(0x1000 + i * 16),
      get text() {
        accessed++;
        return `nomatch_${i}`;
      },
    }));

    const fakeApp = { stringIndex: strings };
    const out = { log() {}, warn() {}, error() {} };
    const { api: hex } = createApi(fakeApp, out);

    const results = hex.findStrings('needle', 10, { maxScanned: 500 });
    assert.equal(results.length, 0);
    assert.equal(results.complete, false);
    assert.equal(results.completeness, 'partial');
    assert.equal(results.reason, 'scan-budget-exhausted');
    assert.equal(results.scanned, 500);
    assert.equal(accessed, 500);
  });

  await t.test('complete search without early abort surfaces complete status', () => {
    const strings = [
      { addr: 0x1000n, text: 'hello world' },
      { addr: 0x1010n, text: 'needle in haystack' },
      { addr: 0x1020n, text: 'goodbye world' },
    ];

    const fakeApp = { stringIndex: strings };
    const out = { log() {}, warn() {}, error() {} };
    const { api: hex } = createApi(fakeApp, out);

    const results = hex.findStrings('needle', 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].addr, 0x1010n);
    assert.equal(results.complete, true);
    assert.equal(results.completeness, 'complete');
    assert.equal(results.reason, null);
  });
});
