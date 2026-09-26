import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticModel } from '../../../js/blocks.js';
import { decompile } from '../../../js/decompile.js';
import { PassManager } from '../../../js/decompiler/passes/manager.js';
import { applyDecompilerProfile } from '../../../js/decompiler/profiles.js';
import { runPhase8Stage } from '../../../js/decompiler/phase8/index.js';

const BASE = 0x100000000n;

function modelForSignedClamp() {
  const lines = [
    'ldr w8, [x0, #0x20]',
    'sub w8, w8, w1',
    'cmp w8, #0',
    'csel w8, wzr, w8, lt',
    'str w8, [x0, #0x20]',
    'ret',
  ];
  const instructions = lines.map((line, row) => {
    const split = line.trim().indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? line.trim() : line.trim().slice(0, split),
      ops: split < 0 ? '' : line.trim().slice(split + 1),
    };
  });
  const rowOfAddress = (address) => {
    const delta = address - BASE;
    return delta < 0n || delta >= BigInt(lines.length * 4) ? null : Number(delta / 4n);
  };
  const model = buildSemanticModel(instructions, {
    startRow: 0,
    endRow: lines.length - 1,
    rowOfAddress,
  });
  return { model, rowOfAddress };
}

function modelForSimpleReturn() {
  const rowOfAddress = (address) => address === BASE ? 0 : null;
  const model = buildSemanticModel([
    { row: 0, address: BASE, mn: 'ret', ops: '' },
  ], { startRow: 0, endRow: 0, rowOfAddress });
  return { model, rowOfAddress };
}

function clock(stepMs) {
  let elapsed = 0;
  let calls = 0;
  const read = () => { calls += 1; elapsed += stepMs; return elapsed; };
  read.snapshot = () => ({ elapsed, calls });
  return read;
}

function emittedOutput(result) {
  return JSON.stringify({
    signature: result.signature,
    pseudocode: result.pseudocode,
    lines: result.lines?.map(({ kind, indent, text, row, addr }) => ({ kind, indent, text, row, addr })),
    coverage: result.coverage,
    summary: result.summary,
    phase8Digest: result.phase8?.publicationDigest ?? null,
  }, (_key, value) => typeof value === 'bigint' ? `bigint:${value}` : value);
}

test('fast output is invariant under a slow injected clock while below the safety ceiling', () => {
  const fastInput = modelForSimpleReturn();
  const slowInput = modelForSimpleReturn();
  const options = {
    profile: 'fast',
    addr: BASE,
    beginner: false,
  };
  const fastClock = clock(0), slowClock = clock(10);
  const fast = decompile(fastInput.model, { ...options, rowOfAddress: fastInput.rowOfAddress, transformClock: fastClock });
  const slow = decompile(slowInput.model, { ...options, rowOfAddress: slowInput.rowOfAddress, transformClock: slowClock });

  assert.equal(emittedOutput(slow), emittedOutput(fast));
  assert.ok(slowClock.snapshot().elapsed < 2000, `injected slow clock must remain below the fast safety ceiling: ${JSON.stringify(slowClock.snapshot())}`);
  assert.ok(!slow.passMetrics?.some((metric) => metric.degradationReason === 'transform-safety-ceiling'));
});

test('a synthetic transform that crosses the safety ceiling is degraded and preserves valid output structure', () => {
  {
    let now = 0;
    const opts = {};
    const state = new PassManager([
      {
        name: 'synthetic-expensive-transform',
        run(innerState, budget) {
          innerState.cAst = { kind: 'program', body: [{ kind: 'return', text: 'return 0;' }] };
          now = 2001;
          assert.equal(budget.shouldAbort(), true);
          assert.equal(innerState.opts.shouldAbort(), true);
          return innerState;
        },
      },
      { name: 'required-finalizer', required: true, run(innerState) { innerState.finalized = true; return innerState; } },
    ], { timeBudgetMs: 2000, deadlineReason: 'transform-safety-ceiling', clock: () => now }).run({ opts, cAst: { kind: 'program', body: [] } });

    assert.equal(Object.hasOwn(opts, 'shouldAbort'), false, 'the pass deadline hook must not leak into mandatory fallback work');
    assert.equal(state.degraded, true);
    assert.ok(state.degradationReasons.has('transform-safety-ceiling'));
    assert.ok(state.passMetrics.some((metric) => metric.degradationReason === 'transform-safety-ceiling'));
    assert.match(state.warnings.join('\n'), /Decompiler pass budget exhausted/);
    assert.equal(state.finalized, true);
    assert.equal(state.cAst.kind, 'program');
    assert.ok(Array.isArray(state.cAst.body));
  }
});

test('Phase 8 work budget exhaustion has a deterministic machine-readable reason', () => {
  const context = { ir: { values: [], blocks: [] }, opts: {} };
  const first = runPhase8Stage(context, { stages: ['canonical-facts'], maxWorkItems: 0 });
  const second = runPhase8Stage(context, { stages: ['canonical-facts'], maxWorkItems: 0 });

  assert.equal(first.budget.workBudgetExceeded, true);
  assert.equal(first.budget.stopReason, 'transform-work-budget');
  assert.equal(first.ledger.stopReason, 'transform-work-budget');
  assert.equal(second.ledger.stopReason, first.ledger.stopReason);
  assert.equal(second.ledger.publicationDigest, first.ledger.publicationDigest);
});

test('an explicit decompiler time budget overrides the fast safety ceiling and deterministic mode removes its deadline', () => {
  const limited = applyDecompilerProfile({ profile: 'fast', decompilerTimeBudgetMs: 47 });
  assert.equal(limited.decompilerTimeBudgetMs, 47);
  assert.equal(limited.transformDeadlineReason, 'transform-time-budget');
  assert.ok(Number.isFinite(limited.transformDeadline));

  const callerLongDeadline = applyDecompilerProfile({ profile: 'fast', decompilerTimeBudgetMs: 5000, transformClock: () => 100 });
  assert.equal(callerLongDeadline.transformDeadline, 5100, 'explicit caller deadline is not clamped to the profile safety ceiling');
  const cappedSafety = applyDecompilerProfile({ profile: 'fast', transformSafetyCeilingMs: 5000, transformClock: () => 100 });
  assert.equal(cappedSafety.transformSafetyCeilingMs, 2000, 'the profile safety ceiling remains capped');

  const deterministic = applyDecompilerProfile({ profile: 'fast', deterministicTransforms: true });
  assert.equal(deterministic.transformDeadline, null);
  assert.equal(deterministic.transformDeadlineReason, null);

  const deep = applyDecompilerProfile({ profile: 'deep' });
  assert.equal(deep.decompilerTimeBudgetMs, 250);
  assert.equal(deep.transformSafetyCeilingMs, null);
  assert.equal(deep.transformDeadline, null);
});

test('default fast decompilation reports rewrite work exhaustion without losing structural validity', () => {
  const { model, rowOfAddress } = modelForSignedClamp();
  const result = decompile(model, {
    profile: 'fast',
    addr: BASE,
    rowOfAddress,
    receiverType: 'Player',
    beginner: false,
    decompilerNodeBudget: 0,
    fieldFor: (_base, offset) => offset === 0x20n ? { name: 'hp', type: 'int32' } : null,
  });

  assert.equal(result.ctx?.decompilerPipeline?.degraded, true);
  assert.ok(result.passMetrics?.some((metric) => metric.degradationReason === 'transform-work-budget'));
  assert.match(result.warnings.join('\n'), /Decompiler rewrite budget reached/);
  assert.equal(typeof result.pseudocode, 'string');
  assert.ok(Array.isArray(result.lines));
});
