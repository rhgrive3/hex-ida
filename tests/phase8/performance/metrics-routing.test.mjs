import assert from 'node:assert/strict';
import test from 'node:test';

import { performanceMetrics } from '../../../tools/validation/phase8/metrics.mjs';
import { PROFILE, verifyPhase8 } from '../../../tools/validation/phase8/verify.mjs';

function fakeResult(id, { interactiveMs = 2, published = true, completeness = 'complete' } = {}) {
  return {
    id,
    result: {
      semantic:true,
      ir:{ fixtureId:id, values:[], blocks:[], instructions:[] },
      types:null,
      lines:[],
      sourceMap:[],
      metrics:{},
      phase8:{ published, completeness, enabledStages:['canonical-facts'] },
      ctx:{ decompilerPipeline:{ completeness, phase8ElapsedMs:interactiveMs } },
    },
  };
}

test('performance metrics time the interactive product path and both frozen stage classes', () => {
  const modes = [];
  const stages = [];
  let tick = 0;
  const metrics = performanceMetrics({
    repetitions:2,
    corpus:{ functions:[
      { id:'fast', architectureId:'arm64', interactiveMs:2, optimizeMs:3 },
      { id:'slow', architectureId:'arm64', interactiveMs:4, optimizeMs:7 },
    ] },
    now:() => tick++,
    decompile:(entry, options) => {
      modes.push(options.phase8Optimize);
      return fakeResult(entry.id, { interactiveMs:entry.interactiveMs });
    },
    runStage:(context, options) => {
      stages.push([...options.stages]);
      const elapsedMs = context.ir.fixtureId === 'slow' ? 7 : 3;
      return { ledger:{ published:true, completeness:'complete' }, elapsedMs };
    },
  });

  assert.deepEqual(modes, [false, false, false, false],
    'cold active-function measurement must follow the default interactive route');
  assert.ok(stages.every((enabled) => enabled.length > 1),
    'the separately measured optimize stage must include the demand-driven stages');
  assert.equal(metrics.coldActiveFunctionMs.medianMs, 1);
  assert.equal(metrics.phase8InteractiveStageMs.medianMs, 4,
    'the frozen budget applies to the worst eligible function, not the corpus mean');
  assert.equal(metrics.phase8OptimizeStageMs.medianMs, 7,
    'the demand-driven budget applies to the worst eligible function');
  assert.equal(metrics.publishedLedgers, 2);
  assert.equal(metrics.runs.length, 2);
});

test('an incomplete or unpublished eligible stage makes the performance sample unavailable', () => {
  let tick = 0;
  const metrics = performanceMetrics({
    repetitions:1,
    corpus:{ functions:[{ id:'partial', architectureId:'arm64' }] },
    now:() => tick++,
    decompile:(entry) => fakeResult(entry.id, { published:false, completeness:'partial' }),
    runStage:() => ({ ledger:{ published:false, completeness:'partial' }, elapsedMs:1 }),
  });
  assert.equal(metrics.phase8InteractiveStageMs.medianMs, null);
  assert.equal(metrics.phase8OptimizeStageMs.medianMs, null);
});

function verifierMetrics(performance) {
  return {
    corpus:{},
    registry:{},
    quality:{ baseline:{}, candidate:{} },
    safety:Object.fromEntries(Object.keys(PROFILE.hardZero).map((key) => [key, 0])),
    performance,
  };
}

test('the verifier enforces every budget already frozen in the Phase 8 profile', () => {
  const report = verifyPhase8({
    shadow:true,
    metrics:verifierMetrics({
      coldActiveFunctionMs:{ medianMs:1, samples:[1] },
      phase8InteractiveStageMs:{ medianMs:PROFILE.performance.budgetsMs.phase8InteractiveStage + 1, samples:[6] },
      phase8OptimizeStageMs:{ medianMs:PROFILE.performance.budgetsMs.phase8OptimizeStage + 1, samples:[121] },
      publishedLedgers:1,
      runs:[[]],
    }),
  });
  const failures = report.failures.filter((failure) => failure.category === 'performance');
  assert.ok(failures.some((failure) => failure.firstDivergence.includes('interactive stage')));
  assert.ok(failures.some((failure) => failure.firstDivergence.includes('optimize stage')));
});

test('a missing frozen performance measurement fails closed', () => {
  const report = verifyPhase8({
    shadow:true,
    metrics:verifierMetrics({
      coldActiveFunctionMs:{ medianMs:1, samples:[1] },
      phase8InteractiveStageMs:{ medianMs:null, samples:[] },
      phase8OptimizeStageMs:{ medianMs:null, samples:[] },
      publishedLedgers:0,
      runs:[[]],
    }),
  });
  const failures = report.failures.filter((failure) => failure.category === 'performance');
  assert.ok(failures.some((failure) => failure.firstDivergence.includes('not measured')));
});
