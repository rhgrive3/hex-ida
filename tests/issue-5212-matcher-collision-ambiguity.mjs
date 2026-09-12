import assert from 'node:assert/strict';
import { matchFunctions, recognitionMetrics } from '../js/recognition/matcher.js';
import { diffFunctions } from '../js/diff/index.js';

const bytes = (...xs) => Uint8Array.from(xs);
const twin = { bytes: bytes(1,2,3,4,5,6,7,8), cfg: { blocks:1, edges:0, exits:1 }, strings: ['same'], imports: [] };
const twinA = { ...twin, address: 0x1000n };
const twinB = { ...twin, address: 0x2000n };
const twinTarget = { ...twin, address: 0x3000n };
const twinExtra = { ...twin, address: 0x4000n };
const addrs = (list) => (list || []).map((fp) => String(fp.address)).sort();

function loserOf(matches, side) {
  const used = new Set(matches.map((m) => String(m[side].address)));
  const pool = side === 'before' ? [twinA, twinB] : [twinTarget, twinExtra];
  const missing = pool.filter((fp) => !used.has(String(fp.address)));
  assert.equal(missing.length, 1, 'exactly one competitor must be unmatched');
  return missing[0];
}

// 2-before/1-after collision: the matcher must not hide per-match ambiguity
// behind `ambiguous = truncated`.
{
  const r = matchFunctions([twinA, twinB], [twinTarget], { threshold: 0.5 });
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].ambiguous, true);
  assert.equal(r.matches[0].candidates.length >= 1, true);
  assert.equal(r.truncated, false);
  assert.equal(r.matching.candidateGraphIncomplete, false);
  assert.equal(r.matching.truncatedComponents.length, 0);
  assert.equal(r.ambiguous, true, 'an unresolved candidate collision is top-level ambiguity');
  assert.deepEqual(addrs(r.unresolvedBefore), [String(loserOf(r.matches, 'before').address)]);
  assert.deepEqual(addrs(r.unresolvedAfter), []);
  assert.equal(r.unresolvedBefore.includes(r.matches[0].before), false, 'the selected member is not itself unresolved');
}

// The diff projection must not mint the losing competitor as deleted confidence 1.
{
  const r = matchFunctions([twinA, twinB], [twinTarget], { threshold: 0.5 });
  const loser = loserOf(r.matches, 'before');
  const d = diffFunctions([twinA, twinB], [twinTarget], { threshold: 0.5 });
  assert.equal(d.ambiguous, true);
  assert.equal(d.complete, false, 'a live candidate collision is not a complete diff');
  assert.equal(d.truncated, false);
  assert.deepEqual(addrs(d.deleted.map((x) => x.before)), []);
  assert.equal(d.unresolved.length, 1);
  assert.equal(d.unresolved[0].side, 'before');
  assert.equal(d.unresolved[0].status, 'unresolved');
  assert.equal(d.unresolved[0].changeType, 'unresolved');
  assert.equal(d.unresolved[0].confidence, 0);
  assert.equal(String(d.unresolved[0].before.address), String(loser.address));
  assert.equal(d.matches.length, 1);
  assert.equal(d.matches[0].ambiguous, true, 'collision evidence survives the projection');
  assert.equal(d.matches[0].candidates.length >= 1, true);
  assert.equal(d.changes.length, 2);
}

// 1-before/2-after collision: the losing after side must not become new confidence 1.
{
  const r = matchFunctions([twinA], [twinTarget, twinExtra], { threshold: 0.5 });
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].ambiguous, true);
  assert.equal(r.ambiguous, true);
  assert.equal(r.truncated, false);
  const loser = loserOf(r.matches, 'after');
  assert.deepEqual(addrs(r.unresolvedAfter), [String(loser.address)]);
  assert.deepEqual(addrs(r.unresolvedBefore), []);
  const d = diffFunctions([twinA], [twinTarget, twinExtra], { threshold: 0.5 });
  assert.equal(d.complete, false);
  assert.equal(d.ambiguous, true);
  assert.deepEqual(addrs(d.new.map((x) => x.after)), []);
  assert.equal(d.unresolved.length, 1);
  assert.equal(d.unresolved[0].side, 'after');
  assert.equal(d.unresolved[0].confidence, 0);
  assert.equal(String(d.unresolved[0].after.address), String(loser.address));
}

