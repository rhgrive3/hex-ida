import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SymbolIndex } from '../../../js/symbols.js';
import { buildNoreturnContinuationProposal } from '../../../js/analysis/discovery/noreturn-refinement.js';
import { commitFunctionTopologyRefinement, TOPOLOGY_REFINEMENT_FORBIDDEN_DEPENDENCY } from '../../../js/analysis/discovery/topology-refinement-transaction.js';

/*
 * B1a — downstream noreturn-continuation refinement.
 *
 * The caller, callee and continuation addresses are synthetic and share no
 * value with any benchmark case, function name or section.
 */

const CALLER = 0x1000n;
const CALLER_END = 0x1040n;
const CALL_SITE = 0x1010n;
const CONTINUATION = CALL_SITE + 4n;
const FATAL = 0x2000n;
const RETURNS = 0x2100n;
const IMPORTED = 0x3000n;
const EXEC = [[0x1000n, 0x3000n]];

function completeSummary(noreturn) {
  return { noreturn, status: { completeness: 'complete', stopReason: null } };
}

function makeAuthority({
  starts = [CALLER, FATAL, RETURNS],
  ends = new Map([[CALLER.toString(), CALLER_END]]),
  summaries = new Map([[FATAL.toString(), completeSummary(true)], [RETURNS.toString(), completeSummary(false)]]),
  proofs = new Map(),
  exec = EXEC,
  callWidth = 4n,
} = {}) {
  const startSet = new Set(starts.map((value) => value.toString()));
  const inExec = (addr) => exec.some(([lo, hi]) => addr >= lo && addr < hi);
  return {
    functionStartAt(addr) {
      let best = null;
      for (const start of starts) {
        if (start > addr) continue;
        const end = ends.get(start.toString()) ?? null;
        if (end != null && addr < end) best = start;
        else if (end == null) best = start;
      }
      return best;
    },
    isLocalFunctionStart(addr) { return startSet.has(addr.toString()); },
    declaredEndOf(start) { return ends.get(start.toString()) ?? null; },
    callInstructionEnd(site) { return site + callWidth; },
    summaryOf(start) { return summaries.get(start.toString()) ?? null; },
    predecessorProof({ continuation }) { return proofs.get(continuation.toString()) ?? { complete: true, hasOtherPredecessor: false }; },
    isExecutable(addr) { return inExec(addr); },
    isInstructionBoundary(addr) { return addr % 4n === 0n; },
  };
}

function binding(overrides = {}) {
  return {
    binaryId: 'synthetic:fixture',
    analysisEpoch: 1,
    discoveryKey: 'discovery:fixture',
    symbolsGeneration: 0,
    functionTopologyRevision: 0,
    startSetDigest: 'digest',
    programGeneration: 0,
    programEvidenceDigest: 'DA',
    ...overrides,
  };
}

function buildProposal({ authority = makeAuthority(), calls = [{ site: CALL_SITE, target: FATAL }], limits = {} } = {}) {
  return buildNoreturnContinuationProposal({ binding: binding(), calls, authority, limits });
}

function makeIndex(overrides = {}) {
  return new SymbolIndex({
    funcs: [CALLER, FATAL, RETURNS],
    funcEnds: [CALLER_END, 0n, 0n],
    regions: [{ id: 'text', exec: true, vmAddr: 0x1000n, size: 0x2000n }],
    functionStartsComplete: true,
    functionStartsExact: true,
    ...overrides,
  });
}

function commit({ symbols, proposal, current = true, wave = { set: new Set(), has(k) { return this.set.has(k); }, mark(k) { this.set.add(k); } }, validateCandidate = null, invalidate = null } = {}) {
  return commitFunctionTopologyRefinement({
    proposal,
    symbols,
    bindingIsCurrent: () => current,
    wave,
    validateCandidate,
    invalidate,
  });
}

test('fixture 1: a locally-defined proven-noreturn callee with a post-call continuation adds exactly one start', () => {
  const proposal = buildProposal();
  assert.equal(proposal.status.completeness, 'complete');
  assert.equal(proposal.candidates.length, 1);
  assert.equal(proposal.candidates[0].start, CONTINUATION);
  assert.equal(proposal.candidates[0].calleeStart, FATAL);
  assert.equal(proposal.candidates[0].provenance.source, 'noreturn-continuation-refinement');

  const symbols = makeIndex();
  const result = commit({ symbols, proposal });
  assert.equal(result.status, 'committed');
  assert.equal(result.added, 1);
  assert.equal(symbols.functionTopologyRevision, 1);
  assert.deepEqual([...symbols.funcs], [CALLER, CONTINUATION, FATAL, RETURNS]);
});

test('fixture 2: an ordinary returning local callee adds no start', () => {
  const proposal = buildProposal({ calls: [{ site: CALL_SITE, target: RETURNS }] });
  assert.equal(proposal.candidates.length, 0);
  const symbols = makeIndex();
  assert.equal(commit({ symbols, proposal }).status, 'no-op');
  assert.deepEqual([...symbols.funcs], [CALLER, FATAL, RETURNS]);
});

