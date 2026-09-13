import test from 'node:test';
import assert from 'node:assert/strict';

import { groupedFusion } from '../js/calib.js';
import { UNVERIFIED_CEIL } from '../js/evidence.js';

// #4344: groupedFusion must accept only primitive finite numbers as LR,
// strength, candidate-universe, absent and prior authority. Numeric strings,
// Arrays, booleans and objects must fail closed to the existing fallback or
// neutral value instead of being promoted through Number() coercion.

const V = { code: 'runtime-proof', family: 'verified', kind: 'verified' };
const DEFAULT_PRIOR = 1 / (200 + 40);
const DEFAULT_LOG_ODDS = Math.log(DEFAULT_PRIOR / (1 - DEFAULT_PRIOR));
const NO_DELTA = Math.log(0.1 / 0.9);

function close(actual, expected, message) {
  assert.ok(Number.isFinite(actual), `${message}: finite expected, got ${actual}`);
  assert.ok(Math.abs(actual - expected) < 1e-12, `${message}: ${actual} != ${expected}`);
}

test('#4344 canonical number LR/strength/prior/count keep their grouped fusion results', () => {
  const single = groupedFusion([{ ...V, lr: 1000, strength: 1 }], { candidates: 200, absent: 40, prior: 0.1 });
  assert.equal(single.prior, 0.1);
  close(single.logOdds, 4.710530701645918, 'logOdds');
  close(single.byGroup.runtime, 6.907755278982137, 'runtime group logOdds');
  assert.equal(single.verified, 1);
  assert.equal(single.items.length, 1);

  const damped = groupedFusion(
    [{ ...V, lr: 1000, strength: 1 }, { ...V, code: 'runtime-proof-2', lr: 100, strength: 0.5 }],
    { candidates: 200, absent: 40, prior: 0.1 },
  );
  close(damped.logOdds, 5.757160289370484, 'damped group fusion keeps cap/damping');
  assert.equal(damped.verified, 2);
  close(damped.byGroup.runtime, 7.954384866706703, 'damped runtime group');

  const neutral = groupedFusion([{ ...V, lr: NaN, strength: NaN }], { candidates: 200, absent: 40, prior: 0.1 });
  assert.equal(neutral.items.length, 0, 'NaN LR/strength stay neutral (existing fallback)');
  close(neutral.logOdds, NO_DELTA, 'NaN values keep prior-only logOdds');

  const clamped = groupedFusion(
    [{ ...V, lr: 1000, strength: 1.5 }, { ...V, code: 'x2', lr: 1000, strength: -3 }],
    { candidates: 200, absent: 40, prior: 0.1 },
  );
  assert.equal(clamped.items.length, 1, 'finite strength keeps existing [0,1] clamp, negative clamps to 0');
  close(clamped.logOdds, 4.710530701645918, 'clamped strength');
});

test('#4344 finite zero/negative LR and count boundaries keep their existing policy', () => {
  const zeroLr = groupedFusion([{ ...V, lr: 0, strength: 1 }], { candidates: 200, absent: 40, prior: 0.1 });
  assert.equal(zeroLr.items.length, 1, 'numeric 0 LR stays a real (negative) contribution');
  close(zeroLr.logOdds, -16.012735135300492, 'zero LR clamps through Math.max(1e-6, lr)');

  const negativeLr = groupedFusion([{ ...V, lr: -5, strength: 1 }], { candidates: 200, absent: 40, prior: 0.1 });
  close(negativeLr.logOdds, zeroLr.logOdds, 'negative finite LR follows the same existing clamp');

  const counts = groupedFusion([], { candidates: 0, absent: -5, prior: 0 });
  assert.equal(counts.prior, 1e-9, 'finite numbers keep prior clamp and negative count fallback');
  close(counts.logOdds, -20.72326583594641, 'zero candidates / fallback absent policy');
});