// Only ambiguity-affected members are demoted: an uncontested unmatched
// function keeps its definitive deletion on the same graph.
const nearBase = { architecture:'arm64', cfg:{ blocks:3, edges:2, exits:1 }, strings:['coins','session'], imports:['memcpy'], calls:['helper'], constants:[100,200] };
const nearI = ['mov x0,x1','add x0,x0,#1','cmp x0,#2','b.eq #8','ret'];
const nearAlt = ['mov x5,x6','add x0,x0,#1','cmp x0,#2','b.eq #8','ret'];
const contestedA = { ...nearBase, address: 0x5000n, size: 20, bytes: null, instructions: nearI };
const contestedB = { ...nearBase, address: 0x6000n, size: 20, bytes: null, instructions: nearAlt };
const contestedTarget = { ...nearBase, address: 0x7000n, size: 20, bytes: null, instructions: nearI };
const unrelated = {
  address: 0x8000n, architecture:'arm64', size: 64,
  bytes: Uint8Array.from({ length:64 }, (_x,i) => (i*71+13)&255),
  cfg: { blocks:9, edges:8, exits:2 }, strings:['totally-different-widget'], imports:[], calls:[], constants:[7,7,7],
};
{
  const wide = diffFunctions([contestedA, contestedB, unrelated], [contestedTarget], { threshold: 0.55, ambiguityWindow: 0.5 });
  assert.equal(wide.complete, false);
  assert.equal(wide.ambiguous, true);
  assert.equal(wide.unresolved.length, 1, 'only the contested member is unresolved');
  assert.equal(String(wide.unresolved[0].before.address), '24576');
  assert.deepEqual(addrs(wide.deleted.map((x) => x.before)), ['32768']);
  assert.equal(wide.deleted[0].confidence, 1, 'an uncontested absence remains definitive');

  const narrow = diffFunctions([contestedA, contestedB, unrelated], [contestedTarget], { threshold: 0.55, ambiguityWindow: 0.04 });
  assert.equal(narrow.matches[0].ambiguous, false, 'a competitor outside the ambiguity window is not a collision');
  assert.equal(narrow.complete, true);
  assert.equal(narrow.ambiguous, false);
  assert.deepEqual(addrs(narrow.new.map((x) => x.after)), []);
  assert.deepEqual(addrs(narrow.deleted.map((x) => x.before)), ['24576','32768']);
  assert.equal(narrow.unresolved.length, 0);
}

// A complete graph without any collision still mints deleted/new.
{
  const kept = { ...twin, address: 0x9000n };
  const d = diffFunctions([kept, unrelated], [kept], { threshold: 0.55 });
  assert.equal(d.complete, true);
  assert.equal(d.ambiguous, false);
  assert.equal(d.matches.length, 1);
  assert.equal(d.matches[0].ambiguous, false);
  assert.deepEqual(addrs(d.deleted.map((x) => x.before)), ['32768']);
  assert.equal(d.deleted[0].confidence, 1);
  assert.equal(d.new.length, 0);
  assert.equal(d.unresolved.length, 0);
  const both = diffFunctions([unrelated], [], { threshold: 0.95 });
  assert.equal(both.complete, true);
  assert.equal(both.deleted.length, 1);
  const empty = diffFunctions([], [unrelated], { threshold: 0.95 });
  assert.equal(empty.complete, true);
  assert.equal(empty.new.length, 1);
  assert.equal(empty.new[0].confidence, 1);
}

// Budget truncation keeps its existing conservative behavior.
{
  const before = Array.from({ length:4 }, (_x,i) => ({ ...twin, address: 0x10000n + BigInt(i*0x20) }));
  const after = Array.from({ length:4 }, (_x,i) => ({ ...twin, address: 0x20000n + BigInt(i*0x20) }));
  const graph = diffFunctions(before, after, {
    maxCandidates:4, maxBucketScan:4,
    matchBudget: { maxCandidateEvaluations:1, maxCandidateEdges:32, maxWallMs:10_000 },
  });
  assert.equal(graph.complete, false);
  assert.equal(graph.ambiguous, true);
  assert.equal(graph.matching.candidateGraphIncomplete, true);
  assert.equal(graph.deleted.length, 0);
  assert.equal(graph.new.length, 0);
  assert.equal(graph.unresolved.length, 8);
  assert.ok(graph.unresolved.every((x) => x.confidence === 0 && x.status === 'unresolved'));

  const component = diffFunctions(before, after, {
    maxCandidates:4, maxBucketScan:4,
    matchBudget: { maxCandidateEvaluations:100, maxCandidateEdges:100, maxComponentNodes:4, maxComponentEdges:100, maxWallMs:10_000 },
  });
  assert.equal(component.complete, false);
  assert.ok(component.matching.truncatedComponents.some((x) => x.reason === 'component-budget'));
  assert.equal(component.deleted.length, 0);
  assert.equal(component.new.length, 0);
  assert.equal(component.unresolved.length, 8);
}

// The diff-level ambiguity flag stays consistent with the metric that already
// excludes ambiguous matches from recognition scoring.
{
  const collision = matchFunctions([twinA, twinB], [twinTarget], { threshold: 0.5 });
  const collisionMetrics = recognitionMetrics([[0x1000n, 0x3000n], [0x2000n, 0x3000n]], collision);
  assert.equal(collisionMetrics.ambiguousRate, 1);
  assert.equal(collisionMetrics.truePositive, 0);
  assert.equal(collisionMetrics.falsePositive, 0);
  assert.equal(collision.ambiguous, true);

  const clean = matchFunctions([contestedA], [contestedTarget], { threshold: 0.55, ambiguityWindow: 0.04 });
  const cleanMetrics = recognitionMetrics([[0x5000n, 0x7000n]], clean);
  assert.equal(cleanMetrics.ambiguousRate, 0);
  assert.equal(cleanMetrics.truePositive, 1);
  assert.equal(clean.ambiguous, false);
  assert.equal(clean.unresolvedBefore.length, 0);
  assert.equal(clean.unresolvedAfter.length, 0);
}

console.log('issue #5212 matcher collision ambiguity: PASS');
