import { coarseTokens, compareFingerprints, fingerprintFunction, fingerprintFunctionFast } from '../fingerprint/index.js';
import { maximumWeightCandidateMatchingBounded, solveCandidateMatching } from './bounded-matching.js';
import { createMatchBudget } from './match-budget.js';

const MATCH_POSTPROCESSING_BUDGET_STOP = Symbol('match-postprocessing-budget-stop');

export class FunctionMatchIndex {
  constructor(functions = [], options = {}) {
    this.mode = options.mode || 'fast';
    this.budget = options.budget || createMatchBudget(options.matchBudget || {});
    this.items = [];
    this.buckets = new Map();
    this.complete = true;
    for (const raw of functions || []) if (!this.append(raw)) break;
  }
  /** Streaming construction uses the same fingerprint/bucket owner and budget
   * as synchronous construction; an incomplete prefix is never healed by append.
   */
  append(raw) {
    if (!this.complete) return false;
    if (!this.budget.preprocess(raw, 'after fingerprint preprocessing')) { this.complete = false; return false; }
    const fp = this.mode === 'full' ? fingerprintFunction(raw) : fingerprintFunctionFast(raw);
    this.budget.fingerprinted();
    const index = this.items.length;
    this.items.push(fp);
    for (const token of coarseTokens(fp)) {
      if (!this.budget.indexEntry()) { this.complete = false; return false; }
      let bucket = this.buckets.get(token);
      if (!bucket) this.buckets.set(token, bucket = []);
      bucket.push(index);
    }
    if (!this.budget.checkPreprocessWall('fingerprint index construction') || this.budget.preprocessingIncomplete) this.complete = false;
    return this.complete;
  }
  candidates(input, options = {}) {
    const fingerprinted = input?.schema === 'hex.function-fingerprint' || input?.schema === 'hex.function-fingerprint-fast';
    // Raw query functions pay the same preprocessing gate as index builds:
    // the constructor's preprocess budgets must also bound public query
    // fingerprinting, or the standalone candidates() path bypasses them
    // entirely (#5021).
    if (!fingerprinted && !this.budget.preprocess(input, 'before query fingerprint preprocessing')) {
      this.complete = false;
      return [];
    }
    const fp = fingerprinted ? input : fingerprintFunctionFast(input);
    const rawMaxCandidates = Number(options.maxCandidates ?? 128);
    const maxCandidates = Number.isFinite(rawMaxCandidates) && rawMaxCandidates > 0 ? Math.max(1, Math.floor(rawMaxCandidates)) : 128;
    const rawMaxBucketScan = Number(options.maxBucketScan ?? 1024);
    const boundedBucketScan = Number.isFinite(rawMaxBucketScan) && rawMaxBucketScan > 0 ? Math.max(1, Math.floor(rawMaxBucketScan)) : 1024;
    const maxBucketScan = Math.max(maxCandidates, boundedBucketScan);
    const tokens = coarseTokens(fp);
    const tokenBuckets = [];
    for (let t = 0; t < tokens.length; t += 1) {
      const token = tokens[t];
      const bucket = this.buckets.get(token);
      if (bucket && bucket.length) tokenBuckets.push({ token, bucket });
    }
    if (!tokenBuckets.length) return [];
    tokenBuckets.sort((a, b) => a.bucket.length - b.bucket.length);
    const exact = tokenBuckets.find((x) => x.token.startsWith('nb:') && x.bucket.length <= maxCandidates);
    if (exact) return exact.bucket.slice();
    const scores = new Map();
    const selectedCount = Math.min(6, tokenBuckets.length);
    for (let rank = 0; rank < selectedCount; rank += 1) {
      const { bucket } = tokenBuckets[rank];
      const bucketLen = bucket.length;
      const scan = Math.min(bucketLen, maxBucketScan);
      // For huge, low-information buckets, deterministic spread sampling avoids O(N) probes.
      const step = bucketLen > scan ? bucketLen / scan : 1;
      const invLen = 1 / Math.max(1, bucketLen);
      for (let k = 0; k < scan; k += 1) {
        const idx = bucket[Math.min(bucketLen - 1, Math.floor(k * step))];
        let current = scores.get(idx);
        if (current === undefined) {
          scores.set(idx, { hits: 1, rarity: invLen });
        } else {
          current.hits += 1;
          current.rarity += invLen;
        }
      }
    }
    return [...scores].sort((a,b) => b[1].hits-a[1].hits || b[1].rarity-a[1].rarity || a[0]-b[0]).slice(0,maxCandidates).map(([i])=>i);
  }
}

