import assert from 'node:assert/strict';
import test from 'node:test';

import { functionCandidates } from '../../../js/analysis/index.js';
import { loaderProducer, exportProducer } from '../../../js/analysis/discovery/producers.js';

function at(candidates, address) {
  return candidates.find((candidate) => BigInt(candidate.start) === BigInt(address));
}

test('#2371 canonical BinaryImage.functions carries LC_FUNCTION_STARTS into loader discovery', () => {
  const image = {
    functions: [{ address: 0x100001000n, source: 'function_starts', confidence: 0.995 }],
    unwindEntries: [],
  };
  const evidence = loaderProducer.produce({ image });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].kind, 'loader-function-start');
  assert.equal(BigInt(evidence[0].start), 0x100001000n);

  const result = functionCandidates({ input: { image }, architectureId: 'arm64' });
  assert.equal(at(result.candidates, 0x100001000n)?.startState, 'exact');
});

test('#2371 canonical functions wins dedup over the legacy compatibility projection', () => {
  const image = {
    functionStarts: [{ address: 0x100001000n, name: 'legacy' }],
    functions: [{ address: 0x100001000n, source: 'function_starts', name: 'canonical', sizeBytes: 16 }],
    unwindEntries: [],
  };
  const evidence = loaderProducer.produce({ image });
  const starts = evidence.filter((item) => item.kind === 'loader-function-start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].name, 'canonical');
  assert.equal(starts[0].regions.length, 1);
});

test('#2379 untyped/data exports are not authoritative function starts', () => {
  const data = 0x100004000n;
  const image = {
    exports: [{ name: '_gCounter', address: data, kind: 'symbol', source: 'symbol-table' }],
    symbols: [{ name: '_gCounter', address: data, kind: 'section' }],
  };
  const evidence = exportProducer.produce({ image });
  assert.equal(evidence.some((item) => item.kind === 'export'), false);

  const result = functionCandidates({ input: { image }, architectureId: 'arm64' });
  assert.notEqual(at(result.candidates, data)?.startState, 'exact');
});

test('#2379 loader-proven function retains export/name corroboration without duplicate exact truth', () => {
  const fn = 0x100001000n;
  const image = {
    functions: [{ address: fn, source: 'function_starts' }],
    unwindEntries: [],
    exports: [{ name: '_f', address: fn, kind: 'regular' }],
    symbols: [],
  };
  const result = functionCandidates({ input: { image }, architectureId: 'arm64' });
  const candidate = at(result.candidates, fn);
  assert.equal(candidate?.startState, 'exact');
  assert.equal(candidate?.name, '_f');
});

test('#2380 loader-rejected entrypoint is not resurrected as authoritative evidence', () => {
  const bad = 0x100004000n;
  const image = {
    entrypoint: bad,
    metadata: { entrypointValid: false },
    functions: [],
  };
  assert.equal(exportProducer.produce({ image }).some((item) => item.kind === 'entrypoint'), false);
  const result = functionCandidates({ input: { image }, architectureId: 'arm64' });
  assert.equal(at(result.candidates, bad), undefined);
});

test('#2380 explicit loader rejection wins over a contradictory stale entrypoint seed', () => {
  const bad = 0x100004000n;
  const image = {
    entrypoint: bad,
    metadata: { entrypointValid: false },
    functions: [{ address: bad, source: 'entrypoint' }],
  };
  assert.equal(exportProducer.produce({ image }).some((item) => item.kind === 'entrypoint'), false);
  const result = functionCandidates({ input: { image }, architectureId: 'arm64' });
  assert.equal(at(result.candidates, bad), undefined);
});

test('#2380 loader-validated entrypoint remains authoritative', () => {
  const good = 0x100001000n;
  const image = {
    entrypoint: good,
    metadata: { entrypointValid: true },
    functions: [{ address: good, source: 'entrypoint' }],
  };
  const evidence = exportProducer.produce({ image });
  assert.equal(evidence.filter((item) => item.kind === 'entrypoint').length, 1);
  const result = functionCandidates({ input: { image }, architectureId: 'arm64' });
  assert.equal(at(result.candidates, good)?.startState, 'exact');
});
