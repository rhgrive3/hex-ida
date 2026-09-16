/*
 * Issue #8673 — a locally valid positive candidate verification must not be
 * widened into 0.98 / `verified` global candidate-selection authority while
 * the planner reports partial coverage.
 *
 * The three C2 consumers (deterministic agent answer, deterministic AI control
 * fallback, local fallback engine) must share one coverage-aware decision, and
 * a genuinely complete plan must keep the existing high authority.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticModel } from '../../../js/blocks.js';
import { deterministicAnswer } from '../../../js/agent/runtime.js';
import { globalCandidateAuthority, terminalCandidateAuthority } from '../../../js/agent/candidate-authority.js';
import { planAnalysisGoal } from '../../../js/query/planner.js';
import { FACT } from '../../../js/semantic.js';
import { createLocalEngine } from '../../../js/ai/ui/local-engine-base.js';
import { normalizeResponse } from '../../../js/ai/render/normalize.js';
import { deterministicConfidence, deterministicDecision } from '../../../js/ai/control/runtime-support.js';

const TARGET = 0x1000n;

function page(results, completeness = {}) {
  const returned = completeness.returned ?? results.length;
  const total = completeness.total ?? results.length;
  return {
    results,
    returned,
    total,
    complete: completeness.complete ?? true,
    truncated: completeness.truncated ?? !(completeness.complete ?? true),
    coverage: completeness.coverage ?? 1,
    reason: completeness.reason ?? null,
  };
}

function query() {
  return {
    action: 'increase',
    entity: { terms: ['counter'] },
    context: { terms: [] },
    event: { terms: [] },
    dataflow: { shape: 'read-modify-write' },
    expect: { calls: [] },
    confident: true,
    goal: 'increase counter',
  };
}

const RMW_FACT = { kind: FACT.RMW, location: { key: 'field:counter', disp: 0x10 }, evidence: ['ev-rmw'] };

/**
 * Real planner with the issue's Counterexample A producer shape: discovery and
 * semantic enumeration each report one observed row out of two.
 */
async function runPlanned({ searchComplete = true, semanticComplete = true } = {}) {
  const tools = {
    async search_functions(term) {
      return term === 'counter'
        ? page([{ addr: TARGET, name: 'partial_candidate' }], searchComplete
          ? {}
          : { returned: 1, total: 2, complete: false, truncated: true, coverage: 0.5, reason: 'scan-budget' })
        : page([]);
    },
    async search_strings() { return page([]); },
    async get_xrefs() { return { functions: [], complete: true, returned: 0, total: 0, coverage: 1 }; },
    async get_callers() { return page([]); },
    async get_callees() { return page([]); },
    async get_function(address) {
      return { address: BigInt(address), name: 'partial_candidate', instructions: 1, summary: { calls: [] }, cost: { functions: 0, disassembly: 0 } };
    },
    async get_semantic_facts() {
      return page([RMW_FACT], semanticComplete
        ? {}
        : { returned: 1, total: 2, complete: false, truncated: true, coverage: 0.5, reason: 'semantic-ir-truncated' });
    },
    async verify_field_update() { return { verified: true, evidence: ['ev-positive'] }; },
    async find_thresholds() { return page([]); },
  };
  return planAnalysisGoal(query(), {}, {
    tools, maxFunctions: 8, maxDisassembly: 64, maxSearchResults: 8, maxExpansions: 1, maxToolCalls: 32, timeoutMs: 2_000,
  });
}

const LOCAL_BASE = 0x1000n;

function localModel() {
  const lines = ['ldr w8, [x0, #0x20]', 'add w8, w8, w1', 'str w8, [x0, #0x20]', 'ret'];
  const rows = lines.map((line, index) => {
    const trimmed = line.trim();
    const split = trimmed.indexOf(' ');
    return {
      row: index,
      address: LOCAL_BASE + BigInt(index * 4),
      mn: split < 0 ? trimmed : trimmed.slice(0, split),
      ops: split < 0 ? '' : trimmed.slice(split + 1),
    };
  });
  const rowOfAddress = (addr) => {
    const delta = addr - LOCAL_BASE;
    if (delta < 0n || delta >= BigInt(lines.length * 4)) return null;
    return Number(delta / 4n);
  };
  return buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
}

