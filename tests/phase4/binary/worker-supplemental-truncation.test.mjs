import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import url from 'node:url';
import test from 'node:test';

test('worker analyzeSlice marks capped: true when supplemental objc stub recovery is truncated by budget', async () => {
  const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', '..');

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

  for (const file of ['js/macho.js', 'js/words.js', 'js/worker-budget.js', 'js/objc-stub-recovery.js', 'js/worker-legacy.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }

  // Hook HexObjCStubRecovery to simulate returning a truncated list
  vm.runInContext(`
    globalThis.HexObjCStubRecovery = {
      recover: async function(opts) {
        const out = [];
        out.truncated = true;
        out.truncationReason = 'supplemental-budget-exhausted';
        return out;
      }
    };
  `, context);

  const bytes = new Uint8Array(0x200);
  const result = await vm.runInContext(`(async () => {
    blocks.clear();
    fileSize = BigInt(${bytes.length});
    file = { size: ${bytes.length}, slice(start, end) {
      const copy = new Uint8Array(${bytes.buffer.byteLength}).slice(Number(start), Number(end));
      return { arrayBuffer: async () => copy.buffer };
    } };
    regions = new Map();
    slices = [{ regions: [], functionStarts: [], info: {
      is64: true, magic64: true, ncmds: 1,
      symtab: { nsyms: 0, symoff: 0x100, stroff: 0x140, strsize: 0 },
    }, offset: 0n }];
    currentEpoch = 0;
    return analyzeSlice({ sliceIndex: 0, id: null });
  })()`, context);

  assert.equal(result.capped, true, 'truncated supplemental objc recovery must set worker capped to true');
});
