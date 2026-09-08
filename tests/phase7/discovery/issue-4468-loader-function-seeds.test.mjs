import assert from 'node:assert/strict';
import test from 'node:test';

import { functionCandidates } from '../../../js/analysis/index.js';
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
  ]);
  assert.deepEqual(evidence.find((item) => item.start === '4198400').regions, [{ start: '4198400', end: '4198448', ownership: 'exclusive' }]);
  assert.ok(evidence.find((item) => item.start === '4198400').evidenceIds.includes('loader:source:symbol:4198400'));
  assert.equal(evidence.some((item) => item.start === '20480'), false, 'heuristic source must not become loader authority');
  assert.equal(evidence.some((item) => item.start === '24576'), false, 'low-confidence explicit symbol must not become loader authority');

  const result = functionCandidates({ input: { image }, architectureId: 'x86_64' });
  for (const address of [0x140001000n, 0x140002000n, 0x140003000n, 0x401000n]) {
    assert.equal(candidateAt(result, address)?.startState, 'exact', `canonical loader seed ${address.toString(16)} must remain exact`);
  }
  assert.equal(candidateAt(result, 0x401000n)?.extentState, 'exact');
  assert.deepEqual(candidateAt(result, 0x401000n)?.regions, [{ start: '4198400', end: '4198448', ownership: 'exclusive' }]);
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

console.log('issue-4468 loader function seeds: ok');
