import assert from 'node:assert/strict';
import { lowerArm64RawAssembly } from '../js/decompiler/arm64-extra-semantics.js';

console.log('Testing #6207: FCSEL/FCCMP lower only canonical A64 conditions.');

function rawResult(text) {
  return { lines: [{ text, indent: 0 }] };
}

// 1. Unknown two-letter conditions never lower and keep the raw __asm.
for (const cond of ['zz', 'xy', 'aa', 'qq', 'ee']) {
  const fcsel = lowerArm64RawAssembly(rawResult(`__asm("fcsel d0, d1, d2, ${cond}");`));
  assert.equal(fcsel.lines[0].text, `__asm("fcsel d0, d1, d2, ${cond}");`);
  assert.equal(fcsel.lines[0].note, undefined);

  const fccmp = lowerArm64RawAssembly(rawResult(`__asm("fccmp d0, d1, #0, ${cond}");`));
  assert.equal(fccmp.lines[0].text, `__asm("fccmp d0, d1, #0, ${cond}");`);
  assert.equal(fccmp.lines[0].note, undefined);
}

// 2. Unknown conditions never receive the exact semantics note.
const noted = lowerArm64RawAssembly(rawResult('__asm("fcsel d0, d1, d2, zz");'));
assert.notEqual(noted.lines[0].text?.includes('__a64_cond_zz'), true);

// 3. Canonical conditions keep their existing exact lowerings.
const fcselEq = lowerArm64RawAssembly(rawResult('__asm("fcsel d0, d1, d2, eq");'));
assert.equal(fcselEq.lines[0].text, 'd0 = __a64_cond_eq() ? d1 : d2;');
assert.equal(fcselEq.lines[0].note, 'Exact ARM64 instruction semantics lowered from the raw fallback.');

const fcselHs = lowerArm64RawAssembly(rawResult('__asm("fcsel s0, s1, s2, hs");'));
assert.equal(fcselHs.lines[0].text, 's0 = __a64_cond_hs() ? s1 : s2;');

const fcselCs = lowerArm64RawAssembly(rawResult('__asm("fcsel s0, s1, s2, cs");'));
assert.equal(fcselCs.lines[0].text, 's0 = __a64_cond_cs() ? s1 : s2;');

const fccmpLe = lowerArm64RawAssembly(rawResult('__asm("fccmp d0, d1, #0, le");'));
assert.equal(fccmpLe.lines[0].text, '__a64_fccmp(d0, d1, 0, "le");');

const fccmpLo = lowerArm64RawAssembly(rawResult('__asm("fccmp d0, d1, #15, lo");'));
assert.equal(fccmpLo.lines[0].text, '__a64_fccmp(d0, d1, 15, "lo");');

// 4. al/nv are architecturally unconditional and never become a predicate.
const fcselAl = lowerArm64RawAssembly(rawResult('__asm("fcsel d0, d1, d2, al");'));
assert.equal(fcselAl.lines[0].text, '__asm("fcsel d0, d1, d2, al");');

const fccmpNv = lowerArm64RawAssembly(rawResult('__asm("fccmp d0, d1, #0, nv");'));
assert.equal(fccmpNv.lines[0].text, '__asm("fccmp d0, d1, #0, nv");');

// 5. Case-insensitive canonical conditions still canonicalize.
const fcselMixed = lowerArm64RawAssembly(rawResult('__asm("fcsel d0, d1, d2, GT");'));
assert.equal(fcselMixed.lines[0].text, 'd0 = __a64_cond_gt() ? d1 : d2;');

// 6. Other unknown instructions remain untouched.
const rev = lowerArm64RawAssembly(rawResult('__asm("rev x0, x1");'));
assert.equal(rev.lines[0].text, 'x0 = __builtin_bswap64(x1);');

console.log('#6207: All tests passed successfully.');
