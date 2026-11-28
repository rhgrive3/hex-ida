import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTO_ANALYSIS_STATUS,
} from '../js/analysis/common/v6-auto-contracts.js';
import { lang, setLang } from '../js/i18n.js';
import {
  buildAutoAnalysisProgressModel,
  rankStarterFunctions,
} from '../js/ui/beginner/auto-analysis-guide.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUIDE_PATH = path.resolve(__dirname, '../js/ui/beginner/auto-analysis-guide.js');
const INITIAL_LANG = lang();

afterEach(() => {
  setLang(INITIAL_LANG);
});

describe('v6-beginner-auto-guide: architecture & boundary invariants', () => {
  it('does not import js/targets/architecture/ or js/semantics/', () => {
    const src = fs.readFileSync(GUIDE_PATH, 'utf8');
    assert.equal(/targets\/architecture/.test(src), false, 'must not import js/targets/architecture/');
    assert.equal(/\/semantics\//.test(src), false, 'must not import js/semantics/');
  });
});

describe('v6-beginner-auto-guide: buildAutoAnalysisProgressModel', () => {
  it('always returns a 3-element phases array in til, hexsig, deobf order', () => {
    const model = buildAutoAnalysisProgressModel(null);
    assert.equal(model.phases.length, 3);
    assert.deepEqual(model.phases.map((p) => p.id), ['til', 'hexsig', 'deobf']);
    assert.equal(model.overallStatus, AUTO_ANALYSIS_STATUS.IDLE);
    assert.equal(model.percent, 0);
    assert.equal(model.isComplete, false);
    assert.equal(typeof model.headline, 'string');
    assert.ok(model.headline.length > 0);
    assert.equal(typeof model.nextAction, 'string');
    assert.ok(model.nextAction.length > 0);
  });

  it('covers all 11 AUTO_ANALYSIS_STATUS values with exact priority ordering', () => {
    const S = AUTO_ANALYSIS_STATUS;
    const cases = [
      // All 11 statuses individually reachable as overallStatus
      {
        name: 'all IDLE -> IDLE',
        state: { til: { status: S.IDLE }, hexsig: { status: S.IDLE }, deobf: { status: S.IDLE } },
        expectedStatus: S.IDLE,
        expectedComplete: false,
        expectedPercent: 0,
      },
      {
        name: 'RUNNING beats ERROR/ABORTED/STALE',
        state: { til: { status: S.ERROR }, hexsig: { status: S.RUNNING }, deobf: { status: S.ABORTED } },
        expectedStatus: S.RUNNING,
        expectedComplete: false,
        expectedPercent: Math.round((100 + 50 + 100) / 3),
      },
      {
        name: 'ERROR beats ABORTED/STALE/IDLE/DONE',
        state: { til: { status: S.ERROR }, hexsig: { status: S.ABORTED }, deobf: { status: S.STALE } },
        expectedStatus: S.ERROR,
        expectedComplete: true,
        expectedPercent: 100,
      },
      {
        name: 'ABORTED beats STALE/DONE',
        state: { til: { status: S.ABORTED }, hexsig: { status: S.STALE }, deobf: { status: S.DONE } },
        expectedStatus: S.ABORTED,
        expectedComplete: true,
        expectedPercent: 100,
      },
      {
        name: 'STALE beats DONE/IDLE',
        state: { til: { status: S.STALE }, hexsig: { status: S.DONE }, deobf: { status: S.IDLE } },
        expectedStatus: S.STALE,
        expectedComplete: false,
        expectedPercent: Math.round((100 + 100 + 0) / 3),
      },
      {
        name: 'DONE + IDLE mix -> RUNNING and isComplete: false',
        state: { til: { status: S.DONE }, hexsig: { status: S.IDLE }, deobf: { status: S.IDLE } },
        expectedStatus: S.RUNNING,
        expectedComplete: false,
        expectedPercent: 33,
      },
      {
        name: 'DONE beats BUDGET_EXHAUSTED/MEMORY_LIMIT/OFFLINE/UNSUPPORTED_ARCH/SKIPPED',
        state: { til: { status: S.DONE }, hexsig: { status: S.BUDGET_EXHAUSTED }, deobf: { status: S.SKIPPED } },
        expectedStatus: S.DONE,
        expectedComplete: true,
        expectedPercent: 100,
      },
      {
        name: 'BUDGET_EXHAUSTED beats MEMORY_LIMIT/OFFLINE',
        state: { til: { status: S.BUDGET_EXHAUSTED }, hexsig: { status: S.MEMORY_LIMIT }, deobf: { status: S.OFFLINE } },
        expectedStatus: S.BUDGET_EXHAUSTED,
        expectedComplete: true,
        expectedPercent: 100,
      },
      {
        name: 'MEMORY_LIMIT beats OFFLINE/UNSUPPORTED_ARCH',
        state: { til: { status: S.MEMORY_LIMIT }, hexsig: { status: S.OFFLINE }, deobf: { status: S.UNSUPPORTED_ARCH } },
        expectedStatus: S.MEMORY_LIMIT,
        expectedComplete: true,
        expectedPercent: 100,
      },
      {
        name: 'OFFLINE beats UNSUPPORTED_ARCH/SKIPPED',
        state: { til: { status: S.OFFLINE }, hexsig: { status: S.UNSUPPORTED_ARCH }, deobf: { status: S.SKIPPED } },
        expectedStatus: S.OFFLINE,
        expectedComplete: true,
        expectedPercent: 100,
      },
      {
        name: 'UNSUPPORTED_ARCH beats SKIPPED',
        state: { til: { status: S.UNSUPPORTED_ARCH }, hexsig: { status: S.SKIPPED }, deobf: { status: S.SKIPPED } },
        expectedStatus: S.UNSUPPORTED_ARCH,
        expectedComplete: true,
        expectedPercent: 100,
      },
      {
        name: 'all SKIPPED -> SKIPPED',
        state: { til: { status: S.SKIPPED }, hexsig: { status: S.SKIPPED }, deobf: { status: S.SKIPPED } },
        expectedStatus: S.SKIPPED,
        expectedComplete: true,
        expectedPercent: 100,
      },
    ];

    const seenStatuses = new Set();
    for (const tc of cases) {
      const m = buildAutoAnalysisProgressModel(tc.state);
      seenStatuses.add(m.overallStatus);
      assert.equal(m.overallStatus, tc.expectedStatus, tc.name);
      assert.equal(m.isComplete, tc.expectedComplete, tc.name);
      assert.equal(m.percent, tc.expectedPercent, tc.name);
      assert.equal(m.phases.length, 3, tc.name);
      assert.ok(m.headline.length > 0, `${tc.name} headline`);
      assert.ok(m.nextAction.length > 0, `${tc.name} nextAction`);
    }
    assert.equal(seenStatuses.size, 11, 'all 11 AUTO_ANALYSIS_STATUS values must be covered');
  });

  it('computes RUNNING percent with and without completed/total bounds', () => {
    const S = AUTO_ANALYSIS_STATUS;

    // Without completed/total -> defaults to 50 for RUNNING
    const fallback = buildAutoAnalysisProgressModel({
      til: { status: S.DONE },
      hexsig: { status: S.RUNNING },
      deobf: { status: S.IDLE },
    });
    assert.equal(fallback.percent, Math.round((100 + 50 + 0) / 3)); // 50

    // With completed/total -> 0% clamps to 1, 100% clamps to 99
    const lowClamp = buildAutoAnalysisProgressModel({
      til: { status: S.RUNNING, completed: 0, total: 100 },
      hexsig: { status: S.IDLE },
      deobf: { status: S.IDLE },
    });
    assert.equal(lowClamp.percent, Math.round((1 + 0 + 0) / 3)); // 0
    assert.equal(lowClamp.phases[0].completed, 0);
    assert.equal(lowClamp.phases[0].total, 100);

    const highClamp = buildAutoAnalysisProgressModel({
      til: { status: S.DONE },
      hexsig: { status: S.DONE },
      deobf: { status: S.RUNNING, completed: 100, total: 100 },
    });
    assert.equal(highClamp.percent, Math.round((100 + 100 + 99) / 3)); // 100? Wait: 299/3 = 99.666 -> 100
    assert.equal(highClamp.isComplete, false);

    // Mid-progress: 25/100 = 25%, total = (100 + 25 + 0) / 3 = 41.67 -> 42
    const mid = buildAutoAnalysisProgressModel({
      til: { status: S.DONE },
      hexsig: { status: S.RUNNING, completed: 25, total: 100 },
      deobf: { status: S.IDLE },
    });
    assert.equal(mid.percent, 42);

    // Invalid total (0 or NaN) falls back to 50
    const badTotal = buildAutoAnalysisProgressModel({
      til: { status: S.RUNNING, completed: 5, total: 0 },
      hexsig: { status: S.RUNNING, completed: 5, total: Number.NaN },
      deobf: { status: S.RUNNING },
    });
    assert.equal(badTotal.percent, 50);
  });

  it('switches headline, nextAction, and phase labels between ja and en', () => {
    const state = {
      til: { status: AUTO_ANALYSIS_STATUS.DONE, loadedPacks: ['ios-sdk-core'] },
      hexsig: { status: AUTO_ANALYSIS_STATUS.DONE, named: 4 },
      deobf: { status: AUTO_ANALYSIS_STATUS.DONE, deobfHits: 1, stlHits: 2 },
    };

    setLang('ja');
    const jaModel = buildAutoAnalysisProgressModel(state);
    assert.match(jaModel.headline, /自動解析/);
    assert.match(jaModel.phases[0].label, /型ライブラリ/);
    assert.match(jaModel.phases[1].detail, /4/);

    setLang('en');
    const enModel = buildAutoAnalysisProgressModel(state);
    assert.match(enModel.headline, /Auto-analysis/i);
    assert.match(enModel.phases[0].label, /Type libraries/i);
    assert.match(enModel.phases[1].detail, /4/);
    assert.notEqual(jaModel.headline, enModel.headline);
    assert.notEqual(jaModel.nextAction, enModel.nextAction);
  });
});

describe('v6-beginner-auto-guide: rankStarterFunctions', () => {
  it('assigns exclusive 6 categories in strict priority order: entrypoint > crypto > obfuscated > rmw > library > app_logic', () => {
    const functions = [
      // All signals -> must pick entrypoint
      { va: 0x1000n, name: 'main', isEntry: true, tags: ['crypto', 'obfuscated', 'rmw', 'library'], size: 128 },
      // crypto + obfuscated + rmw + library -> must pick crypto
      { va: 0x2000n, name: 'sub_2000', tags: ['crypto', 'obfuscated', 'rmw', 'library'], size: 128 },
      // obfuscated + rmw + library -> must pick obfuscated
      { va: 0x3000n, name: 'sub_3000', tags: ['obfuscated', 'rmw', 'library'], size: 128 },
      // rmw + library -> must pick rmw
      { va: 0x4000n, name: 'sub_4000', tags: ['rmw', 'library'], size: 128 },
      // library only -> must pick library
      { va: 0x5000n, name: 'memcpy', isLibrary: true, size: 128 },
      // plain app function -> must pick app_logic
      { va: 0x6000n, name: 'compute_total', size: 128 },
    ];

    const ranked = rankStarterFunctions(functions, { limit: 10 });
    const byVa = new Map(ranked.map((r) => [r.vaHex, r]));

    assert.equal(byVa.get('0x1000')?.category, 'entrypoint');
    assert.equal(byVa.get('0x2000')?.category, 'crypto');
    assert.equal(byVa.get('0x3000')?.category, 'obfuscated');
    assert.equal(byVa.get('0x4000')?.category, 'rmw');
    assert.equal(byVa.get('0x5000')?.category, 'library');
    assert.equal(byVa.get('0x6000')?.category, 'app_logic');
  });

  it('computes additive scores, clamps negative raw scores to 0, and does not mis-bonus normal C main (demangledName === rawName)', () => {
    // 1. Additive score: crypto + obfuscated > crypto alone
    const additive = rankStarterFunctions([
      { va: 0x1000, name: 'aes_block', tags: ['crypto'], size: 128 },
      { va: 0x2000, name: 'aes_block_obf', tags: ['crypto', 'obfuscated'], size: 128 },
    ], { limit: 5 });
    assert.equal(additive[0].vaHex, '0x2000');
    assert.ok(additive[0].score > additive[1].score, 'multi-signal function must score higher');

    // 2. Normal C function main where demangledName === rawName must NOT get demangled bonus
    const mainWithSameDemangle = rankStarterFunctions(
      [{ va: 0x1000, name: 'main', size: 128 }],
      {
        enrichmentsByVa: {
          '0x1000': {
            rawName: 'main',
            displayName: 'main',
            demangledName: 'main',
          },
        },
      },
    );
    const mainWithoutDemangle = rankStarterFunctions(
      [{ va: 0x1000, name: 'main', size: 128 }],
      {
        enrichmentsByVa: {
          '0x1000': {
            rawName: 'main',
            displayName: 'main',
            demangledName: null,
          },
        },
      },
    );
    assert.equal(
      mainWithSameDemangle[0].score,
      mainWithoutDemangle[0].score,
      'normal C function with demangledName === rawName must not get demangled bonus',
    );

    // Truly demangled C++ function MUST get the demangled bonus
    const cppDemangled = rankStarterFunctions(
      [
        { va: 0x3000, name: 'process', size: 128 },
        { va: 0x3100, name: '_Z7processi', size: 128 },
      ],
      {
        enrichmentsByVa: {
          '0x3000': { rawName: 'process', displayName: 'process', demangledName: 'process' },
          '0x3100': { rawName: '_Z7processi', displayName: 'process(int)', demangledName: 'process(int)' },
        },
      },
    );
    assert.equal(cppDemangled[0].vaHex, '0x3100');
    assert.ok(cppDemangled[0].score > cppDemangled[1].score);

    // 3. Score floor at 0 (tiny stripped library stub cannot go negative)
    const floorRes = rankStarterFunctions([
      { va: 0x4000, name: 'sub_4000', isLibrary: true, size: 4 },
    ]);
    assert.equal(floorRes.length, 1);
    assert.equal(floorRes[0].category, 'library');
    assert.equal(floorRes[0].score, 0);
  });

  it('sorts deterministically by score descending then VA ascending', () => {
    const functions = [
      { va: 0x3000, name: 'sub_3000', size: 128 },
      { va: 0x1000, name: 'sub_1000', size: 128 },
      { va: 0x2000, name: 'sub_2000', size: 128 },
    ];
    const ranked = rankStarterFunctions(functions, { limit: 3 });
    assert.deepEqual(ranked.map((r) => r.vaHex), ['0x1000', '0x2000', '0x3000']);
  });

  it('supports both Map and plain object for enrichmentsByVa and switches reason language', () => {
    const functions = [
      { va: 0x1000n, name: 'sub_1000', size: 96 },
      { va: 0x2000n, name: 'sub_2000', size: 96 },
    ];

    const enrichmentMap = new Map([
      ['0X1000', {
        funcVa: '0x1000',
        rawName: 'sub_1000',
        displayName: 'sub_1000',
        deobfOverlay: { hasOverlay: true },
      }],
      [0x2000n, {
        funcVa: '0x2000',
        rawName: 'sub_2000',
        displayName: 'sub_2000',
        wasmHints: { rmwHitCount: 3 },
      }],
    ]);

    const enrichmentObj = {
      '0x1000': enrichmentMap.get('0X1000'),
      '0x2000': enrichmentMap.get(0x2000n),
    };

    setLang('ja');
    const fromMapJa = rankStarterFunctions(functions, { enrichmentsByVa: enrichmentMap });
    const fromObjJa = rankStarterFunctions(functions, { enrichmentsByVa: enrichmentObj });
    assert.deepEqual(fromMapJa, fromObjJa);
    assert.equal(fromMapJa[0].category, 'obfuscated');
    assert.equal(fromMapJa[1].category, 'rmw');
    assert.match(fromMapJa[0].reason, /難読化/);

    setLang('en');
    const fromMapEn = rankStarterFunctions(functions, { enrichmentsByVa: enrichmentMap });
    assert.match(fromMapEn[0].reason, /Obfuscation/i);
    assert.notEqual(fromMapJa[0].reason, fromMapEn[0].reason);
  });

  it('handles empty/invalid inputs and limit boundaries safely', () => {
    assert.deepEqual(rankStarterFunctions([]), []);
    assert.deepEqual(rankStarterFunctions(null), []);
    assert.deepEqual(rankStarterFunctions([{ va: 'not-an-addr', name: 'x' }]), []);
    assert.deepEqual(rankStarterFunctions([{ va: 0x1000, name: 'main' }], { limit: 0 }), []);
    assert.deepEqual(rankStarterFunctions([{ va: 0x1000, name: 'main' }], { limit: -3 }), []);
  });
});
