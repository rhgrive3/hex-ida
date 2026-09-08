import assert from 'node:assert/strict';
import test from 'node:test';

import { functionCandidates } from '../../../js/analysis/index.js';
import { symbolTableProducer } from '../../../js/analysis/discovery/producers.js';

const at = (candidates, address) => candidates.find((candidate) => BigInt(candidate.start) === BigInt(address));

test('#4474 canonical symbol kinds gate symbol-table function evidence', () => {
  const image = {
    symbols: [
      { name: 'object', address: 0x2000n, kind: 'object', sizeBytes: 8 },
      { name: 'section', address: 0x2100n, kind: 'section' },
      { name: 'tls', address: 0x2200n, kind: 'tls' },
      { name: 'function', address: 0x2300n, kind: 'function' },
      { name: 'ifunc', address: 0x2400n, kind: 'indirect-function' },
      { name: 'legacy-false', address: 0x2500n, isFunction: false },
      { name: 'legacy', address: 0x2600n, isFunction: true },
      { name: 'untyped', address: 0x2700n },
    ],
  };

  const evidence = symbolTableProducer.produce({ image });
  assert.deepEqual(
    evidence.map((item) => BigInt(item.start)),
    [0x2300n, 0x2400n, 0x2600n, 0x2700n],
  );
});

test('#4474 data symbols do not combine with relocation targets into probable functions', () => {
  const data = 0x2000n;
  const image = {
    symbols: [{ name: 'object', address: data, kind: 'object', sizeBytes: 8 }],
    relocationTargets: [{ address: data }],
  };

  const result = functionCandidates({ input: { image }, architectureId: 'x86_64' });
  const candidate = at(result.candidates, data);
  assert.equal(candidate?.startState, 'heuristic');
  assert.equal(candidate?.startEvidence.some((item) => item.kind === 'symbol-table'), false);
});

test('#4474 function and indirect-function symbols remain corroborating evidence', () => {
  const image = {
    symbols: [
      { name: 'function', address: 0x2300n, kind: 'function' },
      { name: 'ifunc', address: 0x2400n, kind: 'indirect-function' },
    ],
  };

  const result = functionCandidates({ input: { image }, architectureId: 'x86_64' });
  assert.equal(at(result.candidates, 0x2300n)?.startState, 'heuristic');
  assert.equal(at(result.candidates, 0x2400n)?.startState, 'heuristic');
});
