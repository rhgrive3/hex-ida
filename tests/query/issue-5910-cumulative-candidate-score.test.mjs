import assert from 'node:assert/strict';
import test from 'node:test';

import { planAnalysisGoal } from '../../js/query/planner.js';

const TARGET = 0x9000n;
const weakCandidates = Array.from({ length: 48 }, (_, index) => ({
  addr: 0x100000000n + BigInt(index * 0x10),
  source: 'recognition',
  score: 10,
}));

const query = {
  action: 'increase',
  entity: { terms: ['target'] },
  context: { terms: [] },
  event: { terms: [] },
  dataflow: { shape: 'read-modify-write' },
  expect: { calls: [] },
  confident: true,
};

const tools = {
  async search_functions() { return { results: [] }; },
  async search_strings() { return { results: [] }; },
  async get_xrefs() { return { functions: [] }; },
  async get_callers() { return { results: [] }; },
  async get_callees() { return { results: [] }; },
  async get_function(address) {
    return {
      address: BigInt(address),
      name: 'candidate',
      instructions: 1,
      summary: { calls: [] },
      cost: { functions: 1, disassembly: 1 },
    };
  },
  async get_semantic_facts() { return { results: [] }; },
  async verify_field_update() { return { verified: false, evidence: [] }; },
  async find_thresholds() { return { results: [] }; },
};

test('issue-5910: cumulative evidence admits a staged candidate over the weakest stored entry', async () => {
  const result = await planAnalysisGoal(query, {
    candidateFunctions: [
      ...weakCandidates,
      { addr: TARGET, source: 'recognition', score: 6 },
      { addr: TARGET, source: 'recognition', score: 6 },
    ],
  }, {
    tools,
    // Internal planner budget is 2, so the recognition source cap remains 48.
    maxFunctions: 2,
    maxDisassembly: 16,
    maxSearchResults: 8,
    maxExpansions: 0,
    timeoutMs: 1000,
  });

  assert.equal(result.candidateSources.stored.recognition, 48);
  assert.equal(result.candidateSources.supplied.recognition, 50);
  assert.equal(result.candidates[0]?.address, TARGET);
  assert.ok(result.candidates.some((candidate) => candidate.address === TARGET));
  assert.equal(result.candidates[0]?.score, 12);

  const stagedTarget = 0x9100n;
  const stagedResult = await planAnalysisGoal(query, {
    candidateFunctions: [
      ...weakCandidates,
      { addr: stagedTarget, source: 'recognition', score: 15 },
      ...Array.from({ length: 47 }, (_, index) => ({
        addr: 0x200000000n + BigInt(index * 0x10),
        source: 'recognition',
        score: 20,
      })),
      // This lower-scoring arrival must not evict the stronger staged entry.
      { addr: 0x9200n, source: 'recognition', score: 5 },
      { addr: stagedTarget, source: 'recognition', score: 10 },
    ],
  }, {
    tools,
    maxFunctions: 2,
    maxDisassembly: 16,
    maxSearchResults: 8,
    maxExpansions: 0,
    timeoutMs: 1000,
  });

  assert.equal(stagedResult.candidateSources.stored.recognition, 48);
  assert.ok(stagedResult.candidates.some((candidate) => candidate.address === stagedTarget));
  assert.equal(stagedResult.candidates.find((candidate) => candidate.address === stagedTarget)?.score, 25);
});

