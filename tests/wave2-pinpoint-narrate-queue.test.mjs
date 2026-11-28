import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { __guardedAnalyzeForTests as guardedAnalyze, pinpointFunction } from '../js/pinpoint.js';
import { EVIDENCE, FAMILY, evidenceInfo } from '../js/evidence.js';
import { proofText, missingText } from '../js/narrate.js';
import { setLang, lang as getLang } from '../js/i18n.js';
import { prioritizeDeobfCandidates } from '../js/analysis/deobf/auto-analysis-queue.js';

function withLang(lang, fn) {
  const prev = getLang();
  setLang(lang);
  try {
    return fn();
  } finally {
    setLang(prev);
  }
}

test('guardedAnalyze: burst-scoped cache shares results across goals and skips uniqueKeys budget after cap', async () => {
  let calls = 0;
  const rawAnalyze = async (start, end) => {
    calls += 1;
    return { start, end, calls };
  };
  const shapes = { kind: 'burst-shapes' };
  const goal1 = guardedAnalyze(rawAnalyze, { shapes, maxPinpointAnalyses: 1, perFunctionBudgetMs: 1000 });
  const goal2 = guardedAnalyze(rawAnalyze, { shapes, maxPinpointAnalyses: 1, perFunctionBudgetMs: 1000 });

  const r1 = await goal1(0x1000n, 0x1040n);
  assert.equal(calls, 1);
  // Second goal in same burst hits cache even though maxPinpointAnalyses=1 is already full
  const r2 = await goal2(0x1000n, 0x1040n, { perFunctionBudgetMs: 500 });
  assert.equal(calls, 1);
  assert.strictEqual(r2, r1);
  // A new uncached function still hits the uniqueKeys ceiling
  await assert.rejects(() => goal2(0x2000n, 0x2040n), (err) => err?.code === 'pinpoint-analysis-budget');
});

test('guardedAnalyze: non-burst calls isolate local cache and never leak across sessions', async () => {
  let calls = 0;
  const rawAnalyze = async (start, end) => ({ start, end, seq: ++calls });
  const sessionA = guardedAnalyze(rawAnalyze, { perFunctionBudgetMs: 1000 });
  const sessionB = guardedAnalyze(rawAnalyze, { perFunctionBudgetMs: 1000 });

  const a1 = await sessionA(0x1000n, 0x1040n);
  const a2 = await sessionA(0x1000n, 0x1040n);
  assert.strictEqual(a2, a1);
  assert.equal(calls, 1);

  const b1 = await sessionB(0x1000n, 0x1040n);
  assert.equal(calls, 2);
  assert.notStrictEqual(b1, a1);
});

test('guardedAnalyze: typed cache keys prevent collisions between 16n, 16, "16", null, "null", undefined', async () => {
  let calls = 0;
  const rawAnalyze = async (a, b) => ({ a, b, seq: ++calls });
  const fn = guardedAnalyze(rawAnalyze, { shapes: {}, perFunctionBudgetMs: 1000 });

  const rBig = await fn(16n, null);
  const rNum = await fn(16, null);
  const rStr = await fn('16', null);
  const rNullStr = await fn(16n, 'null');
  const rUndef = await fn(16n, undefined);
  assert.equal(calls, 5);
  assert.strictEqual(await fn(16n, null), rBig);
  assert.strictEqual(await fn(16, null), rNum);
  assert.strictEqual(await fn('16', null), rStr);
  assert.strictEqual(await fn(16n, 'null'), rNullStr);
  assert.strictEqual(await fn(16n, undefined), rUndef);
  assert.equal(calls, 5);
});