test('fixture 3: an imported/name-based noreturn target is not a local start and adds nothing', () => {
  const authority = makeAuthority({
    summaries: new Map([[IMPORTED.toString(), completeSummary(true)]]),
  });
  const proposal = buildProposal({ authority, calls: [{ site: CALL_SITE, target: IMPORTED }] });
  assert.equal(proposal.candidates.length, 0);
  const symbols = makeIndex();
  assert.equal(commit({ symbols, proposal }).status, 'no-op');
  assert.deepEqual([...symbols.funcs], [CALLER, FATAL, RETURNS]);
});

test('fixture 4: an unknown/partial callee summary adds no start', () => {
  for (const summary of [
    { noreturn: 'unknown', status: { completeness: 'complete' } },
    { noreturn: true, status: { completeness: 'partial' } },
    null,
  ]) {
    const summaries = new Map([[FATAL.toString(), summary]]);
    const proposal = buildProposal({ authority: makeAuthority({ summaries }) });
    assert.equal(proposal.candidates.length, 0, `summary ${JSON.stringify(summary)} must not authorise a split`);
  }
});

test('fixture 5: applying the same proposal twice is idempotent and never duplicates a start', () => {
  const symbols = makeIndex();
  const first = buildProposal();
  const wave = { set: new Set(), has(k) { return this.set.has(k); }, mark(k) { this.set.add(k); } };
  assert.equal(commit({ symbols, proposal: first, wave }).status, 'committed');
  const before = [...symbols.funcs].map(String);
  const revision = symbols.functionTopologyRevision;
  const gen = symbols.gen;

  // A second prepare from the (now stale) base must not re-derive authority from
  // the pre-refinement index; re-committing the same immutable proposal is
  // detected by the wave marker.
  const second = commit({ symbols, proposal: first, wave: { ...wave, set: wave.set } });
  assert.equal(second.status, 'already-applied');
  assert.equal(second.added, 0);
  assert.deepEqual([...symbols.funcs].map(String), before);
  assert.equal(symbols.functionTopologyRevision, revision);
  assert.equal(symbols.gen, gen);

  // Determinism: a fresh identical proposal has the same candidate set.
  const rebuilt = buildProposal();
  assert.deepEqual(rebuilt.candidates.map((c) => c.start.toString()), first.candidates.map((c) => c.start.toString()));
});

test('fixture 6: a topology consumer touched before refinement never serves a stale pre-refinement owner', () => {
  const symbols = makeIndex();
  assert.equal(symbols.functionStartAt(0x1018n), CALLER);
  assert.deepEqual(symbols.functionAt(0x1004n), { start: CALLER, end: CALLER_END, index: 0 });

  const proposal = buildProposal();
  assert.equal(commit({ symbols, proposal }).status, 'committed');

  // Effective ownership moves to the new start; the declared source extent is
  // preserved as evidence and never overwritten.
  assert.equal(symbols.functionStartAt(0x1018n), CONTINUATION);
  assert.deepEqual(symbols.functionAt(0x1004n), { start: CALLER, end: CONTINUATION, index: 0 });
  assert.equal(symbols.declaredFunctionEnd(CALLER), CALLER_END);
  assert.equal(symbols.functionWindowBound(CALLER), CONTINUATION);
});

test('fixture 7: malformed or incomplete analysis fails closed with zero mutation', () => {
  const symbols = makeIndex();
  const before = [...symbols.funcs].map(String);
  const gen = symbols.gen;

  // Incomplete proposal (global truncation) carries no authority.
  const truncated = buildNoreturnContinuationProposal({
    binding: binding(),
    calls: [{ site: CALL_SITE, target: FATAL }, { site: 0x1020n, target: FATAL }],
    authority: makeAuthority(),
    limits: { maxCandidates: 1 },
  });
  assert.equal(truncated.status.completeness, 'incomplete');
  assert.equal(commit({ symbols, proposal: truncated }).status, 'incomplete');

  // Same-generation evidence replacement: binding CAS fails.
  const stale = buildProposal();
  assert.equal(commit({ symbols, proposal: stale, current: false }).status, 'stale');

  // Live-predecessor counterexample: the continuation is still reachable.
  const live = buildProposal({
    authority: makeAuthority({ proofs: new Map([[CONTINUATION.toString(), { complete: true, hasOtherPredecessor: true }]]) }),
  });
  assert.equal(live.candidates.length, 0);
  assert.equal(commit({ symbols, proposal: live }).status, 'no-op');

  // Partial CFG: absence of a predecessor cannot be inferred from incomplete evidence.
  const partialCfg = buildProposal({
    authority: makeAuthority({ proofs: new Map([[CONTINUATION.toString(), { complete: false, hasOtherPredecessor: false }]]) }),
  });
  assert.equal(partialCfg.candidates.length, 0);

  // Non-executable continuation / boundary failure.
  const nonExec = buildProposal({ authority: makeAuthority({ exec: [[0x1000n, 0x1014n]] }) });
  assert.equal(nonExec.candidates.length, 0);

  assert.deepEqual([...symbols.funcs].map(String), before);
  assert.equal(symbols.gen, gen);
  assert.equal(symbols.functionTopologyRevision, 0);
});