test('issue-5910: a full staged pool aggregates a candidate before top-k admission', async () => {
  const stored = Array.from({ length: 48 }, (_, index) => ({
    addr: 0xa0000000n + BigInt(index * 0x10),
    source: 'recognition',
    score: 100,
  }));
  const staged = Array.from({ length: 48 }, (_, index) => ({
    addr: 0xb0000000n + BigInt(index * 0x10),
    source: 'recognition',
    score: 45,
  }));
  const target = 0x9300n;
  const options = {
    tools,
    maxFunctions: 2,
    maxDisassembly: 16,
    maxSearchResults: 8,
    maxExpansions: 0,
    timeoutMs: 1000,
  };

  const ordered = await planAnalysisGoal(query, {
    candidateFunctions: [
      ...stored,
      ...staged,
      { addr: target, source: 'recognition', score: 40 },
      { addr: target, source: 'recognition', score: 40 },
      { addr: target, source: 'recognition', score: 40 },
    ],
  }, options);
  const orderedTarget = ordered.candidates.find((candidate) => candidate.address === target);
  assert.equal(ordered.candidateSources.stored.recognition, 48);
  assert.equal(orderedTarget?.score, 120,
    '40 + 40 + 40 must be aggregated before the full-pool top-k comparison');

  const permutedRows = [];
  for (let index = 0; index < 48; index++) {
    permutedRows.push(stored[index], staged[index]);
    if (index < 3) {
      permutedRows.push(
        { addr: target, source: 'recognition', score: 40 },
      );
    }
  }
  const permuted = await planAnalysisGoal(query, {
    candidateFunctions: permutedRows,
  }, options);
  const permutedTarget = permuted.candidates.find((candidate) => candidate.address === target);
  assert.equal(permuted.candidateSources.stored.recognition, 48);
  assert.equal(permutedTarget?.score, 120,
    'the same evidence multiset must be arrival-order invariant');

  const belowThreshold = await planAnalysisGoal(query, {
    candidateFunctions: [
      ...stored,
      ...staged,
      { addr: 0x9400n, source: 'recognition', score: 4 },
      { addr: 0x9400n, source: 'recognition', score: 4 },
    ],
  }, options);
  assert.equal(
    belowThreshold.candidates.some((candidate) => candidate.address === 0x9400n),
    false,
    'an aggregate below the weakest staged score must not promote',
  );
  assert.equal(belowThreshold.candidateSources.stored.recognition, 48);
});


function resultBatch(rows) {
  return { results: rows, complete: true, returned: rows.length, total: rows.length };
}

function chunks(rows, size = 8) {
  const out = [];
  for (let index = 0; index < rows.length; index += size) out.push(rows.slice(index, index + size));
  return out;
}

function paddedBatches(rows) {
  const out = chunks(rows);
  while (out.length < 16) out.push([]);
  return out.slice(0, 16);
}

function makeIncrementalTools(path, target, stored, staged, customBatches = null) {
  let functionCall = 0;
  let stringCall = 0;
  let xrefCall = 0;
  let callerCall = 0;
  let calleeCall = 0;
  const searchBatches = customBatches || [
    ...chunks(stored),
    ...chunks(staged),
    [{ addr: target }],
    [{ addr: target }],
    [{ addr: target }],
    [],
  ];
  const graphStored = Array.from({ length: 24 }, (_, index) => ({
    addr: 0xc0000000n + BigInt(index * 0x10),
  }));
  const graphStaged = Array.from({ length: 24 }, (_, index) => ({
    addr: 0xd0000000n + BigInt(index * 0x10),
  }));
  return {
    ...tools,
    async search_functions() {
      if (path === 'function') return resultBatch(searchBatches[functionCall++] || []);
      if (path === 'graph') {
        const rows = functionCall++ < 2 ? [{ addr: 0xe0000000n + BigInt(functionCall) }] : [];
        return resultBatch(rows);
      }
      return resultBatch([]);
    },
    async search_strings() {
      if (path === 'string') {
        return resultBatch((searchBatches[stringCall++] || []).map((row) => ({ functionAddress: row.addr })));
      }
      if (path === 'xref') return resultBatch([{ stringAddress: 0xf000n }]);
      return resultBatch([]);
    },
    async get_xrefs() {
      if (path !== 'xref') return { functions: [] };
      const rows = searchBatches[xrefCall++] || [];
      return {
        functions: rows,
        completeness: { complete: true, coverage: 1, returned: rows.length, total: rows.length },
      };
    },
    async get_callers() {
      if (path !== 'graph') return resultBatch([]);
      if (callerCall++ === 0) return resultBatch(graphStored.slice(0, 12));
      if (callerCall === 2) return resultBatch(graphStaged.slice(0, 12));
      return resultBatch([]);
    },
    async get_callees() {
      if (path !== 'graph') return resultBatch([]);
      if (calleeCall++ === 0) return resultBatch(graphStored.slice(12));
      return resultBatch([
        ...graphStaged.slice(12),
        { addr: target },
        { addr: target },
        { addr: target },
      ]);
    },
  };
}

const incrementalQuery = {
  ...query,
  entity: { terms: Array.from({ length: 16 }, (_, index) => `term-${index}`) },
  context: { terms: [] },
  event: { terms: [] },
};

function incrementalOptions(pathTools, maxExpansions = 0) {
  return {
    tools: pathTools,
    maxFunctions: 2,
    maxDisassembly: 16,
    maxSearchResults: 8,
    maxExpansions,
    timeoutMs: 1000,
  };
}

