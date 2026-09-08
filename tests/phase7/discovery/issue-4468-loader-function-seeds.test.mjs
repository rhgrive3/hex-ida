import assert from 'node:assert/strict';
import test from 'node:test';

import { functionCandidates } from '../../../js/analysis/index.js';
import { functionSeed, mergeFunctionSeeds } from '../../../js/binary/model.js';
import { loaderProducer, symbolTableProducer } from '../../../js/analysis/discovery/producers.js';

function candidateAt(result, address) {
  return result.candidates.find((candidate) => BigInt(candidate.start) === BigInt(address));
}

test('#4468 preserves validated canonical loader seeds and their extents', () => {
  const image = {
    functions: [
      { address: 0x140001000n, size: 0x20n, source: 'exception', confidence: 0.999 },
      { address: 0x140002000n, source: 'tls-callback', confidence: 0.999 },
      { address: 0x140003000n, end: 0x140003040n, source: 'guard-cf', confidence: 0.995 },
      {
        address: 0x401000n,
        size: 0x30n,
        name: 'foo',
        source: 'symbol',
        confidence: 0.995,
        exactFunctionStart: true,
        functionStartEvidence: 'validated ELF STT_FUNC extent',
      },
      {
        address: 0x402000n,
        size: 0x18n,
        source: 'ifunc-resolver',
        confidence: 0.995,
        exactFunctionStart: true,
      },
      { address: 0x5000n, source: 'heuristic', confidence: 1, exactFunctionStart: true },
      { address: 0x6000n, source: 'symbol', confidence: 0.89, exactFunctionStart: true },
    ],
    symbols: [{ address: 0x401000n, size: 0x30n, name: 'foo', kind: 'function' }],
    functionStarts: [],
    unwindEntries: [],
  };

  const evidence = loaderProducer.produce({ image });
  assert.deepEqual(evidence.map((item) => item.start), [
    String(0x140001000n),
    String(0x140002000n),
    String(0x140003000n),
    String(0x401000n),
    String(0x402000n),
  ]);
  assert.deepEqual(evidence.find((item) => item.start === '4198400').regions, [{ start: '4198400', end: '4198448', ownership: 'exclusive' }]);
  assert.ok(evidence.find((item) => item.start === '4198400').evidenceIds.includes('loader:source:symbol:4198400'));
  assert.deepEqual(evidence.find((item) => item.start === '4202496').regions, [{ start: '4202496', end: '4202520', ownership: 'exclusive' }]);
  assert.equal(evidence.some((item) => item.start === '20480'), false, 'heuristic source must not become loader authority');
  assert.equal(evidence.some((item) => item.start === '24576'), false, 'low-confidence explicit symbol must not become loader authority');

  const result = functionCandidates({ input: { image }, architectureId: 'x86_64' });
  for (const address of [0x140001000n, 0x140002000n, 0x140003000n, 0x401000n, 0x402000n]) {
    assert.equal(candidateAt(result, address)?.startState, 'exact', `canonical loader seed ${address.toString(16)} must remain exact`);
  }
  assert.equal(candidateAt(result, 0x401000n)?.extentState, 'exact');
  assert.deepEqual(candidateAt(result, 0x401000n)?.regions, [{ start: '4198400', end: '4198448', ownership: 'exclusive' }]);
  assert.equal(candidateAt(result, 0x402000n)?.extentState, 'exact');
  assert.equal(candidateAt(result, 0x5000n), undefined);
  assert.equal(candidateAt(result, 0x6000n), undefined);
});

test('#4468 keeps the legacy functionStarts compatibility projection', () => {
  const image = {
    functions: [{ address: 0x7000n, size: 0x10n, source: 'function_starts', name: 'canonical' }],
    functionStarts: [{ address: 0x7000n, name: 'legacy-duplicate' }, { address: 0x7100n, name: 'legacy-only' }],
    unwindEntries: [],
  };
  const evidence = loaderProducer.produce({ image });
  assert.deepEqual(evidence.map((item) => item.start), ['28672', '28928']);
  assert.equal(evidence[0].name, 'canonical');
  assert.deepEqual(evidence[0].regions, [{ start: '28672', end: '28688', ownership: 'exclusive' }]);
});

