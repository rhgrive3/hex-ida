import assert from 'node:assert/strict';
import test from 'node:test';
import { loaderProducer } from '../../../js/analysis/discovery/producers.js';
import { fuseFunctionCandidates } from '../../../js/analysis/discovery/fusion.js';

// Faithful stand-in for the loader seeds the parser/model emits for
// LC_FUNCTION_STARTS after #2409: an exact start whose body is only the
// heuristic distance to the next start (extentSource / extentConfidence /
// extentInferred carried on the seed). This is the loader -> discovery
// boundary where #8846 re-mints an exact extent from a proven start.
function seedAddress(seed) { return BigInt(seed.address); }

function discover(seed) {
  const evidence = loaderProducer.produce({ image: { functions: [seed], unwindEntries: [] } });
  const { candidates } = fuseFunctionCandidates(evidence, { snapshotId: 'issue-8846' });
  const candidate = candidates.find((item) => BigInt(item.start) === seedAddress(seed));
  return { evidence, candidate };
}

test('#8846: an inferred next-function-start extent is not laundered into exact', () => {
  const { candidate } = discover({
    address: '0x1100', end: '0x1200',
    source: 'function_starts', exactFunctionStart: true, exactFunctionStartConfidence: 1,
    extentSource: 'next-function-start', extentConfidence: 0.35, extentInferred: true,
  });
  assert.equal(candidate.startState, 'exact', 'the exact start remains authoritative');
  assert.notEqual(candidate.extentState, 'exact', 'a proven start must not authorize an inferred extent');
  assert.equal(candidate.extentState, 'heuristic');
});

test('#8846: a sub-threshold extent confidence is treated as inferred', () => {
  const { candidate } = discover({
    address: '0x1100', sizeBytes: 0x100,
    source: 'function_starts', exactFunctionStart: true, exactFunctionStartConfidence: 1,
    extentConfidence: 0.5,
  });
  assert.equal(candidate.startState, 'exact');
  assert.equal(candidate.extentState, 'heuristic', 'low-confidence extent cannot become exact');
});

test('#8846: extentInferred wins even when a start is high confidence', () => {
  const { candidate } = discover({
    address: '0x1100', end: '0x1200',
    source: 'function_starts', exactFunctionStart: true, exactFunctionStartConfidence: 1,
    extentInferred: true, extentConfidence: 1,
  });
  assert.equal(candidate.extentState, 'heuristic');
});

test('#8846: a validated extent source (unwind) still yields an exact extent', () => {
  const { candidate } = discover({
    address: '0x1100', end: '0x1140',
    source: 'unwind', exactFunctionStart: true, exactFunctionStartConfidence: 1,
    extentSource: 'unwind', extentConfidence: 1, extentInferred: false,
  });
  assert.equal(candidate.startState, 'exact');
  assert.equal(candidate.extentState, 'exact', 'an independently validated extent remains exact');
  assert.deepEqual(candidate.regions.map((region) => [region.start, region.end]), [['4352', '4416']]);
});

test('#8846: an explicit seed size with no inference marker is unchanged (backward compatible)', () => {
  const { candidate } = discover({
    address: '0x1100', sizeBytes: 0x140,
    source: 'symbol', exactFunctionStart: true, exactFunctionStartConfidence: 1,
  });
  assert.equal(candidate.extentState, 'exact', 'a genuine declared size stays authoritative');
});

test('#8846: the split keeps the start item region-free and adds a corroborating extent item', () => {
  const { evidence } = discover({
    address: '0x1100', end: '0x1200',
    source: 'function_starts', exactFunctionStart: true, exactFunctionStartConfidence: 1,
    extentSource: 'next-function-start', extentConfidence: 0.35, extentInferred: true,
  });
  const startItem = evidence.find((item) => item.kind === 'loader-function-start');
  const extentItem = evidence.find((item) => item.kind === 'loader-function-extent');
  assert.equal(startItem.authority, 'authoritative');
  assert.deepEqual(startItem.regions, [], 'the authoritative start carries no region for an inferred extent');
  assert.equal(extentItem.authority, 'corroborating', 'the inferred body is corroborating, never authoritative');
});

test('#8846: the authoritative start alone (no extent) still establishes an exact start with unknown extent', () => {
  const { candidate } = discover({
    address: '0x1100',
    source: 'function_starts', exactFunctionStart: true, exactFunctionStartConfidence: 1,
  });
  assert.equal(candidate.startState, 'exact');
  assert.equal(candidate.extentState, 'unknown', 'start authority is independent of extent authority');
});