test('guardedAnalyze: cancellation (opts.signal, isCancelled, args[2].signal) aborts immediately even on cache hit', async () => {
  let calls = 0;
  const rawAnalyze = async (addr) => ({ addr, seq: ++calls });
  const shapes = {};
  const warmup = guardedAnalyze(rawAnalyze, { shapes, perFunctionBudgetMs: 1000 });
  await warmup(0x4000n, 0x4040n);
  assert.equal(calls, 1);

  const c1 = new AbortController();
  c1.abort('parent-abort');
  const g1 = guardedAnalyze(rawAnalyze, { shapes, signal: c1.signal, perFunctionBudgetMs: 1000 });
  await assert.rejects(() => g1(0x4000n, 0x4040n), (err) => err?.name === 'AbortError');

  const g2 = guardedAnalyze(rawAnalyze, { shapes, isCancelled: () => true, perFunctionBudgetMs: 1000 });
  await assert.rejects(() => g2(0x4000n, 0x4040n), (err) => err?.name === 'AbortError');

  const c3 = new AbortController();
  c3.abort('arg-abort');
  const g3 = guardedAnalyze(rawAnalyze, { shapes, perFunctionBudgetMs: 1000 });
  await assert.rejects(() => g3(0x4000n, 0x4040n, { signal: c3.signal }), (err) => err?.name === 'AbortError');
  assert.equal(calls, 1);
});

test('guardedAnalyze: null/undefined results and non-allowed 3rd arg keys bypass caching', async () => {
  let calls = 0;
  const rawAnalyze = async (addr, _end, opts) => {
    calls += 1;
    if (addr === 0x5000n) return null;
    return { addr, mode: opts?.mode ?? 'default', seq: calls };
  };
  const fn = guardedAnalyze(rawAnalyze, { shapes: {}, perFunctionBudgetMs: 1000 });

  assert.equal(await fn(0x5000n, 0x5020n), null);
  assert.equal(await fn(0x5000n, 0x5020n), null);
  assert.equal(calls, 2, 'null result must not be cached');

  const d1 = await fn(0x6000n, 0x6020n, { mode: 'deep' });
  const d2 = await fn(0x6000n, 0x6020n, { mode: 'deep' });
  assert.notStrictEqual(d1, d2, 'non-allowed 3rd arg option key must bypass cache');
  assert.equal(calls, 4);

  // Non-plain object 3rd arg or 4th arg must also bypass cache
  await fn(0x6000n, 0x6020n, new Map());
  await fn(0x6000n, 0x6020n, undefined, 'extra');
  assert.equal(calls, 6);
});

test('evidence & narrate: fn-crypto-const, fn-numeric fallback, and per-function-budget-exceeded (JA/EN)', () => {
  const info = evidenceInfo('fn-crypto-const');
  assert.ok(info);
  assert.equal(info.lr, 5.5);
  assert.equal(info.family, FAMILY.USAGE);
  assert.equal(info.kind, 'fact');
  assert.equal(info.id, true);
  assert.strictEqual(EVIDENCE['fn-crypto-const'], info);

  const jaCrypto = withLang('ja', () => proofText({ code: 'fn-crypto-const', detail: { name: 'AES S-box' } }));
  const enCrypto = withLang('en', () => proofText({ code: 'fn-crypto-const', detail: { name: 'AES S-box' } }));
  assert.match(jaCrypto, /AES S-box/);
  assert.match(jaCrypto, /定数/);
  assert.match(enCrypto, /AES S-box/);
  assert.match(enCrypto, /cryptographic constant/i);

  const jaNum = withLang('ja', () => proofText({ code: 'fn-numeric', detail: { mul: 2, div: 1, fmul: 3, farith: 1 } }));
  const enNum = withLang('en', () => proofText({ code: 'fn-numeric', detail: { mul: 2, div: 1, fmul: 3, farith: 1 } }));
  assert.doesNotMatch(jaNum, /undefined/);
  assert.doesNotMatch(enNum, /undefined/);
  assert.match(jaNum, /7/);
  assert.match(enNum, /7/);

  const jaBudget = withLang('ja', () => missingText('per-function-budget-exceeded'));
  const enBudget = withLang('en', () => missingText('per-function-budget-exceeded'));
  assert.ok(jaBudget.length > 0);
  assert.ok(enBudget.length > 0);
});

