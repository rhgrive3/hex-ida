// Regression for #5872: the worker xref target is an address identity.
// Structured values must never reach BigInt()'s ToPrimitive — a malformed
// request is rejected fail-closed instead of aliasing a canonical address.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ADRP_X8 = 0x90000008;
const NOP = 0xd503201f;
const ADD_X9_X8_100 = 0x91040109;

async function xrefsRaw(targetLiteral) {
  const context = vm.createContext({
    console, TextDecoder, TextEncoder, Uint8Array, Uint8ClampedArray, Uint16Array,
    Uint32Array, Int32Array, BigUint64Array, BigInt64Array, DataView, ArrayBuffer,
    BigInt, Map, Set, WeakMap, WeakSet, Promise, Object, Array, Math, Number,
    String, Boolean, RegExp, Error, TypeError, RangeError, JSON, Date,
    setTimeout, clearTimeout,
  });
  context.self = context;
  context.globalThis = context;
  context.self.postMessage = () => {};
  context.importScripts = () => {};
  for (const file of [
    'js/macho.js', 'js/words.js', 'js/worker-budget.js', 'js/address-provenance.js',
    'js/worker-legacy.js', 'js/worker-fixes.js', 'js/worker-xref-target-identity-fix.js',
    'js/worker-xref-memory-fix.js', 'js/worker-loop-provenance-fix.js',
    'js/worker-loop-unconditional-fix.js',
  ]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  const bytes = new Uint8Array(3 * 4);
  const dv = new DataView(bytes.buffer);
  for (const [index, word] of [ADRP_X8, NOP, ADD_X9_X8_100].entries()) dv.setUint32(index * 4, word >>> 0, true);
  context.__bytes = bytes;
  vm.runInContext(`
    blocks.clear();
    fileSize = BigInt(__bytes.length);
    file = {
      size: __bytes.length,
      slice(start, end) {
        const copy = __bytes.slice(Number(start), Number(end));
        return { arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) };
      },
    };
    const region = {
      id: 'code', kind: 'section', name: '__text', section: '__text',
      fileOffset: 0n, vmAddr: 0x1000n, size: BigInt(__bytes.length),
      exec: true, zerofill: false,
    };
    regions = new Map([['code', region]]);
    slices = [{ regions: [region], functionStarts: [] }];
    currentEpoch = 0;
  `, context);
  return vm.runInContext(`findXrefs({ regionId:'code', target: (${targetLiteral}), limit:100, requestId:null, epoch:0 })`, context);
}

// Canonical primitive identities keep returning the existing xref evidence.
const canonical = await xrefsRaw('0x1100n');
assert.equal(canonical.results.length, 1, 'canonical bigint target keeps its xref');
assert.equal(canonical.cancelled, false);
const numeric = await xrefsRaw('0x1100');
assert.equal(numeric.results.length, 1, 'non-negative safe integer target keeps its xref');
const decimalString = await xrefsRaw("'4352'");
assert.equal(decimalString.results.length, 1, 'canonical decimal numeric string target keeps its xref');

// Structured / malformed targets are rejected instead of aliasing the address.
for (const [label, literal] of [
  ['array of digits', "['4352']"],
  ['array of hex', "['0x1100']"],
  ['object with toString', "({ toString() { return '4352'; } })"],
  ['boolean', 'true'],
  ['fraction', '4352.5'],
  ['negative number', '-1'],
  ['negative bigint', '-1n'],
  ['negative zero number', '-0'],
  ['negative zero string', "'-0'"],
  ['hex string', "'0x1100'"],
  ['empty string', "''"],
  ['null', 'null'],
]) {
  await assert.rejects(
    () => xrefsRaw(literal),
    /Invalid xref target/,
    `${label} target must not produce xref evidence`,
  );
}

console.log('issue #5872 xref target identity: PASS');
