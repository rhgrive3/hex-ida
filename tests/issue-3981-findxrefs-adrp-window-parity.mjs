// Regression for #3981: findXrefsLoopSafe must not re-introduce the old
// fixed 8-instruction ADRP window that scanProgram already replaced with
// the unbounded PAIR_WINDOW policy. Straight-line chains survive until a
// clobber/control boundary; loop-merge fail-closed semantics are preserved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = 0x1100n;

const ADRP_X8 = 0x90000008;
const ADRP_X19 = 0x90000013;
const NOP = 0xd503201f;
const RET = 0xd65f03c0;
const MOVZ_X8_0 = 0xd2800008;
const LDR_X0_X8_100 = 0xf9408100;
const LDR_X0_X19_100 = 0xf9408260;
const ADD_X0_X8_100 = 0x91040100;
const CBZ_X0_FWD = 0xb4000060;

function bl(fromIndex, toIndex) { return (0x94000000 | ((toIndex - fromIndex) & 0x03ffffff)) >>> 0; }
function b(fromIndex, toIndex) { return (0x14000000 | ((toIndex - fromIndex) & 0x03ffffff)) >>> 0; }
function cbzX0(fromIndex, toIndex) { return (0xb4000000 | (((toIndex - fromIndex) & 0x7ffff) << 5)) >>> 0; }
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
  for (const file of [
    'js/macho.js', 'js/words.js', 'js/worker-budget.js', 'js/address-provenance.js',
    'js/worker-legacy.js', 'js/worker-fixes.js', 'js/worker-xref-target-identity-fix.js',
    'js/worker-xref-memory-fix.js', 'js/worker-loop-provenance-fix.js',
    'js/worker-loop-unconditional-fix.js',
  ]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  return context;
}

async function runFixture(words, { starts = [] } = {}) {
  const context = loadWorker();
  context.__bytes = bytesOf(words);
  context.__starts = starts;
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
    slices = [{ regions: [__region], functionStarts: Array.from(__starts, (x) => BigInt(x)) }];
    currentEpoch = 0;
  `, context);
  const scan = await vm.runInContext(`scanProgram({ regionId:'code', requestId:null, epoch:0 })`, context);
  const xrefs = await vm.runInContext(`findXrefs({ regionId:'code', target:0x1100n, limit:100, requestId:null, epoch:0 })`, context);
  const scanCount = Number(scan.refCount ?? 0);
  const scanHits = Array.from(scan.refTo.subarray(0, scanCount)).filter((x) => BigInt(x) === TARGET).length;
  const xrefHits = (xrefs.results || []).filter((x) => x.kind !== 'branch').length;
  assert.equal(scan.cancelled, false);
  assert.equal(xrefs.cancelled, false);
  return { scanHits, xrefHits };
}

async function expectBoth(label, words, want, options) {
  const { scanHits, xrefHits } = await runFixture(words, options);
  assert.equal(xrefHits, want, `${label}: findXrefs target refs`);
  assert.equal(scanHits, want, `${label}: scanProgram cross-check must agree with findXrefs`);
}

// Acceptance 1/6: ADRP -> ADD at distances beyond the old fixed 8 window.
for (const gap of [9, 16, 64]) {
  await expectBoth(`ADRP+ADD ${gap} nops apart`, [ADRP_X8, ...Array(gap).fill(NOP), ADD_X0_X8_100], 1);
}

// Acceptance 2/6: ADRP -> scalar load at long straight-line distance.
for (const gap of [9, 16, 64]) {
  await expectBoth(`ADRP+LDR ${gap} nops apart`, [ADRP_X8, ...Array(gap).fill(NOP), LDR_X0_X8_100], 1);
}

// Acceptance 3: an intervening clobber of the base still kills the chain.
await expectBoth('base clobber after ADRP', [ADRP_X8, MOVZ_X8_0, ...Array(9).fill(NOP), LDR_X0_X8_100], 0);

// Acceptance 5: control-boundary fail-closed contracts remain.
await expectBoth('RET boundary', [ADRP_X8, RET, LDR_X0_X8_100], 0);
await expectBoth('call clears provenance', [ADRP_X8, bl(1, 3), LDR_X0_X8_100, RET], 0);
await expectBoth('unconditional branch no fallthrough', [ADRP_X8, b(1, 3), LDR_X0_X8_100, NOP], 0);

// Acceptance 7: #1900/#2117 loop-merge fail-closed still holds (base is
// redefined inside the loop body across the backward edge).
await expectBoth(
  'backward loop clobbers base',
  [ADRP_X8, cbzX0(1, 3), MOVZ_X8_0, LDR_X0_X8_100],
  0,
);

// Conditional-branch fail-closed is stricter on the direct xref path by
// existing design (#289); assert that contract is untouched.
{
  const { xrefHits } = await runFixture([ADRP_X8, cbzX0(1, 3), LDR_X0_X8_100, NOP]);
  assert.equal(xrefHits, 0, 'conditional branch keeps clearing direct-xref provenance');
}
{
  const { xrefHits } = await runFixture([ADRP_X8, CBZ_X0_FWD, NOP, LDR_X0_X8_100]);
  assert.equal(xrefHits, 0, 'forward conditional branch keeps clearing direct-xref provenance');
}
await expectBoth(
  'long straight-line callee-saved chain',
  [ADRP_X19, ...Array(20).fill(NOP), LDR_X0_X19_100],
  1,
);

console.log('issue #3981 findXrefs ADRP window parity: PASS');