test('#4468 symbol producer preserves normalized symbol size without granting exact authority', () => {
  const image = {
    functions: [],
    symbols: [{ address: 0x8000n, size: 0x20n, name: 'symbol-only', kind: 'function' }],
    functionStarts: [],
    unwindEntries: [],
  };
  const evidence = symbolTableProducer.produce({ image });
  assert.deepEqual(evidence[0].regions, [{ start: '32768', end: '32800', ownership: 'exclusive' }]);
  const candidate = candidateAt(functionCandidates({ input: { image }, architectureId: 'x86_64' }), 0x8000n);
  assert.equal(candidate?.startState, 'heuristic');
  assert.equal(candidate?.extentState, 'heuristic');
});

test('#4468 preserves exact COFF-style seeds after canonical provenance merging', () => {
  const [merged] = mergeFunctionSeeds([
    functionSeed(0x9000n, {
      name: 'coffFn',
      source: 'symbol',
      confidence: 0.98,
      exactFunctionStart: true,
      functionStartEvidence: 'COFF derived function type',
    }),
    functionSeed(0x9000n, { name: 'coffFn', source: 'export', confidence: 0.95 }),
  ]);
  assert.deepEqual(merged.sources, ['symbol', 'export']);
  assert.equal(merged.exactFunctionStart, true);
  assert.equal(merged.exactFunctionStartConfidence, 0.98);

  const image = { functions: [merged], functionStarts: [], unwindEntries: [] };
  const evidence = loaderProducer.produce({ image });
  assert.deepEqual(evidence.map((item) => item.start), ['36864']);
  assert.ok(evidence[0].evidenceIds.includes('loader:source:symbol:36864'));
  assert.ok(evidence[0].evidenceIds.includes('loader:source:export:36864'));
  assert.equal(candidateAt(functionCandidates({ input: { image }, architectureId: 'x86_64' }), 0x9000n)?.startState, 'exact');
});

test('#4468 requires primitive finite confidence for explicit exact seeds', () => {
  const malformed = [
    ['string confidence', '0.995'],
    ['array confidence', ['0.995']],
    ['valueOf object confidence', { valueOf: () => 0.995 }],
    ['boxed number confidence', new Number(0.995)],
    ['boolean confidence', true],
    ['NaN confidence', Number.NaN],
    ['infinite confidence', Number.POSITIVE_INFINITY],
  ];
  for (const [label, confidence] of malformed) {
    const image = {
      functions: [{ address: 0x9100n, source: 'symbol', exactFunctionStart: true, confidence }],
      symbols: [],
      functionStarts: [],
      unwindEntries: [],
    };
    assert.equal(loaderProducer.produce({ image }).length, 0, `${label} must not mint loader authority`);
    assert.equal(
      candidateAt(functionCandidates({ input: { image }, architectureId: 'x86_64' }), 0x9100n),
      undefined,
      `${label} must not become an exact function candidate`,
    );
  }

  const malformedExactConfidence = {
    functions: [{
      address: 0x9101n,
      source: 'ifunc-resolver',
      exactFunctionStart: true,
      confidence: 0.995,
      exactFunctionStartConfidence: ['0.995'],
    }],
    symbols: [],
    functionStarts: [],
    unwindEntries: [],
  };
  assert.equal(loaderProducer.produce({ image: malformedExactConfidence }).length, 0);

  const valid = {
    functions: [{ address: 0x9102n, source: 'symbol', exactFunctionStart: true, confidence: 0.995 }],
    symbols: [],
    functionStarts: [],
    unwindEntries: [],
  };
  const validEvidence = loaderProducer.produce({ image: valid });
  assert.equal(validEvidence.length, 1);
  assert.equal(candidateAt(functionCandidates({ input: { image: valid }, architectureId: 'x86_64' }), 0x9102n)?.startState, 'exact');
});

console.log('issue-4468 loader function seeds: ok');
