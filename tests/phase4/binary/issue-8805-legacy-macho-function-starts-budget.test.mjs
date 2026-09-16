import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

// Issue #8805: LC_FUNCTION_STARTS encodes one valid delta per input byte
// (0x04 on ARM64), and parseFunctionStarts() eagerly materialized EVERY
// accepted delta as a BigInt. The worker's 8 MiB metadata read cap is an
// input ceiling, not a retention ceiling: a dense 4 MiB stream built ~4M
// BigInts and aborted a 128 MiB heap before any caller budget could observe
// it, and analyzeSlice() then copied/sorted it AGAIN. The fix charges an
// explicit decoded-start budget before each push, observes cancellation at
// bounded intervals, marks `truncated` (complete=false) instead of blessing
// a prefix as exact evidence, and consumes the strictly-increasing decode
// without the copy-resort chain.

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', '..');
const machoSrc = fs.readFileSync(path.join(root, 'js/macho.js'), 'utf8');
new Function('root', machoSrc)(globalThis);
const { parseFunctionStarts } = globalThis.MachO;

const BASE = 0x100000000n;
const EXEC_REGIONS = [{ exec: true, vmAddr: BASE, size: 0x100000000n }];
const dense = (n) => { const b = new Uint8Array(n + 1); b.fill(4, 0, n); b[n] = 0; return b; };

// --- dense flood stops at the declared retention ceiling, not the heap -----
{
  const list = parseFunctionStarts(dense(4_000_000), BASE, { architecture: 'arm64', regions: EXEC_REGIONS });
  assert.equal(list.length, 400_000, 'default retained-start ceiling bounds materialization');
  assert.equal(list.truncated, true, 'an over-budget decode must report truncation');
  assert.equal(list.truncationReason, 'result-limit');
  assert.equal(list.complete, false, 'a capped prefix is never blessed as exact evidence');
  assert.equal(list[0], BASE + 4n, 'retained starts keep exact addresses');
  assert.equal(list[399999], BASE + 400_000n * 4n, 'the retained prefix is monotone and complete up to the cut');
}

// --- the budget is per-item and charged BEFORE the (limit+1)th exists ------
{
  const list = parseFunctionStarts(dense(100), BASE, { architecture: 'arm64', regions: EXEC_REGIONS, maxStarts: 3 });
  assert.deepEqual([...list], [BASE + 4n, BASE + 8n, BASE + 12n]);
  assert.equal(list.truncated, true);
  assert.equal(list.truncationReason, 'result-limit');
  assert.equal(list.complete, false);
}
{
  const list = parseFunctionStarts(dense(3), BASE, { architecture: 'arm64', regions: EXEC_REGIONS, maxStarts: 0 });
  assert.equal(list.length, 0, 'a zero budget materializes nothing');
  assert.equal(list.truncated, true, 'but still reports that discovery was capped');
  assert.equal(list.complete, false);
}

// --- within-budget streams keep exact prior semantics ----------------------
{
  const list = parseFunctionStarts(dense(3), BASE, { architecture: 'arm64', regions: EXEC_REGIONS });
  assert.deepEqual([...list], [BASE + 4n, BASE + 8n, BASE + 12n]);
  assert.equal(list.complete, true, 'a normal small stream stays exact');
  assert.equal(list.truncated, false);
  assert.equal(list.malformed, false);
  assert.equal(list.rejected, 0);
}

// --- malformed / alignment / range rejections stay fail-closed -------------
{
  const truncatedUleb = new Uint8Array([4, 4, 0x80]); // continuation with no payload
  const list = parseFunctionStarts(truncatedUleb, BASE, { architecture: 'arm64', regions: EXEC_REGIONS });
  assert.equal(list.malformed, true);
  assert.equal(list.complete, false);
  assert.equal(list.truncated, true, 'malformed metadata now also marks the decode unusable');
  assert.equal(list.truncationReason, 'malformed');
}
{
  const list = parseFunctionStarts(dense(3), BASE, {
    architecture: 'arm64',
    regions: [{ exec: true, vmAddr: BASE, size: 8n }],   // admits only BASE+4
  });
  assert.deepEqual([...list], [BASE + 4n]);
  assert.equal(list.rejected, 2, 'out-of-range addresses are still rejected, not invented');
  assert.equal(list.complete, false);
}

// --- cancellation is observed at bounded latency ---------------------------
{
  let calls = 0;
  const list = parseFunctionStarts(dense(4_000_000), BASE, {
    architecture: 'arm64',
    regions: EXEC_REGIONS,
    shouldCancel: () => { calls++; return calls > 2; },
  });
  assert.equal(list.truncated, true);
  assert.equal(list.truncationReason, 'cancelled');
  assert.ok(list.length <= 192, `cancellation stops within a bounded window (got ${list.length})`);
}

