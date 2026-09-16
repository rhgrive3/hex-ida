import assert from 'node:assert/strict';
import { maximumWeightCandidateMatching } from '../../../js/recognition/matcher.js';
import { solveCandidateMatching } from '../../../js/recognition/bounded-matching.js';
import { createMatchBudget } from '../../../js/recognition/match-budget.js';

function generator(n) {
  let yielded = 0;
  function* candidates() {
    for (let k = 0; k < n; k++) { yielded++; yield { i: 0, j: k, confidence: 0.9, id: `c${k}` }; }
  }
  return { candidates, getYielded: () => yielded };
}

// (1) Already-aborted signal must consume zero candidates, not the whole stream.
{
  const gen = generator(100_000);
  const ac = new AbortController();
  ac.abort();
  const out = maximumWeightCandidateMatching(gen.candidates(), {
    matchBudget: { signal: ac.signal, maxComponentEdges: 1, maxComponentNodes: 1, maxWallMs: 10_000 },
  });
  assert.equal(gen.getYielded(), 0, 'pre-aborted signal must not enumerate the candidate stream');
  assert.equal(out.length, 0);
}

// (2) A small maxCandidateAdmission caps raw enumeration even when the iterable is huge.
{
  const gen = generator(100_000);
  const budget = createMatchBudget({ maxCandidateAdmission: 500, maxComponentEdges: 20_000, maxComponentNodes: 2_048, maxWallMs: 10_000 });
  const solved = solveCandidateMatching(gen.candidates(), budget);
  assert.ok(gen.getYielded() <= 501, `enumeration must stay bounded (saw ${gen.getYielded()})`);
  assert.equal(solved.selected.length, 0, 'a truncated candidate stream cannot yield an authoritative exact selection');
  assert.equal(budget.snapshot().truncated, true);
  assert.equal(budget.candidateGraphIncomplete, true);
}

// (3) Retained-adjacency cap: many valid candidates in one component stop admission before solving.
{
  const gen = generator(50_000);
  const budget = createMatchBudget({ maxCandidateEdges: 64, maxComponentNodes: 2_048, maxComponentEdges: 20_000, maxWallMs: 10_000 });
  const solved = solveCandidateMatching(gen.candidates(), budget);
  assert.ok(budget.admissionRetained <= 65, `retained adjacency must be bounded (saw ${budget.admissionRetained})`);
  assert.equal(solved.selected.length, 0);
  assert.equal(budget.snapshot().truncated, true);
}

// (4) Non-terminating iterable is stopped by a finite solver-owned admission budget.
{
  let yielded = 0;
  function* infinite() { while (true) { yielded++; yield { i: yielded % 7, j: yielded, confidence: 0.5 }; } }
  const budget = createMatchBudget({ maxCandidateAdmission: 1000, maxComponentEdges: 20_000, maxComponentNodes: 2_048, maxWallMs: 10_000 });
  const solved = solveCandidateMatching(infinite(), budget);
  assert.ok(yielded <= 1001, `infinite iterable must be stopped (saw ${yielded})`);
  assert.equal(solved.selected.length, 0);
}

// (5) A mid-stream abort stops enumeration at a bounded count.
{
  let yielded = 0;
  const ac = new AbortController();
  function* candidates() {
    for (let k = 0; k < 1_000_000; k++) {
      yielded++;
      if (yielded === 50) ac.abort();
      yield { i: 0, j: k, confidence: 0.9 };
    }
  }
  const budget = createMatchBudget({ signal: ac.signal, maxCandidateAdmission: 2_000_000, maxComponentEdges: 20_000, maxComponentNodes: 2_048, maxWallMs: 10_000 });
  solveCandidateMatching(candidates(), budget);
  assert.ok(yielded < 200, `abort must stop enumeration at a bounded count (saw ${yielded})`);
}

// (7) Small Set and one-shot generator fixtures keep current correct exact-match behaviour.
{
  const asSet = new Set([{ i: 0, j: 1, confidence: 0.9 }, { i: 2, j: 3, confidence: 0.8 }]);
  const selected = maximumWeightCandidateMatching(asSet, { matchBudget: { maxWallMs: 10_000 } });
  assert.deepEqual(selected.map((x) => [x.i, x.j]).sort(), [[0, 1], [2, 3]]);

  function* gen() { yield { i: 0, j: 0, confidence: 0.95 }; yield { i: 1, j: 1, confidence: 0.85 }; }
  const genSelected = maximumWeightCandidateMatching(gen(), { matchBudget: { maxWallMs: 10_000 } });
  assert.deepEqual(genSelected.map((x) => [x.i, x.j]).sort(), [[0, 0], [1, 1]]);
}

// (8) Invalid confidence values are excluded without coercion side effects (#3861 contract).
{
  let coerced = 0;
  const bad = { get confidence() { coerced++; return '0.9'; }, i: 0, j: 0 };
  const out = maximumWeightCandidateMatching([bad, { i: 1, j: 1, confidence: 0.7 }], { matchBudget: { maxWallMs: 10_000 } });
  assert.equal(out.length, 1);
  assert.equal(out[0].i, 1);
  assert.equal(coerced, 1, 'confidence read exactly once, no numeric coercion applied');
}

console.log('issue-8914 recognition candidate-admission regression PASS');