function localApp({ withProgram }) {
  return {
    store: new Map([['fileInfo', { name: 'fixture' }], ['sliceIndex', 0], ['regions', []]]),
    notes: { structs: [] }, symbols: null, recognition: { records: [] }, stringIndex: [],
    candidateFunctions: [LOCAL_BASE],
    ...(withProgram
      ? { program: {
        callersOf: () => [],
        calleesOf: () => [],
        functionRange: () => ({ start: LOCAL_BASE, end: LOCAL_BASE + 16n, ok: true }),
      } }
      : {}),
    analyze: async () => localModel(),
  };
}

async function runLocalEngine({ withProgram }) {
  const app = localApp({ withProgram });
  return createLocalEngine(app, app).run({ question: 'XPが増える場所', mode: 'agent', onActivity: () => {} });
}

test('#8673 counterexample A: partial search + positive local verification cannot mint 0.98', async () => {
  const plan = await runPlanned({ searchComplete: false });
  assert.equal(plan.completeness.complete, false);
  assert.equal(plan.best.complete, false);
  assert.equal(plan.best.verification.verified, true, 'the local positive proof must be preserved');
  const authority = globalCandidateAuthority(plan);
  assert.equal(authority.authoritative, false);
  assert.ok(authority.reasons.includes('plan-coverage-incomplete'));
  const answer = deterministicAnswer(plan);
  assert.ok(answer.conclusion, 'the best observed candidate stays visible');
  assert.ok(answer.confidence < 0.98, `confidence ${answer.confidence} must stay below terminal global authority`);
  assert.deepEqual(plan.missingEvidence.filter((id) => id === 'search-incomplete'), ['search-incomplete']);
  assert.ok(answer.missingEvidence.includes('search-incomplete'), 'partiality must stay observable');
  const gate = answer.reasons.find((item) => item.kind === 'candidate-coverage-authority');
  assert.equal(gate.authoritative, false);
  assert.ok(gate.reasons.length > 0 && gate.reasons.length <= 4, 'coverage reasons are reported and bounded');
});

test('#8673: partial semantic enumeration alone cannot mint terminal authority', async () => {
  const plan = await runPlanned({ semanticComplete: false });
  assert.equal(plan.completeness.complete, false);
  assert.equal(plan.semanticCompleteness.complete, false);
  const answer = deterministicAnswer(plan);
  assert.ok(answer.confidence < 0.98, `confidence ${answer.confidence}`);
  assert.equal(globalCandidateAuthority(plan).authoritative, false);
  assert.ok(globalCandidateAuthority(plan).reasons.includes('semantic-coverage-incomplete'));
  assert.ok(answer.missingEvidence.includes('semantic-facts-incomplete'));
});

test('#8673: both search and semantic partial produce no global strongest-candidate authority', async () => {
  const plan = await runPlanned({ searchComplete: false, semanticComplete: false });
  assert.equal(plan.completeness.complete, false);
  const answer = deterministicAnswer(plan);
  assert.ok(answer.confidence < 0.98);
  assert.ok(plan.missingEvidence.includes('search-incomplete'));
  assert.ok(plan.missingEvidence.includes('semantic-facts-incomplete'));
  const decision = deterministicDecision(plan, { mode: 'agent' }, null);
  assert.ok(!decision.answer.includes('最も強い候補は'), 'prose must not claim the terminal strongest candidate');
  assert.ok(decision.answer.includes('暫定的な最有力候補'), 'prose must state the best-so-far scope');
  assert.ok(decision.confidence < 0.98);
  assert.deepEqual(decision.followups, plan.missingEvidence, 'missing evidence must be carried, not hidden');
});

