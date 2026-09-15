import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticModel } from '../js/blocks.js';

// #8763: the public Semantic Model stack cache keyed a whole value object by
// 'sp+off' and forwarded it on any reload that touched the same slot, so a
// narrower load (ldrb of a wider store) or a later overlapping partial store
// published a stale concrete argument value at conf=1. The real call argument
// for both counterexamples is 0 (confirmed against the issue's own Unicorn
// 2.1.4 + LLVM 14.0.0 evidence), not the false 256.

function arg0Value(lines) {
  const insns = lines.map((line, row) => {
    const p = line.indexOf(' ');
    return { row, address: 0x1000n + BigInt(row * 4), mn: line.slice(0, p), ops: line.slice(p + 1) };
  });
  const model = buildSemanticModel(insns);
  const call = model.calls[0];
  assert.ok(call, 'model must observe the trailing call');
  const arg = call.args.find((a) => a.index === 0);
  assert.ok(arg, 'call must expose argument 0');
  return arg.value;
}

test('#8763 narrow load of a wider constant store is byte-exact, not the stale whole value', () => {
  // mov x0,#0x100; str x0,[sp,#0]; ldrb w0,[sp,#0]; bl -> X0 = low byte of 0x100 = 0.
  const v = arg0Value(['mov x0, #0x100', 'str x0, [sp, #0]', 'ldrb w0, [sp, #0]', 'bl #0x2000']);
  assert.equal(v.kind, 'imm', `narrow reload of a fully-known byte must stay concrete: kind=0024{v.kind} value=0024{String(v.value)}`);
  assert.equal(v.value, 0n, `ldrb must forward the single proven byte (0), not 0x100: ${v.value}`);
});

test('#8763 overlapping narrower store invalidates the stale cached concrete value', () => {
  // mov w0,#0x100; str w0,[sp,#0]; mov w0,#0; strb w0,[sp,#1]; ldr w0,[sp,#0] -> 0x00000000.
  const v = arg0Value([
    'mov w0, #0x100', 'str w0, [sp, #0]', 'mov w0, #0', 'strb w0, [sp, #1]', 'ldr w0, [sp, #0]', 'bl #0x2000',
  ]);
  assert.equal(v.kind, 'imm');
  assert.equal(v.value, 0n, `byte 1 was overwritten with 0, so the 32-bit reload must be 0, not 256: ${v.value}`);
});

test('#8763 same-width reload control keeps the concrete stored value', () => {
  const v = arg0Value(['mov x0, #0x100', 'str x0, [sp, #0]', 'ldr x0, [sp, #0]', 'bl #0x2000']);
  assert.equal(v.kind, 'imm');
  assert.equal(v.value, 256n, 'same-width STR->LDR reload remains 0x100');
});

test('#8763 non-overlapping narrower store does not disturb a wider reload', () => {
  // strb to [sp,#4] is outside the [sp,#0..3] range the ldr w0 reads.
  const v = arg0Value([
    'mov w0, #0x100', 'str w0, [sp, #0]', 'mov w0, #0', 'strb w0, [sp, #4]', 'ldr w0, [sp, #0]', 'bl #0x2000',
  ]);
  assert.equal(v.kind, 'imm');
  assert.equal(v.value, 256n, 'a store outside the loaded range must not change the reload');
});

test('#8763 signed narrow load sign-extends the proven byte', () => {
  const v = arg0Value(['mov x0, #0xff', 'str x0, [sp, #0]', 'ldrsb w0, [sp, #0]', 'bl #0x2000']);
  assert.equal(v.kind, 'imm');
  assert.equal(v.value, -1n, 'ldrsb of byte 0xff must be -1, not 255 and not the stale 0xff slot');
});

test('#8763 reload of a slot last written by a non-constant value stays uncertain', () => {
  // ldr x1,[x2] writes a non-constant loaded value; str x1,[sp,#0]; then a narrow
  // reload must not fabricate a concrete integer.
  const v = arg0Value(['ldr x1, [x2]', 'str x1, [sp, #0]', 'ldrb w0, [sp, #0]', 'bl #0x2000']);
  assert.notEqual(v.kind, 'imm', `unproven stack byte must not publish a concrete value: kind=0024{v.kind} value=0024{String(v.value)}`);
  assert.ok(v.conf < 1, `unproven reload confidence must be below confirmed: ${v.conf}`);
});
