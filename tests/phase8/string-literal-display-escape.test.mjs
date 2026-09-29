import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture as irFixture } from './helpers/ir-fixtures.mjs';
import { renderValue } from '../../js/decompiler/semantic-core.js';

// String text reaches the decompiler in the string scanner's display form:
// tab, CR and LF are already written as \t, \r and \n (js/worker-legacy.js).
// Re-escaping that form with JSON.stringify doubled the backslash, so a
// `printf("%d\n")` argument rendered as "%d\\n" in the pseudocode.
function addressString(text, via) {
  const f = irFixture('string_literal_display_escape');
  f.block(0);
  const value = f.constant(0x2000n, 64);
  value.def.op = 'addr';
  f.ret();
  const ir = f.build();
  ir.instructions = ir.blocks.flatMap((block) => [...block.phis, ...block.insts]);
  ir.instructions.forEach((inst, index) => { inst.id = 9100 + index; inst.row = index; inst.address = 0x9100n + BigInt(index * 4); });
  ir.blocks[0].startRow = 0;
  ir.blocks[0].endRow = ir.instructions.length - 1;
  const opts = { defaultCallArgs:0, deterministicTransforms:true, ir };
  const model = { name:'string_literal_display_escape', instructions:ir.instructions, calls:[] };
  if (via === 'resolver') opts.stringFor = () => text;
  else model.addressRefs = [{ row:value.def.row, addr:0x2000n, text }];
  const ctx = { ir, model, opts, types:{ values:new Map(), locations:new Map() }, runtime:{},
    exprCache:new Map(), exprActive:new Set(), exprNodes:0, materialNames:new Map(), callCache:new Map(), unknownCallArities:0 };
  return renderValue(value, ctx);
}

for (const via of ['resolver', 'address-ref']) {
  test(`display-escaped string text keeps single escapes (${via})`, () => {
    assert.equal(addressString('damage dealt to enemy: %d\\n', via), '"damage dealt to enemy: %d\\n"');
    assert.equal(addressString('a\\tb\\r\\n', via), '"a\\tb\\r\\n"');
  });

  test(`quotes and raw control characters are still escaped (${via})`, () => {
    assert.equal(addressString('say "hi"', via), '"say \\"hi\\""');
    assert.equal(addressString('real\nnewline', via), '"real\\nnewline"');
  });
}