function getNeighborSet(cache, list, idx) {
  let set = cache[idx];
  if (set !== undefined) return set;
  const fp = list[idx];
  const callers = fp.callers, callees = fp.callees;
  if ((!callers || !callers.length) && (!callees || !callees.length)) {
    cache[idx] = null;
    return null;
  }
  set = new Set();
  if (callers) for (let k = 0; k < callers.length; k += 1) set.add(String(callers[k]));
  if (callees) for (let k = 0; k < callees.length; k += 1) set.add(String(callees[k]));
  cache[idx] = set;
  return set;
}
function neighborBonusFromSets(A, B, anchors) {
  if (!A || !B || !anchors.size) return 0;
  let possible = 0, hits = 0;
  for (const from of A) {
    const to = anchors.get(from);
    if (!to) continue;
    possible++;
    if (B.has(String(to))) hits++;
  }
  return possible ? Math.min(0.08, 0.08 * hits / possible) : 0;
}

// Exact ambiguity solving is implemented only in bounded-matching.js.
export function maximumWeightCandidateMatching(candidates = [], options = {}) {
  return maximumWeightCandidateMatchingBounded(candidates, options);
}

export function matchFunctions(beforeFunctions = [], afterFunctions = [], options = {}) {
  const fastMode = options.mode === 'fast';
  // Start every time/abort/memory/work budget before the first raw function is
  // fingerprinted. This is the trust boundary for the full matching pipeline.
  const budget = createMatchBudget({ signal: options.signal, ...(options.matchBudget || {}) });
  const incompletePreprocessing = (index = null) => {
    const matchingBudget = budget.snapshot();
    return {
      matches: [],
      // Do not allocate another O(N) copy on the failure path. Consumers must
      // inspect matching.truncated / candidateGraphIncomplete before treating
      // these unmatched inputs as definitive deletions/additions.
      deleted: beforeFunctions,
      new: afterFunctions,
      unresolvedBefore: beforeFunctions,
      unresolvedAfter: afterFunctions,
      candidatesEvaluated: 0,
      candidateComparisons: matchingBudget.candidateEvaluations,
      indexBuckets: index?.buckets?.size || 0,
      truncated: true,
      ambiguous: true,
      matching: {
        truncated: true,
        candidateGraphIncomplete: true,
        preprocessingIncomplete: true,
        ambiguousBefore: beforeFunctions.length,
        ambiguousAfter: afterFunctions.length,
        truncatedComponents: [],
        budget: matchingBudget,
      },
    };
  };

  // Build the after-side fingerprint/index incrementally. No all-function map
  // exists before the budget can stop the work.
  const index = new FunctionMatchIndex(afterFunctions, { mode: fastMode ? 'fast' : 'full', budget });
  if (!index.complete || budget.preprocessingIncomplete) return incompletePreprocessing(index);
  const after = index.items;

  // Fingerprint the before side incrementally under the same aggregate budget.
  const before = [];
  for (const raw of beforeFunctions) {
    if (!budget.preprocess(raw, 'before fingerprint preprocessing')) return incompletePreprocessing(index);
    before.push(fastMode ? fingerprintFunctionFast(raw) : fingerprintFunction(raw));
    budget.fingerprinted();
    if (!budget.checkPreprocessWall('before fingerprint preprocessing')) return incompletePreprocessing(index);
  }

  const rawThreshold = Number(options.threshold ?? 0.62);
  const threshold = Number.isFinite(rawThreshold) ? rawThreshold : 0.62;
  const rawAmbiguityWindow = Number(options.ambiguityWindow ?? 0.035);
  const ambiguityWindow = Number.isFinite(rawAmbiguityWindow) && rawAmbiguityWindow >= 0 ? rawAmbiguityWindow : 0.035;
  const all = [];
  candidateGeneration:
  for (let i = 0; i < before.length; i++) {
    // A zero-candidate lookup still performs bounded bucket work; check the
    // wall/abort budget before every lookup so empty graphs cannot bypass it.
    if (!budget.checkCandidateWall()) break candidateGeneration;
    const candidateIds = index.candidates(before[i], options);
    for (const j of candidateIds) {
      if (!budget.candidate()) break candidateGeneration;
      const cmp = compareFingerprints(before[i], after[j]);
      if (cmp.confidence < threshold || cmp.identity === 'unrelated') continue;
      if (options.isRejected?.(before[i], after[j])) continue;
      if (!budget.edge()) break candidateGeneration;
      all.push({ i, j, ...cmp, baseConfidence: cmp.confidence });
    }
  }
  if (!budget.candidateGraphIncomplete) budget.checkCandidateWall();
  if (budget.candidateGraphIncomplete) {
    const matchingBudget = budget.snapshot();
    return {
      matches: [], deleted: before.slice(), new: after.slice(),
      candidatesEvaluated: all.length, candidateComparisons: matchingBudget.candidateEvaluations,
      indexBuckets: index.buckets.size, truncated: true, ambiguous: true,
      unresolvedBefore: before,
      unresolvedAfter: after,
      matching: {
        truncated: true, candidateGraphIncomplete: true,
        preprocessingIncomplete: !!matchingBudget.preprocessingIncomplete,
        ambiguousBefore: before.length, ambiguousAfter: after.length,
        truncatedComponents: [], budget: matchingBudget,
      },
    };
  }
  // Anchor only unique, very strong matches before contextual refinement.
  // Ambiguous strong candidates are deliberately excluded to prevent graph feedback loops.
  const anchors = new Map();
  const anchoredAfter = new Set();
  const byBefore = new Map(); const byAfter = new Map();
  for (const c of all) {
    let left=byBefore.get(c.i); if (!left) byBefore.set(c.i,left=[]); left.push(c);
    let right=byAfter.get(c.j); if (!right) byAfter.set(c.j,right=[]); right.push(c);
  }
  for (const [i, choices] of byBefore) {
    choices.sort((a,b)=>b.baseConfidence-a.baseConfidence || a.j-b.j); const top=choices[0], second=choices[1];
    const uniqueLeft=!second || top.baseConfidence-second.baseConfidence>0.06;
    if (top.baseConfidence < 0.9 || !uniqueLeft || before[top.i].address == null || after[top.j].address == null) continue;
    const reverseList = byAfter.get(top.j);
    let reverseMaxOther = -Infinity;
    if (reverseList) {
      for (let k = 0; k < reverseList.length; k += 1) {
        const x = reverseList[k];
        if (x.i !== i && x.baseConfidence > reverseMaxOther) reverseMaxOther = x.baseConfidence;
      }
    }
    const uniqueRight = reverseMaxOther === -Infinity || top.baseConfidence - reverseMaxOther > 0.06;
    if (uniqueRight) {
      const fromKey = String(before[top.i].address);
      const toKey = String(after[top.j].address);
      if (!anchors.has(fromKey) && !anchoredAfter.has(toKey)) {
        anchors.set(fromKey, toKey);
        anchoredAfter.add(toKey);
      }
    }
  }
  const iterations = Math.max(0, Math.min(3, options.neighborhoodIterations ?? 2));
  const beforeNeighbors = anchors.size > 0 && iterations > 0 ? new Array(before.length) : null;
  const afterNeighbors = anchors.size > 0 && iterations > 0 ? new Array(after.length) : null;
  for (let iter = 0; iter < iterations && anchors.size > 0; iter++) {
    let changed = false;
    for (const c of all) {
      if (c.baseConfidence < 0.55) continue;
      const bonus = neighborBonusFromSets(
        getNeighborSet(beforeNeighbors, before, c.i),
        getNeighborSet(afterNeighbors, after, c.j),
        anchors,
      );
      const next = Math.min(0.97, c.baseConfidence + bonus);
      if (next > c.confidence) { c.confidence = next; if (bonus > 0 && !c.reasons.includes('call-neighborhood')) c.reasons.push('call-neighborhood'); changed = true; }
    }
    if (!changed || iter + 1 >= iterations) break;
    let anchorsAdded = false;
    for (const [i, choices] of byBefore) {
      if (before[i].address == null) continue;
      const fromKey = String(before[i].address);
      if (anchors.has(fromKey)) continue;
      let top = null, secondConf = -Infinity;
      for (const c of choices) {
        if (!top || c.confidence > top.confidence || (c.confidence === top.confidence && c.j < top.j)) {
          if (top) secondConf = Math.max(secondConf, top.confidence);
          top = c;
        } else if (c.confidence > secondConf) {
          secondConf = c.confidence;
        }
      }
      if (!top || top.confidence < 0.82 || after[top.j].address == null) continue;
      const toKey = String(after[top.j].address);
      if (anchoredAfter.has(toKey)) continue;
      if (secondConf > -Infinity && top.confidence - secondConf <= 0.06) continue;
      let reverseMaxOther = -Infinity;
      for (const x of (byAfter.get(top.j) || [])) {
        if (x.i !== i && x.confidence > reverseMaxOther) reverseMaxOther = x.confidence;
      }
      if (reverseMaxOther > -Infinity && top.confidence - reverseMaxOther <= 0.06) continue;
      anchors.set(fromKey, toKey);
      anchoredAfter.add(toKey);
      anchorsAdded = true;
    }
    if (!anchorsAdded) break;
  }
  const eligible = all.filter((c) => {
    if (c.identity !== 'similar' || options.allowSimilar === true) return true;
    if (c.baseConfidence >= 0.7 && c.confidence >= 0.78 && c.reasons.includes('call-neighborhood')) { c.identity = 'probable-same'; return true; }
    return false;
  });
  const eligibleByBefore = new Map(), eligibleByAfter = new Map();
  for (const c of eligible) {
    let left=eligibleByBefore.get(c.i); if (!left) eligibleByBefore.set(c.i,left=[]); left.push(c);
    let right=eligibleByAfter.get(c.j); if (!right) eligibleByAfter.set(c.j,right=[]); right.push(c);
  }
  for (const list of eligibleByBefore.values()) list.sort((a,b)=>b.confidence-a.confidence || b.baseConfidence-a.baseConfidence || a.j-b.j);
  for (const list of eligibleByAfter.values()) list.sort((a,b)=>b.confidence-a.confidence || b.baseConfidence-a.baseConfidence || a.i-b.i);

  const solved = solveCandidateMatching(eligible, budget);
  const selected = budget.candidateGraphIncomplete ? [] : solved.selected;
  const truncatedComponents = solved.truncatedComponents.slice(0, 32);
  const incompletePostprocessing = () => {
    const matchingBudget = budget.snapshot();
    return {
      matches: [], deleted: before.slice(), new: after.slice(),
      candidatesEvaluated: all.length, candidateComparisons: matchingBudget.candidateEvaluations,
      indexBuckets: index.buckets.size, truncated: true, ambiguous: true,
      unresolvedBefore: before, unresolvedAfter: after,
      matching: {
        truncated: true,
        candidateGraphIncomplete: !!matchingBudget.candidateGraphIncomplete,
        preprocessingIncomplete: !!matchingBudget.preprocessingIncomplete,
        postprocessingIncomplete: true,
        ambiguousBefore: before.length, ambiguousAfter: after.length,
        truncatedComponents,
        omittedTruncatedComponents: Math.max(0, solved.truncatedComponents.length - truncatedComponents.length),
        budget: matchingBudget,
      },
    };
  };
  const postprocessStep = (stage = 'match post-processing', cost = 1) => budget.postprocess(cost, stage);
  const collectAlternatives = (list, excludedIndex, side, confidence) => {
    const alternatives = [];
    for (const x of list) {
      if (!postprocessStep('alternative scanning')) return null;
      if ((side === 'after' && x.j === excludedIndex) || (side === 'before' && x.i === excludedIndex)
        || x.confidence < confidence - ambiguityWindow) continue;
      alternatives.push({
        side,
        index: side === 'after' ? x.j : x.i,
        address: side === 'after' ? after[x.j].address : before[x.i].address,
        confidence: x.confidence,
        identity: x.identity,
        reasons: x.reasons,
      });
      if (alternatives.length === 4) break;
    }
    return alternatives;
  };
  const sortAlternatives = (alternatives) => {
    try {
      alternatives.sort((a, b) => {
        if (!postprocessStep('alternative ordering')) throw MATCH_POSTPROCESSING_BUDGET_STOP;
        return b.confidence - a.confidence || String(a.side).localeCompare(String(b.side)) || a.index - b.index;
      });
    } catch (error) {
      if (error === MATCH_POSTPROCESSING_BUDGET_STOP) return false;
      throw error;
    }
    return true;
  };
  if (!budget.checkPostprocessingWall()) return incompletePostprocessing();

  const usedBefore = new Set(), usedAfter = new Set(), matchRecords = [];
  for (const c of selected) {
    if (!postprocessStep('match construction')) return incompletePostprocessing();
    // Ambiguity is evidence about the original candidate distribution, not a
    // side-effect of assignment order. Keep candidates even when another match
    // consumes their after-function.
    const forwardAlternatives = collectAlternatives(eligibleByBefore.get(c.i) || [], c.j, 'after', c.confidence);
    if (!forwardAlternatives) return incompletePostprocessing();
    const reverseAlternatives = collectAlternatives(eligibleByAfter.get(c.j) || [], c.i, 'before', c.confidence);
    if (!reverseAlternatives) return incompletePostprocessing();
    const alternatives = [...forwardAlternatives, ...reverseAlternatives];
    if (!sortAlternatives(alternatives)) return incompletePostprocessing();
    const candidates = alternatives.slice(0, 4);
    const ambiguous = candidates.length > 0;
    matchRecords.push({
      beforeIndex: c.i,
      afterIndex: c.j,
      match: { before: before[c.i], after: after[c.j], confidence: c.confidence, identity: c.identity, reasons: c.reasons, evidence: c.evidence, ambiguous, candidates },
    });
    usedBefore.add(c.i); usedAfter.add(c.j);
    if (!budget.checkPostprocessingWall()) return incompletePostprocessing();
  }
  try {
    matchRecords.sort((a, b) => {
      if (!postprocessStep('match ordering')) throw MATCH_POSTPROCESSING_BUDGET_STOP;
      return a.beforeIndex - b.beforeIndex || a.afterIndex - b.afterIndex;
    });
  } catch (error) {
    if (error === MATCH_POSTPROCESSING_BUDGET_STOP) return incompletePostprocessing();
    throw error;
  }
  if (!budget.checkPostprocessingWall('match ordering')) return incompletePostprocessing();
  const matches = [];
  for (const { match } of matchRecords) {
    if (!postprocessStep('match publication')) return incompletePostprocessing();
    matches.push(match);
  }
  const deleted = [], added = [];
  for (let i = 0; i < before.length; i++) {
    if (!postprocessStep('deleted collection')) return incompletePostprocessing();
    if (!usedBefore.has(i)) deleted.push(before[i]);
  }
  for (let i = 0; i < after.length; i++) {
    if (!postprocessStep('new collection')) return incompletePostprocessing();
    if (!usedAfter.has(i)) added.push(after[i]);
  }
  if (!budget.checkPostprocessingWall()) return incompletePostprocessing();
  const matchingBudget = budget.snapshot();
  const candidateGraphIncomplete = !!matchingBudget.candidateGraphIncomplete;
  const truncated = matchingBudget.truncated || solved.truncatedComponents.length > 0;
  const hasMatchAmbiguity = matches.some((match) => match.ambiguous);
  const unresolvedBefore = candidateGraphIncomplete
    ? deleted.slice()
    : (truncated ? before.filter((_x, i) => solved.ambiguousLeft.has(i)) : []);
  const unresolvedAfter = candidateGraphIncomplete
    ? added.slice()
    : (truncated ? after.filter((_x, i) => solved.ambiguousRight.has(i)) : []);
  return {
    matches, deleted, new: added,
    candidatesEvaluated: all.length,
    candidateComparisons: matchingBudget.candidateEvaluations,
    indexBuckets: index.buckets.size,
    truncated,
    ambiguous: truncated || hasMatchAmbiguity,
    unresolvedBefore,
    unresolvedAfter,
    matching: {
      truncated,
      candidateGraphIncomplete,
      preprocessingIncomplete: !!matchingBudget.preprocessingIncomplete,
      ambiguousBefore: candidateGraphIncomplete ? unresolvedBefore.length : solved.ambiguousLeft.size,
      ambiguousAfter: candidateGraphIncomplete ? unresolvedAfter.length : solved.ambiguousRight.size,
      truncatedComponents,
      omittedTruncatedComponents: Math.max(0, solved.truncatedComponents.length - truncatedComponents.length),
      budget: matchingBudget,
    },
  };
}

