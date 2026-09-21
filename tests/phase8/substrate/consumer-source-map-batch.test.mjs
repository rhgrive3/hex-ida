import test from 'node:test';
import assert from 'node:assert/strict';
import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline-core.js';
import { createValidationBatch } from '../../../js/core/identity/live-data.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

function buildTestFixture() {
  const f = fixture('consumer_batch_test'); f.block(0);
  const a = f.opaque(8); a.index = 0; a.reg = 'x0';
  const target = f.binary('add', a, a, 8); f.ret();
  const ir = f.build();
  ir.instructions = ir.blocks.flatMap(block => [...block.phis, ...block.insts]);
  ir.instructions.forEach((inst, index) => {
    inst.id = `inst_${index}`;
    inst.address = 0x1000n + BigInt(index * 4);
  });
  const ret = ir.instructions.at(-1);
  ret.args = [{ value: target }];
  return { ir, ret };
}

test('consumerSourceMap: produces valid sourceMap for enhanced decompilation', () => {
  const { ir, ret } = buildTestFixture();
  const result = enhanceSemanticDecompilation({
    semantic: true,
    ir,
    types: null,
    lines: [{ kind: 'stmt', indent: 0, text: 'return pending;', row: ret.row, addr: ret.address }],
    metrics: {},
    ctx: {},
  }, null, { decompilerTimeBudgetMs: 1000, returnType: 'uint8_t' });

  assert.ok(result.sourceMap, 'sourceMap must be present on enhanced result');
  assert.ok(Array.isArray(result.sourceMap), 'sourceMap must be an array');
  assert.ok(result.sourceMap.length > 0, 'sourceMap must have entries');
  for (const entry of result.sourceMap) {
    assert.equal(typeof entry.outputStartLine, 'number');
    assert.equal(typeof entry.outputEndLine, 'number');
    assert.ok(entry.source, 'source mapping must be defined');
  }
});

test('validation batch: fail-closed fallback on mid-pass mutation', () => {
  const root = { value: 1 };
  const batch = createValidationBatch();
  let observedAnswer = null;

  batch.run(() => {
    batch.remember(root, null, true, () => root.value === 1);
    observedAnswer = batch.known(root, null);
  });

  assert.equal(observedAnswer, true);

  // Mutation occurs before settlement
  root.value = 999;
  const staleCount = batch.settle();
  assert.equal(staleCount, 1, 'settle() must detect mid-pass mutation and report stale count');
});

test('validation batch: isolated across independent batch invocations', () => {
  const root = { value: 1 };
  const batch1 = createValidationBatch();
  batch1.run(() => {
    batch1.remember(root, null, true, () => root.value === 1);
  });
  assert.equal(batch1.settle(), 0);

  // A second batch starts clean and does not retain answers from batch1
  const batch2 = createValidationBatch();
  let answerFromBatch2 = null;
  batch2.run(() => {
    answerFromBatch2 = batch2.known(root, null);
  });
  assert.equal(answerFromBatch2, undefined, 'subsequent batch must not retain memoized answers');
  assert.equal(batch2.settle(), 0);
});
