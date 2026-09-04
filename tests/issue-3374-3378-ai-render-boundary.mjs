import assert from 'node:assert/strict';
import { normalizeResponse, normalizeStatus, STATUS } from '../js/ai/render/normalize.js';

assert.equal(normalizeStatus(['verified']), STATUS.UNKNOWN);
assert.equal(normalizeStatus(['supported']), STATUS.UNKNOWN);
assert.equal(normalizeStatus(['verified'], 0.8), STATUS.SUPPORTED);
const poisonStatus = { toString() { throw new Error('structured status was coerced'); } };
assert.equal(normalizeStatus(poisonStatus), STATUS.UNKNOWN);

const poisonRef = { toString() { throw new Error('structured evidence id was coerced'); } };
const model = normalizeResponse({
  answer: 'typed evidence boundary',
  evidence: [
    { id: 'ev-real', kind: 'observation', status: 'verified', title: 'real evidence' },
    { id: ['ev-real'], kind: 'observation', status: 'supported', title: 'invalid structured identity' },
    { kind: 'observation', status: 'unknown', title: 'legacy id fallback' },
  ],
  hypotheses: [
    {
      id: 'hyp-invalid-ref', claim: 'structured ref cannot alias', status: 'open',
      supportEvidenceIds: [['ev-real'], poisonRef], contradictionEvidenceIds: [], missingEvidence: [],
    },
    {
      id: 'hyp-valid-ref', claim: 'string ref still resolves', status: 'supported',
      supportEvidenceIds: ['ev-real'], contradictionEvidenceIds: [], missingEvidence: [],
    },
    {
      id: ['hyp-invalid'], claim: 'structured hypothesis identity is rejected', status: 'open',
      supportEvidenceIds: ['ev-real'], contradictionEvidenceIds: [], missingEvidence: [],
    },
  ],
});

assert.deepEqual(model.evidence.map((item) => item.title), ['real evidence', 'legacy id fallback']);
assert.equal(model.evidence[1].id, 'ev2');
assert.deepEqual(model.hypotheses.map((item) => item.id), ['hyp-invalid-ref', 'hyp-valid-ref']);
assert.equal(model.hypotheses[0].support.length, 0);
assert.equal(model.hypotheses[1].support[0].id, 'ev-real');

console.log('issue-3374-3378-ai-render-boundary: PASS');
