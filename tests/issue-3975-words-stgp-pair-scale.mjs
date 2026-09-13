// Regression for #3975: Words.memoryAccess() claimed the whole load/store pair
// class with the broad 0x3a000000 mask, so the MTE `STGP` encoding
// (opc=01, VR=0, L=0) was decoded as an ordinary 32-bit integer STP pair:
// two 64-bit registers reported as 2x32-bit and the tag-granule-scaled
// immediate (16 bytes) shrunk to a 4-byte scale, fabricating a false exact
// data address/size for a valid instruction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'words.js'), 'utf8'), { filename: 'js/words.js' });
const { KIND, classifyWord, memoryAccess } = globalThis.Words;

// stgp x0, x1, [x2, #16] — 0x69008440.
{
  const mem = memoryAccess(0x69008440);
  assert.ok(mem, 'STGP must remain a decoded pair store');
  assert.equal(mem.load, false);
  assert.equal(mem.store, true);
  assert.equal(mem.pair, true);
  assert.equal(mem.vector, false);
  assert.equal(mem.elementSize, 8, 'STGP stores two 64-bit registers, not two 32-bit words');
  assert.equal(mem.size, 16, 'data footprint is 2 x 8 bytes');
  assert.equal(mem.disp, 16n, 'signed immediate scales by the 16-byte tag granule');
  assert.equal(mem.base, 2);
  assert.equal(mem.reg, 0);
  assert.equal(mem.reg2, 1);
  assert.equal(mem.mode, 'offset');
  assert.equal(classifyWord(0x69008440), KIND.STORE);
  // The allocation-tag write side effect must stay distinguishable from an
  // ordinary pair data store.
  assert.equal(mem.tag, true, 'STGP must carry allocation-tag store metadata');
}

// Pre/post-index forms share the STGP opc/VR/L matrix and keep the mode.
{
  const post = memoryAccess(0x68808440);
  assert.ok(post);
  assert.equal(post.store, true);
  assert.equal(post.elementSize, 8);
  assert.equal(post.disp, 16n);
  assert.equal(post.mode, 'post');
  const pre = memoryAccess(0x69808440);
  assert.ok(pre);
  assert.equal(pre.elementSize, 8);
  assert.equal(pre.disp, 16n);
  assert.equal(pre.mode, 'pre');
}

// Negative offset still scales by the tag granule: imm7 = -1 -> -16.
{
  const mem = memoryAccess(0x693f8440);
  assert.equal(mem.disp, -16n);
  assert.equal(mem.tag, true);
}

// Existing pair family semantics are preserved (acceptance 4-6).
{
  const wPair = memoryAccess(0x29008440); // stp w0, w1, [x2, #4]
  assert.equal(wPair.elementSize, 4);
  assert.equal(wPair.size, 8);
  assert.equal(wPair.disp, 4n);
  assert.notEqual(wPair.tag, true);

  const xPair = memoryAccess(0xa9008440); // stp x0, x1, [x2, #8]
  assert.equal(xPair.elementSize, 8);
  assert.equal(xPair.size, 16);
  assert.equal(xPair.disp, 8n);
  assert.notEqual(xPair.tag, true);

  const ldpsw = memoryAccess(0x69408440); // ldpsw x0, x1, [x2, #4]
  assert.equal(ldpsw.load, true);
  assert.equal(ldpsw.signed, true);
  assert.equal(ldpsw.signExtendTo, 8);
  assert.equal(ldpsw.elementSize, 4);
  assert.equal(ldpsw.size, 8);
  assert.equal(ldpsw.disp, 4n);
  assert.notEqual(ldpsw.tag, true);

  const qPair = memoryAccess(0xad400440); // ldp q0, q1, [x2]
  assert.equal(qPair.elementSize, 16);
  assert.equal(qPair.size, 32);
  assert.equal(qPair.vector, true);
  assert.notEqual(qPair.tag, true);

  const sPair = memoryAccess(0x2d008440); // stp s0, s1, [x2, #4]
  assert.equal(sPair.elementSize, 4);
  assert.equal(sPair.disp, 4n);
  assert.notEqual(sPair.tag, true);
}

// scanProgram blast radius: exact base provenance through adrp/add must
// follow the real tag-granule displacement, not the old 4x-shrunk one.
const TARGET = 0x1100n;
const STGP_TARGET = TARGET + 16n;
const STGP_FALSE_TARGET = TARGET + 4n;

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

async function scanHits(words, target) {
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
      fileOffset: 0n, vmAddr: 0x1000n, size: BigInt(__bytes.length),
      exec: true, zerofill: false,
    };
    regions = new Map([['code', __region]]);
    slices = [{ regions: [__region], functionStarts: [] }];
    currentEpoch = 0;
  `, context);
  const scan = await vm.runInContext(`scanProgram({ regionId:'code', requestId:null, epoch:0 })`, context);
  const scanCount = Number(scan.refCount ?? 0);
  const refs = Array.from((scan.refTo || []).subarray ? scan.refTo.subarray(0, scanCount) : (scan.refTo || []));
  return refs.filter((x) => BigInt(x) === target).length;
}

{
  const words = [
    0x90000002, // adrp x2, TARGET@PAGE
    0x91040042, // add x2, x2, #TARGET@PAGEOFF
    0x69008440, // stgp x0, x1, [x2, #16]
    0xd65f03c0, // ret
  ];
  assert.equal(await scanHits(words, STGP_TARGET), 1, 'scanProgram must record the STGP access at base+16');
  assert.equal(await scanHits(words, STGP_FALSE_TARGET), 0, 'scanProgram must not fabricate a base+4 store reference');
}

console.log('issue #3975 STGP pair decode regression passed');