export function matchFunctionsFast(beforeFunctions, afterFunctions, options = {}) {
  return matchFunctions(beforeFunctions, afterFunctions, { ...options, mode:'fast', neighborhoodIterations:0 });
}

export function recognitionMetrics(expectedPairs, result) {
  const expected = new Set((expectedPairs || []).map(([a,b]) => `${a}>${b}`));
  const predicted = new Set((result.matches || []).filter((m) => !m.ambiguous).map((m) => `${m.before.address}>${m.after.address}`));
  let tp = 0; for (const p of predicted) if (expected.has(p)) tp++;
  const fp = predicted.size - tp, fn = expected.size - tp;
  return {
    truePositive: tp, falsePositive: fp, falseNegative: fn,
    precision: predicted.size ? tp / predicted.size : 1,
    recall: expected.size ? tp / expected.size : 1,
    falseMatchRate: predicted.size ? fp / predicted.size : 0,
    ambiguousRate: result.matches?.length ? result.matches.filter((x) => x.ambiguous).length / result.matches.length : 0,
  };
}

export function calibrationReport(expectedPairs, result, options = {}) {
  const bins = Math.max(2, Math.min(50, Number(options.bins) || 10));
  const expected = new Set((expectedPairs || []).map(([a,b]) => `${a}>${b}`));
  const buckets = Array.from({length:bins}, (_x,index) => ({ lower:index/bins, upper:(index+1)/bins, samples:0, correct:0, meanScore:0 }));
  for (const match of result.matches || []) {
    const score = Math.max(0, Math.min(1, Number(match.confidence) || 0));
    const index = Math.min(bins-1, Math.floor(score*bins)); const bucket=buckets[index];
    bucket.samples++; bucket.meanScore += score;
    if (expected.has(`${match.before.address}>${match.after.address}`)) bucket.correct++;
  }
  for (const bucket of buckets) {
    bucket.meanScore = bucket.samples ? bucket.meanScore / bucket.samples : null;
    bucket.observedPrecision = bucket.samples ? bucket.correct / bucket.samples : null;
  }
  return { scoreKind:'similarity-confidence-v1', calibrated:false, bins:buckets };
}
