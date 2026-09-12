import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyMicrosoftVectorcallArguments } from '../../../js/targets/abi/microsoft-vectorcall.js';

/* x64 __vectorcall outgoing-argument layout (#6003): every argument position
 * occupies a fixed 8-byte slot at 8·p from the caller stack before the call.
 * Register consumers of positions 4/5 leave their shadow slots in place —
 * stack arguments continue from the fifth position's slot (32) and are never
 * compacted. Verified against clang 17 -target x86_64-pc-windows-msvc
 * (seventh argument emitted at rsp+48) and Microsoft Learn "__vectorcall". */

const vector = (bits) => ({ type:bits === 256 ? '__m128' : '__m128', vector:true, bits });
const int = () => ({ type:'int', bits:32 });
const flt = () => ({ type:'float', floating:true, bits:32 });

test('#6003 the seventh argument follows the positional layout, not the compacted one', () => {
  const result = classifyMicrosoftVectorcallArguments({ callPrototype:{
    callingConvention:'vectorcall',
    args:[vector(128), vector(128), vector(128), vector(128), vector(128), vector(128), int()],
  } });
  const g = result.arguments[6];
  assert.equal(g.location, 'stack');
  assert.equal(g.offsetBase, 'caller-stack-before-call');
  assert.equal(g.offset, 48, 'positions 4/5 keep 8-byte shadow slots');
  assert.equal(g.calleeEntryOffset, 56);
});

test('#6003 a register vector at position 5 still reserves its shadow slot', () => {
  const result = classifyMicrosoftVectorcallArguments({ callPrototype:{
    callingConvention:'vectorcall',
    args:[int(), int(), int(), int(), int(), vector(128), int()],
  } });
  assert.equal(result.arguments[4].offset, 32);
  assert.equal(result.arguments[5].reg, 'xmm5');
  assert.equal(result.arguments[6].offset, 48, 'position 5 shadow slot is never skipped');
});

test('#6003 Microsoft Learn example 2 places g at 48', () => {
  const result = classifyMicrosoftVectorcallArguments({ callPrototype:{
    callingConvention:'vectorcall',
    args:[int(), vector(128), int(), vector(128), vector(256), flt(), int()],
  } });
  assert.equal(result.arguments[6].offset, 48);
});

test('#6003 stack arguments at consecutive positions keep contiguous slots', () => {
  const result = classifyMicrosoftVectorcallArguments({ callPrototype:{
    callingConvention:'vectorcall',
    args:[int(), int(), int(), int(), int(), int(), int(), int()],
  } });
  assert.deepEqual(result.arguments.slice(4).map((entry) => entry.offset), [32, 40, 48, 56]);
});
