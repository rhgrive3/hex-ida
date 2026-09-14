import assert from 'node:assert/strict';
import test from 'node:test';

import { EvidenceStore } from '../js/ai/evidence.js';

const structuredAddress = (tail) => Array.from({ length: 1001 }, (_, i) => i).map((v, i) => (i === 1000 ? tail : v));

test('#5952 structured addresses that differ past jsonSafe truncation are not verified-best', () => {
  const store = new EvidenceStore();
  store.add({ id: 'ev-real', kind: 'observation', title: 'real verification' });
  store.ingestPlan({
    best: { address: structuredAddress('BEST') },
    candidates: [{
      address: structuredAddress('DIFFERENT'),
      name: 'different candidate',
      score: 1,
      evidence: ['ev-real'],
      verification: { verified: true, evidenceIds: ['ev-real'] },
    }],
  });
  const verified = store.all().filter((r) => r.status === 'verified');
  assert.equal(verified.length, 0, 'structured addresses must not reach the verification authority');
});

test('#5952 structured addresses differing past 200 properties are not verified-best', () => {
  const make = (tail) => {
    const obj = {};
    for (let i = 0; i < 201; i++) obj[`k${i}`] = i;
    obj.k200 = tail;
    return obj;
  };
  const store = new EvidenceStore();
  store.ingestPlan({
    best: { address: make('BEST') },
    candidates: [{
      address: make('DIFFERENT'),
      name: 'different candidate',
      score: 1,
      evidence: ['ev-real'],
      verification: { verified: true, evidenceIds: ['ev-real'] },
    }],
  });
  assert.equal(store.all().filter((r) => r.status === 'verified').length, 0);
});

test('#5952 non-string evidence ids cannot enter the explicit verification set', () => {
  const store = new EvidenceStore();
  store.add({ id: 'ev-real', kind: 'observation', title: 'real verification' });
  store.ingestPlan({
    best: { address: '0x1000' },
    candidates: [{
      address: '0x1000',
      name: 'candidate',
      score: 1,
      evidence: [{ toString() { return 'ev-real'; } }, ['ev-real'], 42, null, 'ev-real'],
      verification: { verified: true, evidenceIds: [['ev-real'], { id: 'ev-real' }, 42] },
    }],
  });
  // Only the primitive string 'ev-real' may carry verified authority.
  const verified = store.all().filter((r) => r.status === 'verified');
  assert.ok(verified.some((r) => r.kind === 'candidate-verification'), 'legit string path still verified');
  assert.ok(verified.every((r) => r.id !== 'ev-real'), 'coerced ids must not add verified records');
});

test('#5952 legit primitive-address verified-best authority is preserved', () => {
  const store = new EvidenceStore();
  store.add({ id: 'ev-real', kind: 'observation', title: 'real verification' });
  const out = store.ingestPlan({
    best: { address: '0x1000' },
    candidates: [{
      address: '0x1000',
      name: 'best candidate',
      score: 1,
      evidence: ['ev-real'],
      verification: { verified: true, evidenceIds: ['ev-real'] },
    }],
  });
  const verified = out.filter((r) => r.status === 'verified');
  assert.ok(verified.some((r) => r.kind === 'candidate-verification'));
  assert.ok(verified.some((r) => r.kind === 'candidate-source'));
});

test('#5952 #3344 primitive-vs-structured aliasing stays rejected', () => {
  const store = new EvidenceStore();
  store.ingestPlan({
    best: { address: '0x1000' },
    candidates: [{
      address: ['0x1000'],
      name: 'candidate',
      score: 1,
      evidence: ['ev-real'],
      verification: { verified: true, evidenceIds: ['ev-real'] },
    }],
  });
  assert.equal(store.all().filter((r) => r.status === 'verified').length, 0);
});
