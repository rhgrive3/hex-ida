import test from 'node:test';
import assert from 'node:assert/strict';

import { jevShortlist, rerankWithJev, adviseWithJev } from '../js/pinpoint.js';

test('advisory choices remain visible while every committed result stays local', async () => {
  const candidates = [{ key: 'first' }, { key: 'second' }, { key: 'third' }];
  const local = { verdict: 'ambiguous', top: candidates[0], candidates };
  const suggestions = [];
  for (const choiceIndex of [1, 2, 0]) {
    const result = await adviseWithJev('a value', local, { enabled: true,
      client: { call: async () => ({ choiceIndex, selectedKey: candidates[choiceIndex].key }) } });
    assert.equal(result.top1, local.top);
    assert.equal(result.hexResult, local);
    assert.equal(result.source, 'hex');
    assert.equal(result.advisory.advisoryOnly, true);
    suggestions.push(result.advisory.candidate.key);
  }
  assert.deepEqual(suggestions, ['second', 'third', 'first']);
  const failed = await adviseWithJev('a value', local, { enabled: true,
    client: { call: async () => { throw new Error('HTTP failure'); } } });
  assert.equal(failed.top1, local.top);
  assert.equal(failed.advisory.candidate, null);
});

test('rerankWithJev rejects conflicting or malformed supplied choice identities', async () => {
  const candidates = [{ key: 'ownerA:offset8', score: 2 }, { key: 'ownerB:offset8', score: 1 }];
  const hex = { verdict: 'ambiguous', top: candidates[0], candidates };
  for (const response of [
    { selectedKey: 'invented', choiceIndex: 1 },
    { selectedKey: candidates[0].key, choiceIndex: 1 },
    { selectedKey: candidates[1].key, choiceIndex: 999 },
    { selectedKey: candidates[1].key, choiceIndex: '1' },
    { selectedKey: null, choiceIndex: 1 },
  ]) {
    const result = await rerankWithJev('member query', hex, { enabled: true, client: { call: async () => response } });
    assert.equal(result.top1, hex.top);
    assert.equal(result.source, 'hex');
  }
  const good = await rerankWithJev('member query', hex, {
    enabled: true, client: { call: async () => ({ selectedKey: candidates[1].key, choiceIndex: 1 }) },
  });
  assert.equal(good.top1, candidates[1]);
});

test('rerankWithJev rejects duplicate structural keys instead of guessing an owner', async () => {
  const candidates = [{ key: 'baseline', score: 3 }, { key: 'duplicate', score: 2 }, { key: 'duplicate', score: 1 }];
  const hex = { verdict: 'ambiguous', top: candidates[0], candidates };
  const result = await rerankWithJev('member query', hex, {
    enabled: true, client: { call: async () => ({ selectedKey: 'duplicate', choiceIndex: 1 }) },
  });
  assert.equal(result.top1, hex.top);
  assert.equal(result.source, 'hex');
});

test('rerankWithJev actually times out a nonresponding client and aborts its request', async () => {
  const candidates = [{ key: 'first' }, { key: 'second' }];
  const hex = { verdict: 'ambiguous', top: candidates[0], candidates };
  let requestSignal;
  const result = await rerankWithJev('member query', hex, {
    enabled: true, timeoutMs: 10,
    client: { call: async ({ signal }) => { requestSignal = signal; return new Promise(() => {}); } },
  });
  assert.equal(requestSignal.aborted, true);
  assert.equal(result.top1, hex.top);
  assert.equal(result.source, 'hex');
});

test('rerankWithJev rejects a response after the interactive snapshot changes', async () => {
  const candidates = [{ key: 'first' }, { key: 'second' }];
  const hex = { verdict: 'ambiguous', top: candidates[0], candidates };
  let revision = 1;
  const result = await rerankWithJev('member query', hex, {
    enabled: true, isCurrent: () => revision === 1,
    client: { call: async () => { revision++; return { selectedKey: 'second', choiceIndex: 1 }; } },
  });
  assert.equal(result.top1, hex.top);
  assert.equal(result.source, 'hex');
});

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
