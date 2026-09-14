import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createSemanticIrFunction, canonicalSerializeSemanticIr } from '../../js/semantics/ir/function.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const origin = { instructionIds: ['i0'] };
const mk = (id, blockId) => ({
  id, kind: 'const', blockId, inputs: [], outputs: [`out_${id}`],
  attributes: { value: '1' }, completeness: 'complete', origin,
});
const val = (id, nodeId) => ({
  id, kind: 'definition', machineType: { kind: 'bitvector', widthBits: 8 }, definitionNodeId: nodeId, origin,
});

function irFixture() {
  return {
    functionId: 'f',
    entryBlockId: 'b_entry',
    blocks: [
      { id: 'b_entry', nodeIds: ['n_e'], origin },
      { id: 'ä', nodeIds: ['n_ä'], origin },
      { id: 'z', nodeIds: ['n_z'], origin },
    ],
    values: [val('out_n_e', 'n_e'), val('out_n_ä', 'n_ä'), val('out_n_z', 'n_z')],
    nodes: [mk('n_e', 'b_entry'), mk('n_ä', 'ä'), mk('n_z', 'z')],
    completeness: 'partial',
    unknowns: [{ reason: 'ä', categories: [] }, { reason: 'z', categories: [] }],
    origin,
  };
}

function serializeInLocale(input, locale) {
  const moduleUrl = pathToFileURL(path.join(ROOT, 'js/semantics/ir/function.js')).href;
  const source = [
    `import { canonicalSerializeSemanticIr } from ${JSON.stringify(moduleUrl)};`,
    `const input = ${JSON.stringify(input)};`,
    'process.stdout.write(canonicalSerializeSemanticIr(input));',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LANG: `${locale}.UTF-8`, LC_ALL: `${locale}.UTF-8` },
  });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
}

test('#5765 canonical ordering is UTF-16 code-unit order, not host ICU order', () => {
  // 'ä' (U+00E4) sorts after 'z' (U+007A) in code-unit order regardless of
  // locale (de_DE ICU collation ranks 'ä' before 'z').
  const f = createSemanticIrFunction(irFixture());
  assert.deepEqual(f.blocks.map((b) => b.id), ['b_entry', 'z', 'ä']);
  assert.deepEqual(f.values.map((v) => v.id), ['out_n_e', 'out_n_z', 'out_n_ä']);
  assert.deepEqual(f.nodes.map((n) => n.id), ['n_e', 'n_z', 'n_ä']);
  assert.deepEqual(f.unknowns.map((unknown) => unknown.reason), ['z', 'ä']);
});

test('#5765 the serialized canonical form is insertion/locale independent', () => {
  const f1 = createSemanticIrFunction(irFixture());
  const swapped = irFixture();
  swapped.blocks = [swapped.blocks[2], swapped.blocks[1], swapped.blocks[0]];
  swapped.nodes = [swapped.nodes[2], swapped.nodes[1], swapped.nodes[0]];
  swapped.values = [swapped.values[2], swapped.values[1], swapped.values[0]];
  swapped.unknowns = [swapped.unknowns[1], swapped.unknowns[0]];
  const f2 = createSemanticIrFunction(swapped);
  assert.equal(canonicalSerializeSemanticIr(f1), canonicalSerializeSemanticIr(f2));
});

test('#5765 separate host locales produce byte-identical canonical output', () => {
  const input = irFixture();
  assert.equal(serializeInLocale(input, 'de_DE'), serializeInLocale(input, 'sv_SE'));
});
