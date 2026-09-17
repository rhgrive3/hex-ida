import assert from 'node:assert/strict';
import test from 'node:test';
import { decompileSemantic } from '../../../js/decompiler/semantic-core.js';
import { fixture } from '../helpers/ir-fixtures.mjs';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { decompileEntry } from '../../../tools/validation/phase8/decompile-corpus.mjs';

test('an opaque statement retains its input dependencies, not unrelated nearby definitions', () => {
  const f = fixture('opaque_input_source'); f.block(0);
  const input = f.opaque(64);
  const offset = f.constant(7n, 64);
  const target = f.binary('add', input, offset, 64);
  const unrelated = f.constant(99n, 64);
  const unknown = f.unknown(64).def;
  unknown.text = 'unresolved operation';
  unknown.args = [{ value:target }, { value:target }];
  target.uses.push(unknown);
  f.ret();
  const ir = f.build();
  ir.instructions = ir.blocks.flatMap(block => block.insts);
  ir.instructions.forEach((inst, index) => {
    inst.id = index; inst.address = 0x1000n + BigInt(index * 4);
  });
  const model = { name:ir.name, instructions:ir.instructions, calls:[] };
  const result = decompileSemantic(model, { ir, returnType:'void', returnsValue:false });
  const line = result.lines.find(item => item.text.includes('unresolved operation'));
  assert.ok(line, 'the unresolved instruction must remain visible');
  for (const definition of [offset.def, target.def, unknown]) {
    assert.ok(line.source.addresses.includes(definition.address), `missing origin ${definition.address}`);
    assert.ok(line.source.ir.includes(definition.id), `missing IR ${definition.id}`);
  }
  assert.ok(!line.source.addresses.includes(unrelated.def.address));
  assert.equal(new Set(line.source.addresses).size, line.source.addresses.length);
  assert.ok(result.warnings.length > 0, 'source coverage must not promote unsupported semantics');
});

test('the frozen x86 indirect-switch fallback retains the actual target-load origin', () => {
  const corpus = loadCorpus();
  const index = corpus.functions.findIndex(entry => entry.id === 'x86_64.quality.structure_switch.O0');
  assert.ok(index >= 0);
  const base = 0x100000n + BigInt(index) * 0x10000n;
  for (const phase8Optimize of [false, true]) {
    const { result, failure } = decompileEntry(corpus.functions[index], { index, phase8Optimize });
    assert.equal(failure, undefined);
    const line = result.lines.find(item => item.text.includes('semantic-v2 unknown-control-effect'));
    assert.ok(line, 'indirect control must remain explicitly unresolved');
    assert.ok(line.source.addresses.includes(base + 35n), 'MOVSXD jump-table load is an input dependency');
    assert.ok(line.source.addresses.includes(base + 42n), 'JMP owns the unresolved transfer');
    assert.ok(!line.source.addresses.includes(base + 92n), 'unrelated default-arm store is not a target dependency');
    const load = result.ir.instructions.find(inst => inst.op === 'load' && inst.address === base + 35n);
    assert.ok(load);
    assert.ok(line.source.ir.includes(load.id));
    assert.ok(result.sourceMap.some(mapping => mapping.source.addresses.includes(base + 35n)),
      'dependency must survive the actual high-level printer');
  }
});
