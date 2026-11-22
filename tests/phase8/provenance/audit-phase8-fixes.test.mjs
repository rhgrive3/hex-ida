import assert from 'node:assert/strict';
import test from 'node:test';

import { AGGREGATE_KINDS, CERTAINTIES, forcedContradictions } from '../../../js/decompiler/phase8/aggregates.js';
import { buildRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { applyPhase8Projection, readLineExpressionHistory } from '../../../js/decompiler/phase8/projection.js';
import { decompileSemantic } from '../../../js/decompiler/semantic-core.js';
import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline.js';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { decompileEntry } from '../../../tools/validation/phase8/decompile-corpus.mjs';
import { conditionalRegionFixture } from '../helpers/conditional-region-fixture.mjs';
import { fixture as irFixture } from '../helpers/ir-fixtures.mjs';
import { analysis } from './fixture.js';

function buildProjectedComparisonFixture() {
  const f = irFixture('audit-render-provenance');
  f.block(0);
  const cond = f.opaque(1);
  cond.reg = 'x0';
  f.conditionalBranch(cond, 1, 2);
  f.block(1); f.branch(3);
  f.block(2); f.branch(3);
  f.block(3); f.ret();
  const ir = f.build();
  ir.instructions = ir.blocks.flatMap(block => block.insts);
  ir.instructions.forEach((inst, index) => {
    inst.id = 900 + index;
    inst.row = index;
    inst.address = 0x9000n + BigInt(index * 4);
  });
  for (const block of ir.blocks) {
    block.startRow = block.insts[0]?.row;
    block.endRow = block.insts.at(-1)?.row;
  }
  const model = { name: 'audit-render-provenance', instructions: ir.instructions, calls: [] };
  const opts = { ir, deterministicTransforms: true };
  const seed = decompileSemantic(model, opts);
  const enhanced = enhanceSemanticDecompilation(seed, model, opts);
  const projected = applyPhase8Projection(enhanced, analysis(), { preserveInitialSpelling: true });
  return { ir, cond, projected };
}

test('render-only projection binds comparison-view condition history without altering spelling', () => {
  const corpus = loadCorpus();
  const id = 'x86_64.quality.structure_switch.O0';
  const index = corpus.functions.findIndex(entry => entry.id === id);
  assert.ok(index >= 0);
  const { result, failure } = decompileEntry(corpus.functions[index], {
    index,
    decompilerTimeBudgetMs: 20000,
    toolchain: corpus.toolchain ?? null,
  });
  assert.equal(failure ?? null, null);
  assert.equal(result.renderProvenance.completeness, 'complete');
  const records = result.renderProvenance.ledger.filter(
    record => record.rule === 'project-committed-comparison-view',
  );
  assert.ok(records.length >= 2);
  const bound = records.filter(record => record.renderedBinding === 'producer-bound');
  assert.ok(bound.length > 0, 'at least one comparison-view record must be producer-bound');
  assert.ok(bound.every(record => record.producedRefs.length > 0));
  assert.ok(
    !result.renderProvenance.ledger.some(record => record.rule === 'replace-initial-control-condition'),
    'spelling-preserving render-only projection must not invent a condition spelling replacement',
  );
});

test('conditionalRegionFixture with downstream branch produces complete structure and reachability', async () => {
  const f = conditionalRegionFixture({ after: 'branch' });
  assert.equal(f.structure.status, 'complete', f.structure.reason);
  const reachability = await f.run();
  assert.equal(reachability.status, 'complete', reachability.reason);
  assert.deepEqual(reachability.arms.map(arm => arm.verdict), ['refuted', 'proved']);
});

test('aggregates forcedContradictions validates kinds and certainties with O(1) Set lookup', () => {
  const validFacts = {
    regions: [{
      regionKey: 'stack-frame',
      conflicts: [],
      candidates: [
        { kind: 'struct', certainty: 'supported', conflicts: [], support: [{ tier: 'soft' }] },
        { kind: 'array', certainty: 'confirmed', conflicts: [], support: [{ tier: 'hard' }] },
      ],
    }],
  };
  const invalidFacts = {
    regions: [{
      regionKey: 'stack-frame',
      conflicts: [],
      candidates: [
        { kind: 'not-a-kind', certainty: 'not-a-certainty', conflicts: [], support: [{ tier: 'soft' }] },
      ],
    }],
  };

  const originalIncludes = Array.prototype.includes;
  let linearTableLookups = 0;
  Array.prototype.includes = function patchedIncludes(...args) {
    if (this === CERTAINTIES || this === AGGREGATE_KINDS) linearTableLookups += 1;
    return Reflect.apply(originalIncludes, this, args);
  };
  let validIssues;
  let invalidIssues;
  try {
    validIssues = forcedContradictions(validFacts);
    invalidIssues = forcedContradictions(invalidFacts);
  } finally {
    Array.prototype.includes = originalIncludes;
  }

  assert.equal(linearTableLookups, 0, 'forcedContradictions must use Set.has instead of Array.includes');
  assert.deepEqual(validIssues, []);
  assert.deepEqual(
    invalidIssues.map(issue => issue.problem).sort(),
    ['unknown-certainty', 'unknown-kind'],
  );
});

test('buildRenderProvenance detects live in-place mutation and result.ir swap outside memoized batch', () => {
  const first = buildProjectedComparisonFixture();
  assert.equal(first.projected.renderProvenance.completeness, 'complete');
  const boundLineIndex = first.projected.lines.findIndex(line => readLineExpressionHistory(line, first.ir)?.length);
  assert.ok(boundLineIndex >= 0);

  let baselineCalls = 0;
  const baseline = buildRenderProvenance({
    result: first.projected,
    snapshotId: 'snap-audit-baseline',
    shouldAbort: () => {
      baselineCalls += 1;
      return false;
    },
  });
  assert.equal(baseline.completeness, 'complete');
  assert.ok(baselineCalls > 2);

  let mutatedInPlace = false;
  let calls = 0;
  const inPlaceMutated = buildRenderProvenance({
    result: first.projected,
    snapshotId: 'snap-audit-inplace',
    shouldAbort: () => {
      calls += 1;
      if (!mutatedInPlace && calls === baselineCalls) {
        mutatedInPlace = true;
        first.ir.instructions = [...first.ir.instructions];
      }
      return false;
    },
  });
  assert.equal(mutatedInPlace, true);
  assert.equal(inPlaceMutated.completeness, 'incomplete');
  assert.ok(
    inPlaceMutated.reasons.includes('stale-expression-binding'),
    `expected stale-expression-binding after in-place mutation, got: ${JSON.stringify(inPlaceMutated.reasons)}`,
  );

  const second = buildProjectedComparisonFixture();
  const mutableResult = { ...second.projected };
  let swappedIr = false;
  let swapCalls = 0;
  const irSwapped = buildRenderProvenance({
    result: mutableResult,
    snapshotId: 'snap-audit-swap',
    shouldAbort: () => {
      swapCalls += 1;
      if (!swappedIr && swapCalls === baselineCalls) {
        swappedIr = true;
        mutableResult.ir = { ...second.ir };
      }
      return false;
    },
  });
  assert.equal(swappedIr, true);
  assert.equal(irSwapped.completeness, 'incomplete');
  assert.ok(
    irSwapped.reasons.includes('stale-expression-binding')
      || irSwapped.reasons.includes('stale-render-provenance-observation'),
    `expected stale reason after result.ir swap, got: ${JSON.stringify(irSwapped.reasons)}`,
  );
});