test('fixture 8: candidate validation is batch-atomic and a rejected batch mutates nothing', () => {
  const symbols = makeIndex();
  const proposal = buildProposal();
  const result = commit({ symbols, proposal, validateCandidate: () => false });
  assert.equal(result.status, 'no-op');
  assert.deepEqual([...symbols.funcs], [CALLER, FATAL, RETURNS]);
  assert.equal(symbols.functionTopologyRevision, 0);
});

test('counterexample: an indirect/ambiguous or already-a-start continuation adds nothing', () => {
  // Continuation already a function start.
  const already = buildProposal({ authority: makeAuthority({ starts: [CALLER, FATAL, RETURNS, CONTINUATION] }) });
  assert.equal(already.candidates.length, 0);
  // Continuation outside the caller span (the declared end sits between the
  // call site and the decoded end).
  const outside = buildProposal({
    authority: makeAuthority({ ends: new Map([[CALLER.toString(), CALL_SITE + 2n]]) }),
  });
  assert.equal(outside.candidates.length, 0);
  // Caller unresolved (no enclosing local function).
  const unresolved = buildProposal({ authority: makeAuthority({ starts: [FATAL, RETURNS] }) });
  assert.equal(unresolved.candidates.length, 0);
});

test('contract: the continuation is the decoded call-instruction end, never a fixed width', () => {
  const proposal = buildProposal({ authority: makeAuthority({ callWidth: 8n }) });
  assert.equal(proposal.candidates.length, 1);
  assert.equal(proposal.candidates[0].start, CALL_SITE + 8n);
  assert.notEqual(proposal.candidates[0].start, CALL_SITE + 4n);
});

test('transaction: a stale binding after a concurrent commit performs zero mutation', () => {
  const symbols = makeIndex();
  const proposalA = buildProposal();
  const proposalB = buildNoreturnContinuationProposal({
    binding: binding({ programEvidenceDigest: 'DB' }),
    calls: [{ site: CALL_SITE, target: FATAL }],
    authority: makeAuthority(),
  });
  const wave = { set: new Set(), has(k) { return this.set.has(k); }, mark(k) { this.set.add(k); } };
  assert.equal(commit({ symbols, proposal: proposalA, wave }).status, 'committed');
  const snapshot = [...symbols.funcs].map(String);
  // B's binding is no longer current (the base moved), so it must not commit.
  assert.equal(commit({ symbols, proposal: proposalB, wave, current: false }).status, 'stale');
  assert.deepEqual([...symbols.funcs].map(String), snapshot);
});

test('transaction: a successful commit invalidates derived consumers exactly once', () => {
  const symbols = makeIndex();
  const proposal = buildProposal();
  let invalidations = 0;
  const wave = { set: new Set(), has(k) { return this.set.has(k); }, mark(k) { this.set.add(k); } };
  assert.equal(commit({ symbols, proposal, wave, invalidate: () => { invalidations += 1; } }).status, 'committed');
  assert.equal(invalidations, 1);
  // A fresh wave without the completed marker still sees the start already
  // present and stays a no-op instead of re-invalidating.
  const freshWave = { set: new Set(), has(k) { return this.set.has(k); }, mark(k) { this.set.add(k); } };
  assert.equal(commit({ symbols, proposal, wave: freshWave, invalidate: () => { invalidations += 1; } }).status, 'no-op');
  // The original wave records the completed wave and reports already-applied.
  assert.equal(commit({ symbols, proposal, wave, invalidate: () => { invalidations += 1; } }).status, 'already-applied');
  assert.equal(invalidations, 1, 'already-applied and no-op must not re-invalidate');
});

test('contract: bootstrap completeness and discovery identity are never rewritten by a refinement', () => {
  const symbols = makeIndex({ functionDiscovery: { complete: true, discoveryKey: 'discovery:fixture', attempted: true } });
  const cached = { ...symbols.functionDiscovery };
  const proposal = buildProposal();
  assert.equal(commit({ symbols, proposal }).status, 'committed');
  assert.equal(symbols.functionStartsComplete, true);
  assert.deepEqual(symbols.functionDiscovery, cached);
  assert.deepEqual(symbols.functionDiscovery, { ...cached });
});

test('dependency guard: the transaction never depends on the byte-rewrite transaction', () => {
  const sourcePath = fileURLToPath(new URL('../../../js/analysis/discovery/topology-refinement-transaction.js', import.meta.url));
  const source = fs.readFileSync(sourcePath, 'utf8');
  const imported = /from\s+['"]([^'"]+)['"]/g;
  const specs = [...source.matchAll(imported)].map((match) => match[1]);
  assert.equal(specs.some((spec) => spec.includes('transaction-v2')), false, TOPOLOGY_REFINEMENT_FORBIDDEN_DEPENDENCY);
  assert.equal(specs.length, 0, 'the transaction owns no byte/loader/source dependency');
});
