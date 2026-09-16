import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = 0x1100n;

const ADRP_X0 = 0x90000000;   // adrp x0, page(== region base 0x1000)
const ADD_X9_X0_0x100 = 0x91040009; // add x9, x0, #256  -> 0x1100
const PRFM_PLDL1KEEP_X8 = 0xf9800100; // prfm pldl1keep,[x8]  prfop=0 (== x0)
const PRFM_PLDL3STRM_X8 = 0xf9800105; // prfm pldl3strm,[x8]  prfop=5 (== x5)
const PRFM_LITERAL_PLDL1KEEP = 0xd8000020; // prfm pldl1keep, +0x100  prfop=0
const LDR_X1_X9 = 0xf9400121; // ldr x1, [x9]   -> reference to 0x1100
const LDR_X0_X8 = 0xf9400100; // ldr x0, [x8]   real GP load, must kill x0
const RET = 0xd65f03c0;

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
async function hits(words) {
  const context = loadWorker();
  context.__bytes = bytesOf(words);
  vm.runInContext(`
    blocks.clear();
    fileSize = BigInt(__bytes.length);
    file = { size: __bytes.length, slice(a, b) { const c = __bytes.slice(Number(a), Number(b)); return { arrayBuffer: async () => c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength) }; } };
    const r = { id:'code', kind:'section', name:'__text', section:'__text', fileOffset:0n, vmAddr:0x1000n, size:BigInt(__bytes.length), exec:true, zerofill:false };
    regions = new Map([['code', r]]);
    slices = [{ regions:[r], functionStarts:[0x1000n] }];
    currentEpoch = 0;
  `, context);
  await vm.runInContext(`scanProgram({ regionId:'code', requestId:null, epoch:0 })`, context);
  const xrefs = await vm.runInContext(`findXrefs({ regionId:'code', target:0x1100n, limit:100, requestId:null, epoch:0 })`, context);
  return (xrefs.results || []).filter((x) => x.kind !== 'branch').length;
}

let failed = 0;
async function expect(label, words, want) {
  const got = await hits(words);
  if (got !== want) { failed++; console.log(`  FAIL ${label}: got ${got}, want ${want}`); }
  else console.log(`  ok   ${label}: ${got}`);
}

// #1/#3: PRFM (immediate) with prfop==0 must not kill x0's ADRP provenance.
await expect('prfm prfop=0 preserves x0 chain', [ADRP_X0, PRFM_PLDL1KEEP_X8, ADD_X9_X0_0x100, LDR_X1_X9], 2);
// #2: a different prfop must not kill its numbered GP either (here x0 is unaffected by prfop=5).
await expect('prfm prfop=5 preserves x0 chain', [ADRP_X0, PRFM_PLDL3STRM_X8, ADD_X9_X0_0x100, LDR_X1_X9], 2);
// literal-PRFM audit: prfop==0 must not kill x0 via the KIND.LITERAL path.
await expect('prfm literal prfop=0 preserves x0 chain', [ADRP_X0, PRFM_LITERAL_PLDL1KEEP, ADD_X9_X0_0x100, LDR_X1_X9], 2);
// #4: a real ldr x0,[x8] must still kill x0, dropping the chain.
await expect('real ldr x0 still kills x0', [ADRP_X0, LDR_X0_X8, ADD_X9_X0_0x100, LDR_X1_X9], 0);

if (failed > 0) { console.error(`issue #3955 scanProgram PRFM provenance FAILED (${failed})`); process.exit(1); }
console.log('issue #3955 scanProgram PRFM provenance passed');
