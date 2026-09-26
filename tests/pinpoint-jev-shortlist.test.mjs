import test from 'node:test';
import assert from 'node:assert/strict';

import { jevShortlist, rerankWithJev } from '../js/pinpoint.js';

test('jevShortlist: clamps candidate count to <=255 even with 400 candidates', () => {
  const candidates = Array.from({ length: 400 }, (_, i) => ({
    id: `cand_${i}`,
    key: `Class#${i}#_field${i}`,
    score: 400 - i,
  }));

  const slDefault = jevShortlist(candidates);
  assert.equal(slDefault.length, 64);

  const sl255 = jevShortlist(candidates, { max: 255 });
  assert.equal(sl255.length, 255);

  const slOver = jevShortlist(candidates, { max: 500 });
  assert.equal(slOver.length, 255);

  const slZero = jevShortlist(candidates, { max: 0 });
  assert.equal(slZero.length, 1);
});

test('jevShortlist: preserves determinism and stable tiebreak order', () => {
  const candidates = [
    { key: 'B', score: 10 },
    { key: 'A', score: 10 },
    { key: 'C', score: 20 },
  ];

  const res1 = jevShortlist(candidates, { max: 10 });
  const res2 = jevShortlist(candidates, { max: 10 });
  assert.deepEqual(res1, res2);

  // Highest score first, then tiebreak by key ascending
  assert.equal(res1[0].key, 'C');
  assert.equal(res1[1].key, 'A');
  assert.equal(res1[2].key, 'B');
});

test('jevShortlist: retains Hex top1 in rank 0', () => {
  const candidates = Array.from({ length: 50 }, (_, i) => ({
    key: `cand_${i}`,
    score: 100 - i,
  }));

  const sl = jevShortlist(candidates, { max: 10 });
  assert.equal(sl[0].key, 'cand_0');
});

test('rerankWithJev: default disabled returns Hex result unchanged', async () => {
  const hexResult = {
    verdict: 'ambiguous',
    top: { key: 'cand_0', field: { name: 'cand_0' } },
    candidates: [
      { key: 'cand_0', field: { name: 'cand_0' }, score: 10 },
      { key: 'cand_1', field: { name: 'cand_1' }, score: 5 },
    ],
  };

  const res = await rerankWithJev('test query', hexResult);
  assert.equal(res.source, 'hex');
  assert.equal(res.top1, hexResult.top);
});

test('rerankWithJev: fail-closed on thrown client error, network failure, or timeout', async () => {
  const hexResult = {
    verdict: 'ambiguous',
    top: { key: 'cand_0', field: { name: 'cand_0' } },
    candidates: [
      { key: 'cand_0', field: { name: 'cand_0' }, score: 10 },
      { key: 'cand_1', field: { name: 'cand_1' }, score: 5 },
    ],
  };

  const throwingClient = {
    async call() {
      throw new Error('API network timeout');
    },
  };

  const res = await rerankWithJev('test query', hexResult, {
    enabled: true,
    client: throwingClient,
  });

  assert.equal(res.source, 'hex');
  assert.equal(res.top1, hexResult.top);
  assert.equal(res.advisory.withinShortlist, false);
});

test('rerankWithJev: fail-closed on malformed or null Jev response', async () => {
  const hexResult = {
    verdict: 'ambiguous',
    top: { key: 'cand_0', field: { name: 'cand_0' } },
    candidates: [
      { key: 'cand_0', field: { name: 'cand_0' }, score: 10 },
      { key: 'cand_1', field: { name: 'cand_1' }, score: 5 },
    ],
  };

  const malformedClient = {
    async call() {
      return null;
    },
  };

  const res = await rerankWithJev('test query', hexResult, {
    enabled: true,
    client: malformedClient,
  });

  assert.equal(res.source, 'hex');
  assert.equal(res.top1, hexResult.top);
});

test('rerankWithJev: fail-closed on out-of-shortlist or invented candidate', async () => {
  const hexResult = {
    verdict: 'ambiguous',
    top: { key: 'cand_0', field: { name: 'cand_0' } },
    candidates: [
      { key: 'cand_0', field: { name: 'cand_0' }, score: 10 },
      { key: 'cand_1', field: { name: 'cand_1' }, score: 5 },
    ],
  };

  const hallucinatingClient = {
    async call() {
      return {
        selectedKey: 'invented_candidate_key_not_in_hex',
        choiceIndex: 999,
        confidence: 0.99,
      };
    },
  };

  const res = await rerankWithJev('test query', hexResult, {
    enabled: true,
    client: hallucinatingClient,
  });

  assert.equal(res.source, 'hex');
  assert.equal(res.top1, hexResult.top);
  assert.equal(res.advisory.withinShortlist, false);
});

test('rerankWithJev: never raises verdict to strong (no fact minting, no strong promotion)', async () => {
  const hexResult = {
    verdict: 'ambiguous',
    top: { key: 'cand_0', field: { name: 'cand_0' } },
    candidates: [
      { key: 'cand_0', field: { name: 'cand_0' }, score: 10 },
      { key: 'cand_1', field: { name: 'cand_1' }, score: 5 },
    ],
  };

  const validClient = {
    async call() {
      return {
        selectedKey: 'cand_1',
        choiceIndex: 1,
        confidence: 0.99,
        preference: 0.95,
      };
    },
  };

  const res = await rerankWithJev('test query', hexResult, {
    enabled: true,
    client: validClient,
  });

  assert.equal(res.source, 'jev');
  assert.equal(res.top1.key, 'cand_1');
  assert.equal(res.advisory.withinShortlist, true);
  // Original hexResult verdict remains ambiguous (verdict is not modified to strong)
  assert.equal(res.hexResult.verdict, 'ambiguous');
});

test('rerankWithJev: does not route strong verdicts (only routed for ambiguous/non-strong)', async () => {
  const hexResult = {
    verdict: 'confirmed',
    top: { key: 'cand_0', field: { name: 'cand_0' } },
    candidates: [
      { key: 'cand_0', field: { name: 'cand_0' }, score: 10 },
      { key: 'cand_1', field: { name: 'cand_1' }, score: 5 },
    ],
  };

  let called = false;
  const client = {
    async call() {
      called = true;
      return { selectedKey: 'cand_1', choiceIndex: 1 };
    },
  };

  const res = await rerankWithJev('test query', hexResult, {
    enabled: true,
    client,
  });

  assert.equal(called, false);
  assert.equal(res.source, 'hex');
  assert.equal(res.top1.key, 'cand_0');
});
