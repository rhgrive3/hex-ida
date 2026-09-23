#!/usr/bin/env node
// Replay the committed projection only. This does not replay raw live Jev API calls.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(fs.readFileSync(path.join(HERE, 'current-main-baseline.json'), 'utf8'));
const rows = fs.readFileSync(path.join(HERE, 'feature-matrix.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map(JSON.parse);

function metrics(subset, pred) {
  let wrongToCorrect = 0;
  let correctToWrong = 0;
  let correctAfter = 0;
  let triggered = 0;
  for (const r of subset) {
    const fired = pred(r);
    const after = fired ? !!r.jevCorrect : !!r.baselineCorrect;
    if (fired) triggered++;
    if (after) correctAfter++;
    if (fired && !r.baselineCorrect && after) wrongToCorrect++;
    if (fired && r.baselineCorrect && !after) correctToWrong++;
  }
  return {
    N: subset.length,
    triggered,
    baselineCorrect: subset.filter((r) => r.baselineCorrect).length,
    correctAfter,
    wrongToCorrect,
    correctToWrong,
    net: wrongToCorrect - correctToWrong,
  };
}

const dev = rows.filter((r) => r.binary === 'battlecats');
const observed = rows.filter((r) => r.binary !== 'battlecats');
const forceAll = metrics(rows, () => true);
const g28Full = metrics(rows, (r) => !!r.strong);
const g28Dev = metrics(dev, (r) => !!r.strong);
const g28Observed = metrics(observed, (r) => !!r.strong);
const baselineFalseStrong = rows.filter((r) => r.strong && !r.baselineCorrect).length;
const g28FalseStrongAfter = rows.filter((r) => r.strong && !r.jevCorrect).length;

assert.equal(rows.length, 196);
assert.equal(baseline.top1, 282);
assert.equal(forceAll.wrongToCorrect, 46);
assert.equal(forceAll.correctToWrong, 7);
assert.equal(g28Full.wrongToCorrect, 29);
assert.equal(g28Full.correctToWrong, 1);
assert.equal(g28Full.correctAfter, 81);
assert.equal(g28Dev.wrongToCorrect, 15);
assert.equal(g28Dev.correctToWrong, 1);
assert.equal(g28Observed.wrongToCorrect, 14);
assert.equal(g28Observed.correctToWrong, 0);
assert.equal(baselineFalseStrong, 67);
assert.equal(g28FalseStrongAfter, 39);

process.stdout.write(JSON.stringify({
  scope: 'committed-projection replay; raw live API responses are not committed',
  baseline: {
    overallTop1: baseline.top1,
    partialTop1: baseline.partial.top1,
    exactTop1: baseline.exact.top1,
  },
  forceAll,
  g28: {
    development: g28Dev,
    observedCrossBinary: g28Observed,
    fullCorpus: {
      ...g28Full,
      overallTop1: baseline.exact.top1 + g28Full.correctAfter,
    },
    falseStrong: {
      before: baselineFalseStrong,
      after: g28FalseStrongAfter,
      delta: g28FalseStrongAfter - baselineFalseStrong,
      verdictPromotions: 0,
    },
  },
}, null, 2) + '\n');
