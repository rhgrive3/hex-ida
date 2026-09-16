import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VM_BASE = 0x1000n;
const NOP = 0xd503201f;

function adr64(imm, rd) {
  const encoded = BigInt.asUintN(21, BigInt(imm));
  const immlo = encoded & 0x3n;
  const immhi = (encoded >> 2n) & 0x7ffffn;
  return Number((0x10000000n | (immlo << 29n) | (immhi << 5n) | BigInt(rd & 0x1f)));
}

function adrp64(immPages, rd) {
  const encoded = BigInt.asUintN(21, BigInt(immPages));
  const immlo = encoded & 0x3n;
  const immhi = (encoded >> 2n) & 0x7ffffn;
  return Number((0x90000000n | (immlo << 29n) | (immhi << 5n) | BigInt(rd & 0x1f)));
}

function addImm(rd, rn, imm12) {
  return Number(0x91000000n | (BigInt(imm12 & 0xfff) << 10n) | (BigInt(rn & 0x1f) << 5n) | BigInt(rd & 0x1f));
}

function bytesOf(words) {
  const bytes = new Uint8Array(words.length * 4);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < words.length; i++) dv.setUint32(i * 4, words[i] >>> 0, true);
  return bytes;
}

function loadWorker() {
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
  for (const file of ['js/macho.js', 'js/words.js', 'js/worker-budget.js', 'js/address-provenance.js', 'js/worker-legacy.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  return context;
}

async function scan(words) {
  const context = loadWorker();
  context.__bytes = bytesOf(words);
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
    const __region = {
      id: 'code', kind: 'section', name: '__text', section: '__text',
      fileOffset: 0n, vmAddr: ${VM_BASE}n, size: BigInt(__bytes.length),
      exec: true, zerofill: false,
    };
    regions = new Map([['code', __region]]);
    slices = [{ regions: [__region], functionStarts: [] }];
    currentEpoch = 0;
  `, context);
  const scan = await vm.runInContext(`scanProgram({ regionId:'code', requestId:null, epoch:0 })`, context);
  const refs = await vm.runInContext(`findXrefs({ regionId:'code', target:0n, limit:100, requestId:null, epoch:0 })`, context);
  const n = Number(scan.refCount);
  const entries = [];
  for (let i = 0; i < n; i++) entries.push({ site: BigInt(scan.refFrom[i]), target: BigInt(scan.refTo[i]), kind: scan.refKind[i] });
  assert.equal(scan.cancelled, false, 'scanProgram unexpectedly cancelled');
  return {
    entries,
    refCount: n,
    zeroRefs: entries.filter((e) => e.target === 0n),
    xrefDataHits: refs.results.filter((r) => r.kind !== 'branch').length,
  };
}

const adrToZero = await scan([adr64(-0x1000, 8), NOP]);
assert.equal(adrToZero.zeroRefs.length, 1, '#3943 ADR to address 0 must publish one ProgramIndex ref');
assert.equal(adrToZero.zeroRefs[0].site, VM_BASE, '#3943 ADR zero ref site');
assert.equal(adrToZero.zeroRefs[0].kind, 0, '#3943 ADR zero ref kind');
assert.equal(adrToZero.xrefDataHits, 1, '#3943 findXrefs/ProgramIndex zero-address contract split');

const pairToZero = await scan([adrp64(-1, 8), addImm(0, 8, 0), NOP]);
assert.equal(pairToZero.zeroRefs.length, 1, '#3943 ADRP+ADD provenance resolving to 0 must publish one ProgramIndex ref');
assert.equal(pairToZero.zeroRefs[0].site, VM_BASE + 4n, '#3943 ADRP+ADD zero ref site');
assert.equal(pairToZero.xrefDataHits, 1, '#3943 findXrefs/ProgramIndex ADRP+ADD zero contract split');

const positiveControl = await scan([adr64(0x20, 8), NOP]);
assert.equal(positiveControl.entries.length, 1, '#3943 positive address refs must be unchanged');
assert.equal(positiveControl.entries[0].target, VM_BASE + 0x20n, '#3943 positive ref target');
assert.equal(positiveControl.zeroRefs.length, 0, '#3943 positive ref must not alias zero');

const noRefs = await scan([NOP, NOP, NOP]);
assert.equal(noRefs.refCount, 0, '#3943 absent targets must not become refs');
assert.equal(noRefs.zeroRefs.length, 0, '#3943 zero-padded ref storage must not be published');

console.log('issue #3943 scanProgram addRef zero address: PASS');
