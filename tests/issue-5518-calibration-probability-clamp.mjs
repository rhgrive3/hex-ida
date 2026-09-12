import test from 'node:test';
import assert from 'node:assert/strict';

import { expectedCalibrationError, reliabilityBins } from '../js/calib.js';

// #5518: probability=1 must not be rewritten to 0.999999. The clamp to [0,1]
// feeds the confidence aggregation with the true value; only the bin INDEX is
// clamped into the last bin. Otherwise perfectly confident correct samples
// permanently contribute a phantom calibration error.

test('#5518 expectedCalibrationError is exactly 0 for a fully confident correct sample', () => {
  const ece = expectedCalibrationError([{ probability: 1, correct: true }]);
  assert.equal(ece, 0);
});

test('#5518 reliabilityBins reports confidence 1, not 0.999999', () => {
  const bins = reliabilityBins([{ probability: 1, correct: true }], 10);
  assert.equal(bins[9].confidence, 1);
  assert.equal(bins[9].accuracy, 1);
  assert.equal(bins[9].n, 1, 'p=1 lands in the last bin');
});

test('#5518 p=1 lands in the last bin while confidence stays the true value', () => {
  const samples = [
    { probability: 1, correct: true },
    { probability: 0.95, correct: true },
  ];
  const bins = reliabilityBins(samples, 10);
  assert.equal(bins[9].n, 2, 'both samples fall into the last bin');
  assert.equal(bins[9].confidence, 0.975, 'the mean uses the true probabilities');
});

test('#5518 a fully confident WRONG sample reports its real error', () => {
  const ece = expectedCalibrationError([{ probability: 1, correct: false }]);
  assert.equal(ece, 1, '|accuracy 0 - confidence 1| = 1');
});

test('#5518 sub-unity probabilities keep their previous binning', () => {
  const bins = reliabilityBins([{ probability: 0.5, correct: true }], 10);
  assert.equal(bins[5].n, 1, 'p=0.5 falls into bin 5 under the same index rule');
  assert.equal(bins[5].confidence, 0.5);
});
