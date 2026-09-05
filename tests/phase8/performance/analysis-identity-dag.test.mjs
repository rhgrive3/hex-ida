import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { PASS_STAGES, runPhase8Stage } from '../../../js/decompiler/phase8/index.js';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { decompileEntry } from '../../../tools/validation/phase8/decompile-corpus.mjs';

const PROFILE = JSON.parse(fs.readFileSync(
  new URL('../../../tools/validation/phase8/profile.json', import.meta.url),
  'utf8',
));

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

test('the frozen worst-case scalar identity corpus entry stays inside the optimize-stage budget', (context) => {
  const corpus = loadCorpus();
  const entry = corpus.functions.find((candidate) => candidate.id === 'x86_64.quality.loop_nested.O2');
  assert.ok(entry, 'the frozen worst-case regression entry must remain in the corpus');
  const outcome = decompileEntry(entry, {
    index:corpus.functions.indexOf(entry),
    deterministicTransforms:false,
    phase8Optimize:false,
  });
  assert.ok(outcome.result?.semantic && outcome.result?.ir, outcome.failure ?? 'semantic IR unavailable');

  const samples = [];
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const stage = runPhase8Stage(
      { ir:outcome.result.ir, types:outcome.result.types ?? null, opts:{ deterministicTransforms:false } },
      { stages:PASS_STAGES, budgetClass:'standard' },
    );
    assert.equal(stage.ledger?.published, true);
    assert.equal(stage.ledger?.completeness, 'complete');
    samples.push(stage.elapsedMs);
  }

  const measured = median(samples);
  const budget = PROFILE.performance.budgetsMs.phase8OptimizeStage;
  context.diagnostic(
    `Phase 8 optimize-stage samples: ${samples.map((sample) => sample.toFixed(1)).join(', ')} ms; median ${measured.toFixed(1)} ms`,
  );
  assert.ok(measured <= budget,
    `Phase 8 optimize-stage median ${measured.toFixed(1)} ms exceeded the frozen ${budget} ms budget (${samples.map((sample) => sample.toFixed(1)).join(', ')})`);
});
