import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  INTERACTIVE_STAGES,
  PASS_STAGES,
  runPhase8Stage,
} from '../../../js/decompiler/phase8/index.js';

const PROFILE = JSON.parse(fs.readFileSync(
  new URL('../../../tools/validation/phase8/profile.json', import.meta.url),
  'utf8',
));

const CONTEXT = Object.freeze({
  ir: {
    values:[
      { id:1, origin:{ instructionIds:['instruction_1'] } },
      { id:2, origin:{ instructionIds:['instruction_2'] } },
    ],
    blocks:[{ id:'entry' }],
    entry:'entry',
    origin:{ instructionIds:['instruction_1'] },
  },
  types:null,
  opts:{ deterministicTransforms:false },
});

test('the production stage routes interactive and demand-driven work separately', () => {
  const interactive = runPhase8Stage(CONTEXT, {
    stages:INTERACTIVE_STAGES,
    budgetClass:'interactive',
  });
  const optimized = runPhase8Stage(CONTEXT, {
    stages:PASS_STAGES,
    budgetClass:'standard',
  });

  assert.deepEqual([...interactive.ledger.enabledStages], [...INTERACTIVE_STAGES]);
  assert.deepEqual([...optimized.ledger.enabledStages], [...PASS_STAGES]);
  assert.equal(interactive.ledger.published, true);
  assert.equal(optimized.ledger.published, true);
  assert.ok(Number.isFinite(interactive.elapsedMs) && interactive.elapsedMs >= 0);
  assert.ok(Number.isFinite(optimized.elapsedMs) && optimized.elapsedMs >= 0);
  assert.ok(Number.isFinite(PROFILE.performance.budgetsMs.phase8InteractiveStage));
  assert.ok(Number.isFinite(PROFILE.performance.budgetsMs.phase8OptimizeStage));
});

test('invalid infinite deadlines fail closed instead of disabling cancellation', () => {
  const outcome = runPhase8Stage(CONTEXT, {
    stages:INTERACTIVE_STAGES,
    timeBudgetMs:Number.POSITIVE_INFINITY,
  });
  assert.equal(outcome.ledger.published, false);
  assert.equal(outcome.ledger.status, 'cancelled');
  assert.equal(outcome.ledger.stopReason, 'cancelled-before-start');
});
