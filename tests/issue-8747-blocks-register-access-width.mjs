import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticModel } from '../js/blocks.js';
import { buildSemanticModel as buildBaseModel } from '../js/blocks-base.js';
import { buildIR } from '../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';

// #8747: a W-register write is a 32-bit truncation / zero-extension, but the
// public Semantic Model copied a tracked MOV value (imm/address) at the source's
// full width and ADRP+ADD completed an address without checking the destination
// width. Both published a concrete value / effective address at conf=1 that the
// narrower write cannot prove. The compat AAPCS64 IR likewise inherited 64-bit
// pointer provenance across `mov wD, xS`, must-aliasing the low-32 result with
// the original 64-bit pointer so MemorySSA forwarded a value from a store at a
// different real address. Expected concrete values are confirmed against the
// issue's own Unicorn 2.1.4 + LLVM 14.0.0 evidence.

function insnsOf(lines) {
  return lines.map((line, row) => {
    const p = line.indexOf(' ');
    return { row, address: 0x1000n + BigInt(row * 4), mn: p < 0 ? line : line.slice(0, p), ops: p < 0 ? '' : line.slice(p + 1) };
  });
}

function arg0Value(lines) {
  const model = buildSemanticModel(insnsOf(lines));
  const call = model.calls[0];
  assert.ok(call, 'model must observe the trailing call');
  const arg = call.args.find((a) => a.index === 0);
  assert.ok(arg, 'call must expose argument 0');
  return arg.value;
}

function compatLoad(lines) {
  const ir = buildIR(buildBaseModel(insnsOf(lines)));
  return ir.instructions.find((i) => i.op === 'load');
}

test('#8747 mov w0,w0 of a 64-bit constant zero-extends the tracked value, not the full constant', () => {
  // mov x0,#0x100000000; mov w0,w0 -> X0 = low32(0x100000000) = 0 (Unicorn/LLVM).
  const v = arg0Value(['mov x0, #0x100000000', 'mov w0, w0', 'bl #0x2000']);
  assert.equal(v.kind, 'imm');
  assert.equal(v.value, 0n, `W-write must drop the high32: got ${v.value}`);
});

test('#8747 same-width mov x0,x0 control keeps the full 64-bit constant', () => {
  const v = arg0Value(['mov x0, #0x100000000', 'mov x0, x0', 'bl #0x2000']);
  assert.equal(v.kind, 'imm');
  assert.equal(v.value, 4294967296n, 'full-width copy must preserve the whole value');
});

test('#8747 adrp+add into a W register masks the completed address to the write width', () => {
  // adrp x0,#0x100002000; add w0,w0,#4 -> X0 = 0x2004 (Unicorn), not 0x100002004.
  const pc = 0x100001000n;
  const model = buildSemanticModel([
    { row: 0, address: pc, mn: 'adrp', ops: 'x0, #0x100002000' },
    { row: 1, address: pc + 4n, mn: 'add', ops: 'w0, w0, #4' },
  ]);
  const ref = model.addressRefs[0];
  assert.ok(ref, 'adrp+add must record an address reference');
  assert.equal(ref.addr, 0x2004n, `W-write ADD must be masked: got 0x${ref.addr.toString(16)}`);
});

test('#8747 adrp+add into an X register control keeps the full address', () => {
  const pc = 0x100001000n;
  const model = buildSemanticModel([
    { row: 0, address: pc, mn: 'adrp', ops: 'x0, #0x100002000' },
    { row: 1, address: pc + 4n, mn: 'add', ops: 'x0, x0, #4' },
  ]);
  assert.equal(model.addressRefs[0].addr, 0x100002004n, 'full-width ADD completes the whole address');
});

test('#8747 compat IR must not must-alias a narrowing mov copy with its 64-bit source', () => {
  // mov w3,w0; ...; str w1,[x0,#4]; ldr w0,[x3,#4]: x3 is zero-extend_32(x0), a
  // different real address, so the load cannot be proven from the x0 store.
  const load = compatLoad(['mov w3, w0', 'mov w1, #1', 'str w1, [x0, #4]', 'ldr w0, [x3, #4]']);
  assert.ok(load, 'load must be present');
  assert.ok(load.dst.const == null, `narrow mov must not forward a concrete value: ${load.dst.const}`);
  assert.notEqual(load.loc.key, 'field:arg:x0+4:s4', 'narrow mov must not share the source pointer location key');
});

test('#8747 compat IR full-width mov copy control still forwards proven must-alias', () => {
  const load = compatLoad(['mov x3, x0', 'mov w1, #1', 'str w1, [x0, #4]', 'ldr w0, [x3, #4]']);
  assert.ok(load, 'load must be present');
  assert.equal(load.dst.const, 1n, 'a proven 64-bit copy keeps must-alias forwarding');
  assert.equal(load.loc.key, 'field:arg:x0+4:s4');
});