test('pinpoint-legacy: GOAL_TO_CATEGORY maps speed/cooldown/crypto to real appmap categories and REASON_TO_EVIDENCE maps crypto-const', async () => {
  const legacySrc = fs.readFileSync(new URL('../js/pinpoint-legacy.js', import.meta.url), 'utf8');
  const appmapSrc = fs.readFileSync(new URL('../js/appmap.js', import.meta.url), 'utf8');
  const realCategories = new Set([...appmapSrc.matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]));

  const blockMatch = legacySrc.match(/const GOAL_TO_CATEGORY = \{([\s\S]*?)\};/);
  assert.ok(blockMatch, 'GOAL_TO_CATEGORY must exist');
  for (const goalId of ['speed', 'cooldown', 'crypto']) {
    const rowMatch = blockMatch[1].match(new RegExp(`\\b${goalId}:\\s*\\[([^\\]]+)\\]`));
    assert.ok(rowMatch, `GOAL_TO_CATEGORY must define ${goalId}`);
    const cats = [...rowMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(cats.length > 0);
    for (const cat of cats) {
      assert.ok(realCategories.has(cat), `Category '${cat}' for goal '${goalId}' must exist in js/appmap.js`);
    }
  }

  // Verify crypto-const translates to fn-crypto-const through pinpointFunction
  const res = await pinpointFunction({
    goal: { id: 'crypto', kind: 'function' },
    ranked: [{
      addr: 0x1000n,
      score: 20,
      reasons: [{ code: 'crypto-const', points: 18, detail: { algo: 'aes-sbox', name: 'AES S-box' } }],
    }],
  });
  const top = res.candidates[0];
  assert.ok(top, 'crypto candidate should be built');
  assert.ok(top.evidence.some((e) => e.code === 'fn-crypto-const'), 'crypto-const must map to fn-crypto-const');
});

test('auto-analysis-queue: prioritizeDeobfCandidates merges tags and reasons bidirectionally with Math.max score', () => {
  // Case 1: newer candidate has higher priorityScore
  const res1 = prioritizeDeobfCandidates([
    { vaHex: '0x1000', cffSuspected: false, stlSuspected: true, tags: ['stl', 'shared'], reasons: ['r-stl', 'r-shared'] },
    { vaHex: '0x1000', cffSuspected: true, mbaSuspected: true, tags: ['cff', 'shared'], reasons: ['r-cff', 'r-shared'] },
  ]);
  assert.equal(res1.length, 1);
  assert.deepEqual(res1[0].tags, ['cff', 'shared', 'stl']);
  assert.deepEqual(res1[0].reasons, ['r-cff', 'r-shared', 'r-stl']);
  const singleHigh = prioritizeDeobfCandidates([
    { vaHex: '0x1000', cffSuspected: true, mbaSuspected: true, tags: ['cff', 'shared'], reasons: ['r-cff', 'r-shared'] },
  ])[0];
  assert.equal(res1[0].priorityScore, singleHigh.priorityScore, 'score must be Math.max without double counting');

  // Case 2: existing candidate has higher priorityScore (lower-priority duplicate arrives second)
  const res2 = prioritizeDeobfCandidates([
    { vaHex: '0x2000', cffSuspected: true, mbaSuspected: true, tags: ['cff', 'dup'], reasons: ['r-cff', 'r-dup'] },
    { vaHex: '0x2000', cffSuspected: false, stlSuspected: true, tags: ['stl', 'dup'], reasons: ['r-stl', 'r-dup'] },
  ]);
  assert.equal(res2.length, 1);
  assert.deepEqual(res2[0].tags, ['cff', 'dup', 'stl']);
  assert.deepEqual(res2[0].reasons, ['r-cff', 'r-dup', 'r-stl']);
  assert.equal(res2[0].priorityScore, singleHigh.priorityScore, 'score must remain existing higher priorityScore');
});

test('guardedAnalyze: bounded 512-entry cache evicts oldest entry on 513th distinct key', async () => {
  let calls = 0;
  const rawAnalyze = async (addr, end) => {
    calls++;
    return { addr, end, calls };
  };
  const shapes = {};
  const wrapped = __guardedAnalyzeForTest(rawAnalyze, { shapes, maxUniqueAnalyses: 1000 });
  for (let i = 0; i < 513; i++) {
    await wrapped(BigInt(0x1000 + i * 4), BigInt(0x1004 + i * 4));
  }
  assert.equal(calls, 513);

  const hitRes = await wrapped(0x1004n, 0x1008n);
  assert.equal(calls, 513);
  assert.equal(hitRes.addr, 0x1004n);

  const evictedRes = await wrapped(0x1000n, 0x1004n);
  assert.equal(calls, 514);
  assert.equal(evictedRes.addr, 0x1000n);
});
