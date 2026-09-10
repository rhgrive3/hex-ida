import assert from 'node:assert/strict';
import test from 'node:test';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { buildSemanticSsa } from '../../../js/semantics/ssa/build.js';
import { classifySemanticMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';
import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';
import { ALIAS_QUERIES_V2, buildFixture, memoryAccessOf } from '../corpus/fixtures.mjs';

// Preserve identity equality, physical-state kinds, operations, offsets, widths,
// CFG and descriptors. Only arbitrary state-key and node/value ID spellings change, with
// descriptor lookups renamed by the same bijection. Rebuild SSA after renaming;
// copied analysis facts are not proof for a new semantic artifact.
function renamedFixture(original, prefix) {
  const keys = [...new Set(original.ir.nodes.flatMap(node => node.variable?.key ? [node.variable.key] : []))].sort();
  const identifiers = [...new Set([...keys, ...original.ir.nodes.map(n => n.id), ...original.ir.values.map(v => v.id)])].sort();
  const mapping = new Map(identifiers.map((key, index) => [key, prefix == null ? key : `${prefix}_${index}`]));
  assert.equal(new Set(mapping.values()).size, identifiers.length);
  function rename(value, translations = mapping) {
    if (typeof value === 'string') return translations.get(value) ?? value;
    if (Array.isArray(value)) return value.map(item => rename(item, translations));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rename(item, translations)]));
    return value;
  }
  const input = rename(structuredClone(original.ir));
  assert.deepEqual(rename(input, new Map([...mapping].map(([a, b]) => [b, a]))), structuredClone(original.ir), 'renaming must be invertible');
  for (let index = 0; index < input.nodes.length; index++) {
    assert.equal(input.nodes[index].kind, original.ir.nodes[index].kind);
    assert.equal(input.nodes[index].operator, original.ir.nodes[index].operator);
    assert.deepEqual(input.nodes[index].attributes?.constant, structuredClone(original.ir.nodes[index].attributes?.constant));
  }
  const rootDescriptors = original.rootDescriptors == null ? null : Object.fromEntries(
    Object.entries(original.rootDescriptors).map(([key, descriptor]) => {
      const variable = key.startsWith('variable:') ? key.slice('variable:'.length) : null;
      const renamedKey = variable != null && mapping.has(variable) ? `variable:${mapping.get(variable)}` : key;
      return [renamedKey, rename(structuredClone(descriptor))];
    }),
  );
  const ir = createSemanticIrFunction(input), cfg = original.cfg;
  const ssa = buildSemanticSsa(ir, cfg);
  assert.notEqual(ir, original.ir);
  assert.notEqual(ssa, original.ssa);
  if (prefix != null) {
    assert.ok(identifiers.length > 0, 'every corpus fixture must actually be renamed');
    for (const node of ir.nodes.filter(node => node.variable?.key)) {
      assert.ok([...mapping.values()].includes(node.variable.key));
      assert.equal(keys.includes(node.variable.key), false);
    }
  }
  const solver = createPhase7AliasSolver({ ir, cfg, ssa,
    options: rootDescriptors == null ? {} : { canonicalOptions: { rootDescriptors } } });
  function region(nodeId) {
    const node = ir.nodes.find(item => item.id === (mapping.get(nodeId) ?? nodeId));
    const regions = classifySemanticMemoryRegion(ir, node, { binaryId: original.binaryId, ssa,
      ...(rootDescriptors == null ? {} : { rootDescriptors }) });
    return Array.isArray(regions) ? regions[0] : regions;
  }
  return { stateKeyCount: keys.length, answer: query => solver.alias(region(query.left), region(query.right), {
    leftAccess: memoryAccessOf({ ir }, mapping.get(query.left) ?? query.left),
    rightAccess: memoryAccessOf({ ir }, mapping.get(query.right) ?? query.right),
  }) };
}

test('C1-03: all frozen alias queries retain truth under semantic root renaming', t => {
  const prefixes = ['neutral', 'heap', 'alloc', 'global', 'g_root', 'tls', 'stack', 'register'];
  const rows = [];
  assert.equal(ALIAS_QUERIES_V2.length, 30, 'do not shrink the frozen denominator');
  for (const query of ALIAS_QUERIES_V2) {
    const original = buildFixture(query.fixture), before = structuredClone(original.ir);
    const baseline = renamedFixture(original, null).answer(query);
    if (query.truth === 'no' || query.truth === 'must') assert.equal(baseline.relation, query.truth, query.id);
    else assert.ok(['may', 'unknown'].includes(baseline.relation), query.id);
    for (const prefix of prefixes) {
      const { answer, stateKeyCount } = renamedFixture(original, prefix);
      const result = answer(query);
      assert.equal(result.relation, baseline.relation, `${query.id}/${prefix}: spelling changed alias truth`);
      assert.deepEqual(result.reasonCodes, baseline.reasonCodes, `${query.id}/${prefix}: spelling changed proof class`);
      assert.equal(result.status.completeness, baseline.status.completeness);
      assert.equal(answer({ ...query, left: query.right, right: query.left }).relation, result.relation, 'alias relation must be symmetric');
      assert.equal(answer(query).relation, result.relation, 'cached replay must retain the answer');
      rows.push({ query: query.id, prefix, stateKeyCount, truth: query.truth, relation: result.relation });
    }
    assert.deepEqual(structuredClone(original.ir), before, 'the frozen source corpus is not rewritten');
  }
  assert.equal(rows.length, 240);
  assert.equal(rows.filter(row => row.stateKeyCount === 0).length, 16, 'two absolute-address queries are identifier-only controls, not root-renaming evidence');
  assert.equal(rows.filter(row => ['no', 'must'].includes(row.relation)).length, 120);
  assert.equal(rows.filter(row => ['no', 'must'].includes(row.relation) && row.relation !== row.truth).length, 0);
  t.diagnostic(JSON.stringify({ schema: 'c1-root-rename-matrix-v1', rows,
    scope: '30 frozen declared-truth queries x 8 bijective state-key/node/value renamings; 224 state-root cells and 16 absolute identifier-only controls; canonical SSA/classifier/solver' }));
});