test('#8673: candidate-local incompleteness cannot be ignored when minting goal authority', async () => {
  const plan = {
    best: {
      address: TARGET, name: 'partial_candidate', verification: { verified: true },
      complete: false, semanticFacts: [{}], semanticCompleteness: { complete: true },
    },
    completeness: { complete: true, partial: false, budgetLimited: false },
    partial: false,
    evidence: ['ev-positive'],
    missingEvidence: ['search-incomplete'],
  };
  const authority = globalCandidateAuthority(plan);
  assert.equal(authority.authoritative, false);
  assert.ok(authority.reasons.includes('candidate-coverage-incomplete'));
  assert.ok(deterministicAnswer(plan).confidence < 0.98);
  assert.ok(deterministicConfidence(plan) < 0.98);
});

test('#8673 counterexample B: deterministic AI fallback keeps status, prose and confidence consistent', () => {
  const plan = {
    best: {
      address: TARGET, name: 'partial_candidate', verification: { verified: true }, complete: false, semanticFacts: [{}],
    },
    completeness: { complete: false, partial: true, reason: 'scan-budget' },
    partial: true,
    evidence: ['ev-positive'],
    missingEvidence: ['search-incomplete', 'semantic-facts-incomplete'],
  };
  const decision = deterministicDecision(plan, { mode: 'agent' }, null);
  assert.notEqual(decision.confidence, 0.98, 'no machine-readable terminal authority on a partial plan');
  assert.ok(!decision.answer.includes('最も強い候補は'));
  assert.ok(!decision.answer.includes('更新経路を検証しました'));
  assert.deepEqual(decision.followups, ['search-incomplete', 'semantic-facts-incomplete']);
  assert.equal(deterministicConfidence(plan), decision.confidence,
    'the control fallback and the deterministic answer must agree on one policy');
});

test('#8673 counterexample C: local fallback engine keeps verification explicitly local', async () => {
  const result = await runLocalEngine({ withProgram: false });
  assert.ok(result.evidence.length > 0, 'the observed candidate remains publishable');
  assert.equal(result.evidence.some((item) => item.status === 'verified'), false,
    'no candidate evidence may claim verified authority over an uncovered universe');
  assert.equal(result.evidence.every((item) => item.status === 'supported'), true);
  assert.ok(result.evidence.some((item) => /候補局所|locally verified/.test(item.title)),
    'locally verified candidates must say so explicitly');
  assert.equal(result.hypotheses.length, 1);
  assert.equal(result.hypotheses[0].status, 'supported', 'the goal-level hypothesis stays non-verified');
  assert.ok(result.confidence < 0.98, `engine confidence ${result.confidence}`);
  const normalized = normalizeResponse(result, { mode: 'agent', style: 'beginner' });
  assert.equal(normalized.hypotheses[0].status, 'supported',
    'presentation must not re-upgrade the conservative authority decision');
});

test('#8673: complete coverage preserves the existing 0.98/verified behavior', async () => {
  const plan = await runPlanned();
  assert.equal(plan.completeness.complete, true);
  assert.equal(plan.best.complete, true);
  assert.equal(terminalCandidateAuthority(plan).authoritative, true);
  assert.equal(deterministicAnswer(plan).confidence, 0.98);
  assert.equal(deterministicConfidence(plan), 0.98);
  const decision = deterministicDecision(plan, { mode: 'agent' }, null);
  assert.equal(decision.confidence, 0.98);
  assert.ok(decision.answer.includes('最も強い候補は'));
  const result = await runLocalEngine({ withProgram: true });
  assert.equal(result.hypotheses[0].status, 'verified');
  assert.ok(result.hypotheses[0].supportEvidenceIds.length > 0, '#5797 support invariant still holds');
  assert.ok(result.evidence.some((item) => item.status === 'verified'));
  assert.equal(result.confidence, 0.98);
});

test('#8673: a malformed completeness report cannot be read as complete', () => {
  for (const completeness of [{ complete: 'true' }, { complete: 1 }, { complete: null }, 'complete', []]) {
    const plan = {
      best: { address: TARGET, name: 'c', verification: { verified: true }, semanticFacts: [{}] },
      completeness,
    };
    assert.equal(globalCandidateAuthority(plan).authoritative, false, JSON.stringify(completeness));
    assert.ok(deterministicAnswer(plan).confidence < 0.98);
  }
});