test('#4344 verified ceiling is not weakened by the typed contract', () => {
  const capped = groupedFusion([{ code: 'runtime-proof', family: 'runtime', kind: 'heuristic', lr: 1e9, strength: 1 }],
    { candidates: 200, absent: 40, prior: 0.1 });
  assert.equal(capped.verified, 0);
  close(capped.logOdds, UNVERIFIED_CEIL, 'unverified ceiling still applies to canonical numbers');
});

test('#4344 structured LR values fail closed to the neutral ratio', () => {
  for (const lr of ['1000', ['1000'], true, {}, ['1'], [], '1']) {
    const result = groupedFusion([{ ...V, lr, strength: 1 }], { candidates: 200, absent: 40, prior: 0.1 });
    assert.equal(result.items.length, 0, `lr ${JSON.stringify(lr)} must not contribute evidence`);
    assert.equal(result.verified, 0);
    close(result.logOdds, NO_DELTA, `structured lr ${JSON.stringify(lr)} falls back to neutral 1`);
  }
});

test('#4344 structured strength values fail closed to zero contribution', () => {
  for (const strength of ['1', ['1'], '0.5', true, ['0.5'], {}, '0']) {
    const result = groupedFusion([{ ...V, lr: 1000, strength }], { candidates: 200, absent: 40, prior: 0.1 });
    assert.equal(result.items.length, 0, `strength ${JSON.stringify(strength)} must not set authority`);
    assert.equal(result.verified, 0);
    close(result.logOdds, NO_DELTA, `structured strength ${JSON.stringify(strength)} fails closed`);
  }
});

test('#4344 structured candidate/absent counts fail closed to fallbacks', () => {
  const result = groupedFusion([], { candidates: [5], absent: [5] });
  assert.equal(result.prior, DEFAULT_PRIOR, 'array counts must not shrink the candidate universe');

  const boolCounts = groupedFusion([], { candidates: true, absent: true });
  assert.equal(boolCounts.prior, DEFAULT_PRIOR, 'boolean counts must not become the universe size');

  const stringCounts = groupedFusion([], { candidates: '5', absent: '5' });
  assert.equal(stringCounts.prior, DEFAULT_PRIOR, 'numeric strings must not be promoted to counts');
});

test('#4344 structured prior values fail closed to the computed default prior', () => {
  for (const prior of ['0.1', ['0.1'], true, {}, [], '0', '0.5']) {
    const result = groupedFusion([], { candidates: 200, absent: 40, prior });
    assert.equal(result.prior, DEFAULT_PRIOR, `prior ${JSON.stringify(prior)} must not override the default`);
    close(result.logOdds, DEFAULT_LOG_ODDS, `structured prior ${JSON.stringify(prior)} fails closed`);
  }
});

test('#4344 issue-minimal repro: all-structured metadata carries no evidence authority', () => {
  const result = groupedFusion(
    [{ ...V, lr: ['1000'], strength: ['1'] }],
    { candidates: ['200'], absent: ['40'], prior: ['0.1'] },
  );
  assert.notEqual(result.prior, 0.1, 'array prior must not be adopted');
  assert.equal(result.prior, DEFAULT_PRIOR);
  assert.equal(result.verified, 0, 'array LR/strength must not count as verified evidence');
  assert.equal(result.items.length, 0);
  close(result.logOdds, DEFAULT_LOG_ODDS, 'prior-only logOdds with neutral fusion');

  const mixed = groupedFusion(
    [{ ...V, lr: 1000, strength: 1 }, { ...V, code: 'runtime-proof-2', lr: ['1000'], strength: ['1'] }],
    { candidates: 200, absent: 40, prior: 0.1 },
  );
  assert.equal(mixed.items.length, 1, 'only the canonical numeric item contributes');
  assert.equal(mixed.verified, 1);
  close(mixed.logOdds, 4.710530701645918, 'structured sibling leaves canonical result untouched');
});
