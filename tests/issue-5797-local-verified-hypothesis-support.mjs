// Regression for #5797: a 'verified' hypothesis from the local fallback must
// name its verified supporting evidence — the same invariant HypothesisStore
// enforces in core (verified requires non-empty verified supportEvidenceIds).
// The deterministic planner is driven with a real field-update model so the
// response actually carries a verified best candidate.
import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { createLocalEngine } from '../js/ai/ui/local-engine-base.js';
import { normalizeResponse } from '../js/ai/render/normalize.js';

const BASE = 0x1000n;

function modelOf(lines) {
  const rows = lines.map((line, index) => {
    const trimmed = line.trim();
    const split = trimmed.indexOf(' ');
    return { row: index, address: BASE + BigInt(index * 4), mn: split < 0 ? trimmed : trimmed.slice(0, split), ops: split < 0 ? '' : trimmed.slice(split + 1) };
  });
  const rowOfAddress = (addr) => {
    const delta = addr - BASE;
    if (delta < 0n || delta >= BigInt(lines.length * 4)) return null;
    return Number(delta / 4n);
  };
  return buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
}

const app = {
  store: new Map([['fileInfo', { name: 'fixture' }], ['sliceIndex', 0], ['regions', []]]),
  notes: { structs: [] }, symbols: null, recognition: { records: [] }, stringIndex: [],
  candidateFunctions: [BASE],
  analyze: async () => modelOf([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, w1',
    'str w8, [x0, #0x20]',
    'ret',
  ]),
};

const engine = createLocalEngine(app, app);
const result = await engine.run({
  question: 'XPが増える場所', mode: 'agent', onActivity: () => {},
});

const hypotheses = result.hypotheses || [];
assert.equal(hypotheses.length, 1, 'the deterministic best candidate yields one hypothesis');
const hypothesis = hypotheses[0];
assert.equal(hypothesis.status, 'verified',
  'this fixture must exercise the verified path rather than passing by downgrade');
assert.ok(hypothesis.supportEvidenceIds.length > 0,
  'a verified hypothesis must carry supporting evidence (#5797 invariant)');

const evidence = result.evidence || [];
const evidenceById = new Map(evidence.map((item) => [item.id, item]));
for (const supportId of hypothesis.supportEvidenceIds) {
  const support = evidenceById.get(supportId);
  assert.ok(support, `support evidence ${supportId} must be published in the same response`);
  assert.equal(support.status, 'verified', `support evidence ${supportId} must itself be verified`);
}
assert.ok(evidence.some((item) => item.status === 'verified'),
  'the verified candidate evidence the hypothesis points at is present');

// The UI normalizer must resolve the support IDs rather than dropping them.
// renderHypotheses consumes this normalized `support` array to draw the ✓ rows.
const normalized = normalizeResponse(result, { mode: 'agent', style: 'beginner' });
assert.equal(normalized.hypotheses.length, 1);
const uiHypothesis = normalized.hypotheses[0];
assert.equal(uiHypothesis.status, 'verified');
assert.equal(uiHypothesis.unresolvedEvidenceIds.length, 0,
  'every support ID must resolve in the same normalized response');
assert.equal(uiHypothesis.support.length, hypothesis.supportEvidenceIds.length,
  'UI normalization must preserve every verified support link');
assert.ok(uiHypothesis.support.length > 0,
  'a verified UI card must have at least one supporting check to render');
for (const support of uiHypothesis.support) {
  assert.equal(support.status, 'verified', 'rendered support must retain verified status');
}

console.log('issue #5797 local verified hypothesis support evidence: PASS');