test('issue-5910: repeated incremental evidence is aggregated on every source path before admission', async () => {
  const stored = Array.from({ length: 48 }, (_, index) => ({
    addr: 0x50000000n + BigInt(index * 0x10),
  }));
  const staged = Array.from({ length: 48 }, (_, index) => ({
    addr: 0x60000000n + BigInt(index * 0x10),
  }));
  const target = 0x9700n;
  const expectedPool = {
    function: ['lexical', 48, 36],
    string: ['string', 48, 24],
    xref: ['string', 48, 30],
    graph: ['graph', 24, 3],
  };

  for (const path of Object.keys(expectedPool)) {
    const pathTarget = path === 'graph' ? target + 1n : target;
    const pathTools = makeIncrementalTools(path, pathTarget, stored, staged);
    const result = await planAnalysisGoal(
      incrementalQuery,
      {},
      incrementalOptions(pathTools, path === 'graph' ? 2 : 0),
    );
    const [pool, cap, score] = expectedPool[path];
    const candidate = result.candidates.find((row) => row.address === pathTarget);
    assert.ok(candidate, `${path}: repeated incremental evidence must survive a full pool`);
    assert.equal(result.candidateSources.stored[pool], cap, `${path}: existing cap must remain bounded`);
    assert.equal(candidate.sourcePoolScores[pool], score,
      `${path}: aggregate score must be compared atomically`);
  }
});

test('issue-5910: incremental evidence is permutation-invariant with an equal-threshold negative control', async () => {
  const stored = Array.from({ length: 48 }, (_, index) => ({
    addr: 0x70000000n + BigInt(index * 0x10),
  }));
  const staged = Array.from({ length: 48 }, (_, index) => ({
    addr: 0x80000000n + BigInt(index * 0x10),
  }));
  const target = 0x9800n;
  const orderedBatches = [
    ...chunks(stored),
    ...chunks(staged),
    [{ addr: target }],
    [{ addr: target }],
    [{ addr: target }],
    [],
  ];
  const ordered = await planAnalysisGoal(incrementalQuery, {}, incrementalOptions(
    makeIncrementalTools('function', target, stored, staged, orderedBatches),
  ));
  const orderedTarget = ordered.candidates.find((row) => row.address === target);
  assert.equal(orderedTarget?.sourcePoolScores.lexical, 36);

  const permutedRows = [];
  for (let index = 0; index < stored.length; index++) {
    permutedRows.push(stored[index]);
    if (index === 0) permutedRows.push({ addr: target });
    permutedRows.push(staged[index]);
    if (index === 24) permutedRows.push({ addr: target });
  }
  permutedRows.push({ addr: target });
  const permuted = await planAnalysisGoal(incrementalQuery, {}, incrementalOptions(
    makeIncrementalTools('function', target, stored, staged, paddedBatches(permutedRows)),
  ));
  const permutedTarget = permuted.candidates.find((row) => row.address === target);
  assert.equal(permutedTarget?.sourcePoolScores.lexical, 36,
    'the same incremental evidence multiset must be arrival-order invariant');

  const negative = await planAnalysisGoal(incrementalQuery, {}, incrementalOptions(
    makeIncrementalTools(
      'function',
      0x9900n,
      stored,
      staged,
      paddedBatches([...stored, ...staged, { addr: 0x9900n }]),
    ),
  ));
  assert.equal(
    negative.candidates.some((row) => row.address === 0x9900n),
    false,
    'a single equal-to-weakest incremental fragment must remain rejected',
  );

});

test('issue-5910: hostile-sized prior input does not grow retained pool state', async () => {
  const hugePrior = Array.from({ length: 10000 }, (_, index) => ({
    addr: 0x1000000000n + BigInt(index),
    source: 'recognition',
    score: 10,
  }));

  const result = await planAnalysisGoal(query, {
    candidateFunctions: hugePrior,
  }, {
    tools,
    maxFunctions: 2,
    maxDisassembly: 16,
    maxSearchResults: 8,
    maxExpansions: 0,
    timeoutMs: 1000,
  });

  assert.equal(result.candidateSources.supplied.recognition, hugePrior.length);
  assert.equal(result.candidateSources.stored.recognition, 48);
  assert.equal(result.candidateSources.retainedBound.recognition, 144);
  assert.ok(result.candidateSources.stored.recognition <= result.candidateSources.retainedBound.recognition);
  assert.equal(result.completeness.candidateSourceCoverage, 48 / hugePrior.length);
});
