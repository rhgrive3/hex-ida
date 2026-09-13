import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi } from '../js/script.js';

test('issue #5900: hex.findStrings respects cancellation signal and scan budget', async (t) => {
  await t.test('pre-aborted signal throws immediately without scanning', async () => {
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

    await assert.rejects(
      async () => hex.findStrings('needle', 10, { signal: controller.signal }),
      (err) => err.message === 'custom-abort-reason',
    );
    assert.equal(accessed, 0, 'no strings should be accessed when signal is already aborted');
  });

  await t.test('aborted signal during scan terminates early', async () => {
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

    await assert.rejects(
      async () => hex.findStrings('needle', 10, { signal: controller.signal }),
      (err) => err.message === 'cancelled-mid-scan',
    );
    assert.ok(accessed < 10_000, `expected scan to abort before 10,000 items, got ${accessed}`);
  });

  await t.test('context maxScanned caps scan work and surfaces partial completeness', async () => {
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

    const results = await hex.findStrings('needle', 10, { maxScanned: 500 });
    assert.equal(results.length, 0);
    assert.equal(results.complete, false);
    assert.equal(results.completeness, 'partial');
    assert.equal(results.reason, 'scan-budget-exhausted');
    assert.equal(results.scanned, 500);
    assert.equal(accessed, 500);
  });

  await t.test('complete search without early abort surfaces complete status', async () => {
    const strings = [
      { addr: 0x1000n, text: 'hello world' },
      { addr: 0x1010n, text: 'needle in haystack' },
      { addr: 0x1020n, text: 'goodbye world' },
    ];

    const fakeApp = { stringIndex: strings };
    const out = { log() {}, warn() {}, error() {} };
    const { api: hex } = createApi(fakeApp, out);

    const results = await hex.findStrings('needle', 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].addr, 0x1010n);
    assert.equal(results.complete, true);
    assert.equal(results.completeness, 'complete');
    assert.equal(results.reason, null);
  });

  await t.test('default search has a finite scan budget and reports unfinished work', async () => {
    let accessed = 0;
    const strings = Array.from({ length:50_000 }, () => ({ get text() { accessed++; return 'haystack'; } }));
    const { api:hex } = createApi({ stringIndex:strings }, () => {});
    const results = await hex.findStrings('needle');
    assert.ok(accessed > 0 && accessed <= 10_000);
    assert.equal(results.scanned, accessed);
    assert.equal(results.total, strings.length);
    assert.equal(results.complete, false);
    assert.equal(results.reason, 'scan-budget-exhausted');
  });

  await t.test('a timer can abort ordinary scan work before the next bounded chunk', async t => {
    let accessed = 0;
    const controller = new AbortController();
    const reason = new Error('timer-abort');
    const strings = Array.from({ length:50_000 }, () => ({ get text() { accessed++; return 'haystack'; } }));
    const { api:hex } = createApi({ stringIndex:strings }, () => {});
    const timer = setTimeout(() => controller.abort(reason), 0);
    t.after(() => clearTimeout(timer));
    await assert.rejects(async () => hex.findStrings('needle', { signal:controller.signal }), error => error === reason);
    assert.ok(accessed > 0 && accessed <= 256, `unbounded synchronous work: ${accessed}`);
  });
});
