import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture as irFixture } from '../helpers/ir-fixtures.mjs';
import { decompileSemantic } from '../../../js/decompiler/semantic-core.js';
import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { analysis } from '../provenance/fixture.js';

function fixture() {
  const f = irFixture('projection-validation-batch');
  f.block(0);
  const condition = f.opaque(1);
  condition.reg = 'x0';
  f.conditionalBranch(condition, 1, 2);
  f.block(1); f.branch(3);
  f.block(2); f.branch(3);
  f.block(3); f.ret();
  const ir = f.build();
  ir.instructions = ir.blocks.flatMap(block => block.insts);
  ir.instructions.forEach((instruction, index) => {
    instruction.id = 800 + index;
    instruction.row = index;
    instruction.address = 0x8000n + BigInt(index * 4);
  });
  for (const block of ir.blocks) {
    block.startRow = block.insts[0]?.row;
    block.endRow = block.insts.at(-1)?.row;
  }
  const model = { name:'projection-validation-batch', instructions:ir.instructions, calls:[] };
  const opts = { ir, deterministicTransforms:true };
  const seed = decompileSemantic(model, opts);
  const enhanced = enhanceSemanticDecompilation(seed, model, opts);
  return { ir, condition, model, opts, enhanced };
}

test('render-only projection keeps its text and bounds repeated producer validation work', () => {
  const f = fixture();
  const expectedText = f.enhanced.pseudocode;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  let observedTargetReads = 0;
  Object.getOwnPropertyDescriptor = function (target, key) {
    if (target === f.condition) observedTargetReads++;
    return Reflect.apply(getOwnPropertyDescriptor, Object, [target, key]);
  };
  let projected;
  try {
    projected = applyPhase8Projection(f.enhanced, analysis(), { preserveInitialSpelling:true });
  } finally {
    Object.getOwnPropertyDescriptor = getOwnPropertyDescriptor;
  }

  assert.equal(projected.pseudocode, expectedText, 'render-only projection must preserve the exact pseudocode');
  assert.equal(projected.renderProvenance.completeness, 'complete');
  assert.equal(projected.sourceMap.length, projected.lines.length, 'every rendered line keeps its source attribution');
  assert.ok(projected.sourceMap.every(entry => entry.source), 'render-only projection keeps per-line source attribution');
  assert.ok(observedTargetReads < 100, `validation work should stay bounded for one producer object (reads=${observedTargetReads})`);
});