// --- hostile dense stream survives a 64 MiB child heap (base aborts <128) --
{
  const child = spawnSync(process.execPath,
    ['--max-old-space-size=64', '-e', `
      const fs = require('node:fs');
      const src = fs.readFileSync(${JSON.stringify(path.join(root, 'js/macho.js'))}, 'utf8');
      new Function('root', src)(globalThis);
      const buf = new Uint8Array(4_000_001);
      buf.fill(4, 0, 4_000_000);
      buf[4_000_000] = 0;
      const base = 0x100000000n;
      const list = globalThis.MachO.parseFunctionStarts(buf, base, {
        architecture: 'arm64', regions: [{ exec: true, vmAddr: base, size: 0x100000000n }]
      });
      if (list.length !== 400_000 || !list.truncated || list.complete) {
        console.error('missing bounded stop'); process.exit(2);
      }
      process.exit(0);
    `], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  assert.equal(child.status, 0,
    `4M-entry dense stream must stop under a 64 MiB heap (exit=${child.status} err=${String(child.stderr).slice(0, 200)})`);
}

// --- worker analyzeSlice: capped discovery + no copy-resort duplication ----
{
  const vm = await import('node:vm');
  const context = vm.createContext({
    console, performance, URL, URLSearchParams, TextDecoder, TextEncoder, Blob,
    Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int32Array,
    BigUint64Array, BigInt64Array, DataView, ArrayBuffer, SharedArrayBuffer,
    BigInt, Map, Set, WeakMap, WeakSet, Promise, Object, Array, Math, Number,
    String, Boolean, RegExp, Error, TypeError, RangeError, JSON, Date,
    setTimeout, clearTimeout, Function, Symbol, Reflect, Proxy,
  });
  context.self = context;
  context.globalThis = context;
  context.postMessage = () => {};
  context.importScripts = () => {};
  for (const file of ['js/macho.js', 'js/words.js', 'js/worker-budget.js', 'js/worker-legacy.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  const runWorker = (stream, infoExtra) => {
    const FS_OFF = 0x400;
    const bytes = new Uint8Array(FS_OFF + stream.length);
    bytes.set(stream, FS_OFF);
    context.__bytes = bytes;
    context.__infoExtra = infoExtra;
    return vm.runInContext(`(async () => {
      blocks.clear();
      fileSize = BigInt(__bytes.length);
      file = { size: __bytes.length, slice(start, end) {
        const copy = __bytes.slice(Number(start), Number(end));
        return { arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) };
      } };
      regions = new Map();
      slices = [{ regions: [{ exec: true, vmAddr: 0x100000000n, size: 0x100000000n }], functionStarts: [], offset: 0n, info: Object.assign({
        is64: true, architecture: 'arm64', textVM: 0x100000000n,
        functionStarts: { dataoff: ${FS_OFF}, datasize: __bytes.length - ${FS_OFF} },
      }, __infoExtra) }];
      currentEpoch = 0;
      return analyzeSlice({ sliceIndex: 0, id: null });
    })()`, context);
  };

  {
    const result = await runWorker(dense(450_000), { entry: 0x100000000n + 2n * 4n });
    assert.equal(result.functionDiscovery.capped, true, 'over-budget decode reports capped discovery (#8805)');
    assert.equal(result.functionDiscovery.complete, false);
    assert.deepEqual([...result.functionDiscovery.reasons], ['no-complete-lc-function-starts', 'function-starts:result-limit']);
    assert.equal(result.capped, true, 'the slice result itself must not hide the cut');
    assert.equal(result.functionStartsExact, false);
    assert.equal(result.funcs.length, 400_000, 'retention ceiling holds inside the worker, entry seed already included');
  }
  {
    const result = await runWorker(dense(293_794), { entry: 0x100000000n + 500_000n * 4n });
    assert.equal(result.functionDiscovery.capped, false, 'real YWP-scale function starts stay within the safe retention ceiling');
    assert.equal(result.functionDiscovery.complete, true);
    assert.equal(result.capped, false);
    assert.ok(result.functionStartsExact, '293,794 authoritative starts remain exact');
    assert.equal(result.funcs.length, 293_795, 'entry seed merges without forcing a retention cap');
  }
  {
    const result = await runWorker(dense(3), { entry: 0x100000000n + 1000n });
    assert.equal(result.functionDiscovery.capped, false);
    assert.equal(result.functionDiscovery.complete, true);
    assert.equal(result.capped, false);
    assert.ok(result.functionStartsExact, 'a small exact stream keeps exact discovery');
    assert.equal(result.funcs.length, 4, 'entry seed merges with the three decoded starts');
    for (let i = 1; i < result.funcs.length; i++) {
      assert.ok(result.funcs[i - 1] < result.funcs[i], 'seeds stay strictly ordered after merge');
    }
    assert.ok([...result.funcs].includes(1000n + 0x100000000n), 'entry seed present without duplication');
  }
  {
    const result = await runWorker(dense(3), { entry: 0x100000000n + 4n });
    assert.equal(result.funcs.filter((v) => v === 0x100000004n).length, 1, 'entry already inside the stream is not duplicated');
  }
}

console.log('issue #8805 legacy Mach-O function-starts retention budget: PASS');
