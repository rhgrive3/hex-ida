import test from 'node:test';
import assert from 'node:assert/strict';

import {
  brierScore,
  expectedCalibrationError,
  reliabilityBins,
  accuracyReport,
  fitCalibration,
} from '../js/calib.js';

// #5273: ground-truth `correct` must be verified as a strict boolean, not by
// JavaScript truthiness. Truthiness evaluation would treat string `"false"`,
// non-zero numbers, arrays, and objects as `correct: true`, inverting metrics
// and isotonic calibration curves.

test('#5273 brierScore ignores string "false" and non-boolean correct labels', () => {
  // If truthiness was used, { probability: 1, correct: 'false' } would yield y=1 and score (1-1)^2 = 0.
  // With strict boolean filtering, non-boolean labels are excluded, returning null for empty set.
  assert.equal(brierScore([{ probability: 1, correct: 'false' }]), null);
  assert.equal(brierScore([{ probability: 1, correct: 'true' }]), null);
  assert.equal(brierScore([{ probability: 1, correct: 1 }]), null);
  assert.equal(brierScore([{ probability: 1, correct: 0 }]), null);
  assert.equal(brierScore([{ probability: 1, correct: null }]), null);
  assert.equal(brierScore([{ probability: 1, correct: {} }]), null);

  // Mixed with a valid boolean sample: only the valid boolean sample is scored.
  const score = brierScore([
    { probability: 1, correct: false },
    { probability: 1, correct: 'false' },
  ]);
  assert.equal(score, 1, 'score should only reflect the single boolean false sample: (1 - 0)^2 = 1');
});

test('#5273 expectedCalibrationError excludes non-boolean ground truth', () => {
  assert.equal(expectedCalibrationError([{ probability: 1, correct: 'false' }]), null);
  const ece = expectedCalibrationError([
    { probability: 1, correct: true },
    { probability: 1, correct: 'false' },
  ]);
  assert.equal(ece, 0, 'only the true boolean sample is considered');
});

test('#5273 reliabilityBins excludes non-boolean ground truth from bin accuracy', () => {
  const binsOnlyString = reliabilityBins([{ probability: 0.9, correct: 'false' }], 10);
  for (const bin of binsOnlyString) {
    assert.equal(bin.n, 0);
    assert.equal(bin.accuracy, 0);
  }

  const binsMixed = reliabilityBins([
    { probability: 0.95, correct: false },
    { probability: 0.95, correct: 'false' },
  ], 10);
  assert.equal(binsMixed[9].n, 1, 'only the single boolean sample should be counted in bin');
  assert.equal(binsMixed[9].accuracy, 0, 'accuracy should be 0 from the boolean false sample');
});

test('#5273 accuracyReport ignores non-boolean ground truth labels in totals and rates', () => {
  const reportMalformedOnly = accuracyReport([
    { probability: 0.9, verdict: 'confirmed', correct: 'false', rank: 1 },
  ]);
  assert.equal(reportMalformedOnly.total, 0);

  const reportMixed = accuracyReport([
    { probability: 0.9, verdict: 'confirmed', correct: true, rank: 1 },
    { probability: 0.9, verdict: 'confirmed', correct: 'false', rank: 1 },
    { probability: 0.1, verdict: 'confirmed', correct: false, rank: 2 },
  ]);
  assert.equal(reportMixed.total, 2, 'only the 2 boolean-labeled rows enter total');
  assert.equal(reportMixed.confirmed, 2);
  assert.equal(reportMixed.falseConfirmRate, 0.5, '1 wrong out of 2 confirmed');
  assert.equal(reportMixed.precision, 0.5);
  assert.equal(reportMixed.recall, 0.5);
});

test('#5273 fitCalibration ignores non-boolean samples when fitting curve', () => {
  const malformedOnly = Array.from({ length: 60 }, (_, i) => ({
    probability: 0.1 + (i % 3) * 0.35,
    correct: 'false',
  }));
  const calibNull = fitCalibration(malformedOnly, 10);
  assert.equal(calibNull, null, 'no valid samples to fit calibration');

  const validOnly = Array.from({ length: 60 }, (_, i) => ({
    probability: 0.1 + (i % 3) * 0.35,
    correct: true,
  }));
  const calibValid = fitCalibration(validOnly, 10);
  assert.ok(calibValid !== null, 'valid boolean samples can fit calibration');
});
