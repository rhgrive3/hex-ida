import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  prioritizeDeobfCandidates,
  createAutoAnalysisQueue,
} from '../js/analysis/deobf/auto-analysis-queue.js';
import { AUTO_ANALYSIS_STATUS } from '../js/analysis/common/v6-auto-contracts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = path.resolve(__dirname, '../js/analysis/deobf/auto-analysis-queue.js');

describe('Track 3: auto-analysis-queue', () => {
  it('enforces INV-005 (no imports from js/targets/architecture/, js/targets/abi/, or js/semantics/)', () => {
    const src = fs.readFileSync(QUEUE_PATH, 'utf8');
    const importSpecifiers = [
      ...src.matchAll(/(?:import|export)\s+[^'"]*?from\s+['"]([^'"]+)['"]/g),
      ...src.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);
    assert.deepEqual(importSpecifiers, ['../common/v6-auto-contracts.js']);
    for (const spec of importSpecifiers) {
      assert.equal(/targets\/architecture/.test(spec), false);
      assert.equal(/targets\/abi/.test(spec), false);
      assert.equal(/semantics/.test(spec), false);
    }
  });

  describe('prioritizeDeobfCandidates', () => {
    it('computes priorityScore from all signals, saturates at 1000, deduplicates, sorts deterministically, and respects maxFunctions', () => {
      const candidates = [
        { va: 0x1000n, name: 'plain', blockCount: 4, size: 128 },
        { va: '0x2000', name: '_Z3foov', isEntry: true, tags: ['cff', 'crypto'], blockCount: 20, size: 1024, jumpTableCount: 2 },
        { va: 0x3000, tags: ['high_entropy'], blockCount: 16, size: 512, isCxx: true },
        { va: '0x4000', priorityScore: 990, isEntry: true }, // 990 + 40 -> saturated to 1000
        { va: '0x1000', name: 'dup_higher', tags: ['mba'] }, // duplicate of 0x1000 with higher score (30 vs 0)
        { va: 'not_a_va', isEntry: true }, // invalid va skipped
        null,
      ];

      const ranked = prioritizeDeobfCandidates(candidates);
      assert.equal(ranked.length, 4);

      // 0x4000: 990 + 40 = 1000 (saturated)
      assert.equal(ranked[0].vaHex, '0x4000');
      assert.equal(ranked[0].priorityScore, 1000);

      // 0x2000: isEntry(40) + tags(30) + blockCount>=16(20) + size>=512(15) + jumpTable>0(10) + mangled(10) = 125
      assert.equal(ranked[1].vaHex, '0x2000');
      assert.equal(ranked[1].priorityScore, 125);

      // 0x3000: tags(30) + blockCount>=16(20) + size>=512(15) + isCxx(10) = 75
      assert.equal(ranked[2].vaHex, '0x3000');
      assert.equal(ranked[2].priorityScore, 75);

      // 0x1000: deduplicated, kept higher-scoring entry (tags: ['mba'] -> 30)
      assert.equal(ranked[3].vaHex, '0x1000');
      assert.equal(ranked[3].priorityScore, 30);
      assert.equal(ranked[3].name, 'dup_higher');

      // Respects maxFunctions cap
      const capped = prioritizeDeobfCandidates(candidates, { maxFunctions: 2 });
      assert.deepEqual(capped.map((c) => c.vaHex), ['0x4000', '0x2000']);

      // Tie-break by VA ascending
      const tied = prioritizeDeobfCandidates([
        { va: 0x5000n, tags: ['obfuscated'] },
        { va: 0x1000n, tags: ['obfuscated'] },
        { va: 0x3000n, tags: ['obfuscated'] },
      ]);
      assert.deepEqual(tied.map((c) => c.vaHex), ['0x1000', '0x3000', '0x5000']);
    });

    it('guards against non-finite and negative priorityScore / maxFunctions', () => {
      const ranked = prioritizeDeobfCandidates([
        { va: 0x1000, priorityScore: Infinity },
        { va: 0x2000, priorityScore: NaN },
        { va: 0x3000, priorityScore: -50 },
      ], { maxFunctions: NaN });

      assert.equal(ranked.length, 3);
      for (const item of ranked) {
        assert.equal(Number.isFinite(item.priorityScore), true);
        assert.equal(item.priorityScore, 0);
      }

      assert.deepEqual(prioritizeDeobfCandidates([{ va: 0x1000 }], { maxFunctions: 0 }), []);
      assert.deepEqual(prioritizeDeobfCandidates([], { maxFunctions: 10 }), []);
    });
  });

  describe('createAutoAnalysisQueue run contract', () => {
    it('returns SKIPPED when candidates are empty or both analyzers are omitted', async () => {
      const progressEvents = [];

      // Both analyzers uninjected
      const noRunners = createAutoAnalysisQueue();
      const r1 = await noRunners.run({
        candidates: [{ va: 0x1000, cfg: { blocks: [] } }],
        onProgress: (ev) => progressEvents.push(ev),
      });
      assert.equal(r1.status, AUTO_ANALYSIS_STATUS.SKIPPED);
      assert.equal(r1.processed, 0);
      assert.equal(r1.deobfHits, 0);
      assert.equal(r1.stlHits, 0);
      assert.equal(r1.skipped, 0);
      assert.deepEqual(r1.errors, []);
      assert.equal(progressEvents[progressEvents.length - 1].status, AUTO_ANALYSIS_STATUS.SKIPPED);

      // Empty candidates
      const withRunner = createAutoAnalysisQueue({
        runDeobfuscationPass: () => ({ cffRecovered: true }),
      });
      const r2 = await withRunner.run({ candidates: [] });
      assert.equal(r2.status, AUTO_ANALYSIS_STATUS.SKIPPED);
      assert.equal(r2.processed, 0);
    });

    it('lazily fetches input via loadCandidateInput and early-skips { cfg: null, mbaNodes: [], stlInput: null }', async () => {
      const loadedVas = [];
      const deobfCalls = [];
      const stlCalls = [];
      const results = [];

      const queue = createAutoAnalysisQueue({
        runDeobfuscationPass: (arg) => {
          deobfCalls.push(arg);
          return { cffRecovered: true };
        },
        recognizeStlPattern: (arg) => {
          stlCalls.push(arg);
          return { recognized: true, primary: { kind: 'std::vector' } };
        },
        yieldFn: async () => {},
      });

      const summary = await queue.run({
        candidates: [
          { va: 0x1000, isEntry: true }, // priority 40 -> empty mbaNodes: [] -> early skip
          { va: 0x2000, tags: ['cff'] }, // priority 30 -> null input -> early skip
          { va: 0x3000 }, // priority 0 -> valid cfg + stlInput -> processed
        ],
        loadCandidateInput: async (cand) => {
          loadedVas.push(cand.vaHex);
          if (cand.vaHex === '0x1000') {
            return { cfg: null, mbaNodes: [], stlInput: null };
          }
          if (cand.vaHex === '0x2000') {
            return null;
          }
          return {
            cfg: { entryBlock: 'b0', blocks: [{ id: 'b0', insts: [], succs: [] }] },
            mbaNodes: [],
            stlInput: { symbols: ['std::vector<int>::push_back'] },
          };
        },
        onResult: (r) => results.push(r),
      });

      assert.equal(summary.status, AUTO_ANALYSIS_STATUS.DONE);
      assert.deepEqual(loadedVas, ['0x1000', '0x2000', '0x3000']);
      assert.equal(deobfCalls.length, 1);
      assert.equal(deobfCalls[0].funcVa, '0x3000');
      assert.equal(deobfCalls[0].mbaNodes, null);
      assert.equal(stlCalls.length, 1);
      assert.equal(summary.processed, 1);
      assert.equal(summary.skipped, 2);
      assert.equal(summary.deobfHits, 1);
      assert.equal(summary.stlHits, 1);
      assert.equal(results.length, 1);
    });

    it('passes commit: false to both analyzers so no side effects occur before onResult', async () => {
      let seenDeobfArg = null;
      let seenStlArg = null;
      const committedStore = [];

      const queue = createAutoAnalysisQueue({
        runDeobfuscationPass: (arg) => {
          seenDeobfArg = arg;
          // Respect commit: false -> do NOT mutate committedStore here
          if (arg.commit !== false && arg.opts?.commit !== false) {
            committedStore.push('unexpected_deobf_mutation');
          }
          return { cffRecovered: true };
        },
        recognizeStlPattern: (arg) => {
          seenStlArg = arg;
          if (arg.commit !== false) {
            committedStore.push('unexpected_stl_mutation');
          }
          return { recognized: true };
        },
        yieldFn: async () => {},
      });

      const summary = await queue.run({
        candidates: [{ va: 0x4000 }],
        loadCandidateInput: async () => ({
          cfg: { blocks: [{ id: 'b0' }] },
          stlInput: { commit: true, symbols: ['std::string'] }, // attempt to override commit must be ignored
        }),
        onResult: (r) => committedStore.push(r.vaHex),
      });

      assert.equal(summary.status, AUTO_ANALYSIS_STATUS.DONE);
      assert.equal(seenDeobfArg.commit, false);
      assert.equal(seenDeobfArg.opts.commit, false);
      assert.equal(seenStlArg.commit, false);
      assert.deepEqual(committedStore, ['0x4000']);
    });

    it('evaluates deobfHit (all 4 triggers) and stlHit (strictly recognized === true)', async () => {
      const deobfResponses = new Map([
        ['0x1000', { cffRecovered: true }],
        ['0x2000', { cffRecovered: false, mba: { simplifiedCount: 2 } }],
        ['0x3000', { cffRecovered: false, overlayCount: 1 }],
        ['0x4000', { cffRecovered: false, pendingAnnotations: [{ insnVa: '0x4004' }] }],
        ['0x5000', { cffRecovered: false, mba: { simplifiedCount: 0 }, overlayCount: 0, pendingAnnotations: [] }],
      ]);
      const stlResponses = new Map([
        ['0x1000', { recognized: true }],
        ['0x2000', { recognized: false }],
        ['0x3000', { recognized: 'truthy_non_boolean' }],
        ['0x4000', null],
        ['0x5000', { recognized: true }],
      ]);

      const received = [];
      const queue = createAutoAnalysisQueue({
        runDeobfuscationPass: ({ funcVa }) => deobfResponses.get(funcVa),
        recognizeStlPattern: ({ funcVa }) => stlResponses.get(funcVa),
        yieldFn: async () => {},
      });

      const summary = await queue.run({
        candidates: [
          { va: 0x1000 },
          { va: 0x2000 },
          { va: 0x3000 },
          { va: 0x4000 },
          { va: 0x5000 },
        ],
        loadCandidateInput: async () => ({
          cfg: { blocks: [{ id: 'b0' }] },
          stlInput: { symbols: ['x'] },
        }),
        onResult: (r) => received.push({ vaHex: r.vaHex, deobfHit: r.deobfHit, stlHit: r.stlHit }),
      });

      assert.equal(summary.status, AUTO_ANALYSIS_STATUS.DONE);
      assert.equal(summary.processed, 5);
      assert.equal(summary.deobfHits, 4);
      assert.equal(summary.stlHits, 2);
      assert.deepEqual(received, [
        { vaHex: '0x1000', deobfHit: true, stlHit: true },
        { vaHex: '0x2000', deobfHit: true, stlHit: false },
        { vaHex: '0x3000', deobfHit: true, stlHit: false },
        { vaHex: '0x4000', deobfHit: true, stlHit: false },
        { vaHex: '0x5000', deobfHit: false, stlHit: true },
      ]);
    });

    it('follows memory estimation precedence (estimator -> input.estimatedBytes -> candidate.estimatedBytes -> heuristic) and guards Infinity/NaN/negative', async () => {
      const orderLog = [];
      const estimatorReturn = 600;

      // 1. Precedence: estimator overrides input.estimatedBytes and candidate.estimatedBytes
      const q1 = createAutoAnalysisQueue({
        runDeobfuscationPass: ({ funcVa }) => {
          orderLog.push(`run:${funcVa}`);
          return { cffRecovered: true };
        },
        maxMemoryBytes: 1000,
        estimateMemoryBytes: (cand, input) => {
          orderLog.push(`est:${cand.vaHex}:${input?.estimatedBytes ?? 'none'}`);
          return estimatorReturn;
        },
        yieldFn: async () => {},
      });

      const r1 = await q1.run({
        candidates: [
          { va: 0x1000, estimatedBytes: 50 },
          { va: 0x2000, estimatedBytes: 50 },
        ],
        loadCandidateInput: async (cand) => {
          orderLog.push(`load:${cand.vaHex}`);
          return { cfg: { blocks: [{ id: 'b0' }] }, estimatedBytes: 100 };
        },
      });
      assert.equal(r1.status, AUTO_ANALYSIS_STATUS.MEMORY_LIMIT);
      assert.equal(r1.processed, 1);
      // Verify load happens before estimate, and estimate happens before run
      assert.deepEqual(orderLog, [
        'load:0x1000',
        'est:0x1000:100',
        'run:0x1000',
        'load:0x2000',
        'est:0x2000:100',
      ]);

      // 2. Non-finite / negative values from estimator and input.estimatedBytes fall through safely
      const badValues = [Infinity, -Infinity, NaN, -500];
      for (const bad of badValues) {
        const qBad = createAutoAnalysisQueue({
          runDeobfuscationPass: () => ({ cffRecovered: true }),
          maxMemoryBytes: 5000,
          estimateMemoryBytes: () => bad,
          yieldFn: async () => {},
        });
        const res = await qBad.run({
          candidates: [
            { va: 0x1000, estimatedBytes: 2000 },
            { va: 0x2000, estimatedBytes: 2000 },
            { va: 0x3000, estimatedBytes: 2000 },
          ],
          loadCandidateInput: async () => ({
            cfg: { blocks: [{ id: 'b0' }] },
            estimatedBytes: bad,
          }),
        });
        // Falls back to candidate.estimatedBytes = 2000 -> 2000 + 2000 <= 5000 (2 processed), 3rd hits 6000 > 5000 -> MEMORY_LIMIT
        assert.equal(res.status, AUTO_ANALYSIS_STATUS.MEMORY_LIMIT, `failed for bad value ${String(bad)}`);
        assert.equal(res.processed, 2, `expected 2 processed for bad value ${String(bad)}`);
      }

      // 3. Invalid config limits (Infinity / NaN / negative) fall back to safe defaults
      const qBadLimits = createAutoAnalysisQueue({
        runDeobfuscationPass: () => ({ cffRecovered: true }),
        maxBudgetMs: NaN,
        maxMemoryBytes: -1,
        maxFunctions: Infinity,
        yieldFn: async () => {},
      });
      const rBadLimits = await qBadLimits.run({
        candidates: [{ va: 0x1000, cfg: { blocks: [{ id: 'b0' }] } }],
      });
      assert.equal(rBadLimits.status, AUTO_ANALYSIS_STATUS.DONE);
      assert.equal(rBadLimits.processed, 1);
    });

    it('produces zero writebacks on BUDGET_EXHAUSTED, MEMORY_LIMIT, STALE, and ABORTED', async () => {
      // BUDGET_EXHAUSTED (0 writebacks when exhausted before/after load)
      let now = 1000;
      const budgetResults = [];
      const qBudget = createAutoAnalysisQueue({
        runDeobfuscationPass: () => ({ cffRecovered: true }),
        maxBudgetMs: 50,
        nowFn: () => now,
        yieldFn: async () => {},
      });
      const rBudget = await qBudget.run({
        candidates: [{ va: 0x1000 }],
        loadCandidateInput: async () => {
          now += 60; // exceed budget during load
          return { cfg: { blocks: [{ id: 'b0' }] } };
        },
        onResult: (r) => budgetResults.push(r),
      });
      assert.equal(rBudget.status, AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED);
      assert.equal(rBudget.processed, 0);
      assert.equal(budgetResults.length, 0);

      // MEMORY_LIMIT (0 writebacks when first item exceeds limit)
      const memResults = [];
      const qMem = createAutoAnalysisQueue({
        runDeobfuscationPass: () => ({ cffRecovered: true }),
        maxMemoryBytes: 512,
        yieldFn: async () => {},
      });
      const rMem = await qMem.run({
        candidates: [{ va: 0x1000 }],
        loadCandidateInput: async () => ({
          cfg: { blocks: [{ id: 'b0' }] },
          estimatedBytes: 1024,
        }),
        onResult: (r) => memResults.push(r),
      });
      assert.equal(rMem.status, AUTO_ANALYSIS_STATUS.MEMORY_LIMIT);
      assert.equal(rMem.processed, 0);
      assert.equal(memResults.length, 0);

      // STALE mid-run (generation bumps during runDeobfuscationPass -> 0 writebacks)
      let currentGen = 1;
      const staleResults = [];
      const qStale = createAutoAnalysisQueue({
        runDeobfuscationPass: async () => {
          currentGen = 2; // binary switched mid-pass
          return { cffRecovered: true };
        },
        recognizeStlPattern: async () => ({ recognized: true }),
        yieldFn: async () => {},
      });
      const rStale = await qStale.run({
        candidates: [{ va: 0x1000 }],
        generation: 1,
        getCurrentGeneration: () => currentGen,
        loadCandidateInput: async () => ({
          cfg: { blocks: [{ id: 'b0' }] },
          stlInput: { symbols: ['std::vector'] },
        }),
        onResult: (r) => staleResults.push(r),
      });
      assert.equal(rStale.status, AUTO_ANALYSIS_STATUS.STALE);
      assert.equal(rStale.processed, 0);
      assert.equal(rStale.deobfHits, 0);
      assert.equal(rStale.stlHits, 0);
      assert.equal(staleResults.length, 0);

      // ABORTED mid-run (signal aborts during recognizeStlPattern -> 0 writebacks)
      const controller = new AbortController();
      const abortResults = [];
      const qAbort = createAutoAnalysisQueue({
        runDeobfuscationPass: async () => ({ cffRecovered: true }),
        recognizeStlPattern: async () => {
          controller.abort();
          return { recognized: true };
        },
        yieldFn: async () => {},
      });
      const rAbort = await qAbort.run({
        candidates: [{ va: 0x1000 }],
        signal: controller.signal,
        loadCandidateInput: async () => ({
          cfg: { blocks: [{ id: 'b0' }] },
          stlInput: { symbols: ['std::vector'] },
        }),
        onResult: (r) => abortResults.push(r),
      });
      assert.equal(rAbort.status, AUTO_ANALYSIS_STATUS.ABORTED);
      assert.equal(rAbort.processed, 0);
      assert.equal(abortResults.length, 0);
    });

    it('isolates exceptions from loadCandidateInput, analyzers, estimator, yieldFn, onResult, and onProgress', async () => {
      const queue = createAutoAnalysisQueue({
        runDeobfuscationPass: async ({ funcVa }) => {
          if (funcVa === '0x2000') throw new Error('deobf_boom');
          return { cffRecovered: true };
        },
        recognizeStlPattern: async ({ funcVa }) => {
          if (funcVa === '0x3000') throw new Error('stl_boom');
          return { recognized: true };
        },
        estimateMemoryBytes: () => {
          throw new Error('estimator_boom');
        },
        yieldFn: async () => {
          throw new Error('yield_boom');
        },
      });

      const summary = await queue.run({
        candidates: [
          { va: 0x1000, isEntry: true }, // load throws
          { va: 0x2000, tags: ['cff'] }, // deobf throws, stl succeeds
          { va: 0x3000 }, // deobf succeeds, stl throws
        ],
        loadCandidateInput: async (cand) => {
          if (cand.vaHex === '0x1000') throw new Error('load_boom');
          return {
            cfg: { blocks: [{ id: 'b0' }] },
            stlInput: { symbols: ['std::map'] },
          };
        },
        onResult: () => {
          throw new Error('onResult_boom');
        },
        onProgress: () => {
          throw new Error('onProgress_boom');
        },
      });

      assert.equal(summary.status, AUTO_ANALYSIS_STATUS.DONE);
      assert.equal(summary.skipped, 1);
      assert.equal(summary.processed, 2);
      assert.equal(summary.deobfHits, 1);
      assert.equal(summary.stlHits, 1);
      assert.equal(summary.errors.length, 3);
      assert.deepEqual(
        summary.errors.map((e) => `${e.vaHex}:${e.stage}:${e.reason}`),
        [
          '0x1000:load:load_boom',
          '0x2000:deobf:deobf_boom',
          '0x3000:stl:stl_boom',
        ],
      );
    });
  });
});
