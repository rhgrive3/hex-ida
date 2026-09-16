import assert from 'node:assert/strict';
import test from 'node:test';

import { functionCandidates } from '../../../js/analysis/index.js';
import { functionSeed, mergeFunctionSeeds } from '../../../js/binary/model.js';
import { loaderProducer } from '../../../js/analysis/discovery/producers.js';

function candidateAt(result, address) {
  return result.candidates.find((candidate) => BigInt(candidate.start) === BigInt(address));
}

const VALIDATED_LIFECYCLE_PATHS = Object.freeze([
  ['LC_ROUTINES', 'routines', 0xa000n, 0.999],
  ['S_MOD_INIT_FUNC_POINTERS', 'constructor', 0xa100n, 0.95],
  ['S_INIT_FUNC_OFFSETS', 'constructor', 0xa200n, 0.95],
  ['S_THREAD_LOCAL_INIT_FUNCTION_POINTERS', 'constructor', 0xa300n, 0.95],
  ['S_MOD_TERM_FUNC_POINTERS', 'terminator', 0xa400n, 0.95],
  ['S_INTERPOSING', 'interpose', 0xa500n, 0.995],
]);

test('#8837 validated Mach-O lifecycle/interpose seeds reach discovery as exact candidates', () => {
  const image = {
    functions: VALIDATED_LIFECYCLE_PATHS.map(([pathName, source, address, confidence]) => functionSeed(address, {
      source,
      confidence,
      exactFunctionStart: true,
      functionStartEvidence: `validated Mach-O ${pathName} executable file-backed target`,
    })),
    functionStarts: [],
    unwindEntries: [],
  };

  const evidence = loaderProducer.produce({ image });
  assert.deepEqual(evidence.map((item) => item.start), VALIDATED_LIFECYCLE_PATHS.map(([, , address]) => address.toString()));
  for (const [pathName, source, address] of VALIDATED_LIFECYCLE_PATHS) {
    const item = evidence.find((entry) => entry.start === address.toString());
    assert.ok(item?.evidenceIds.includes(`loader:source:${source}:${address}`), `${pathName} provenance must reach discovery`);
    assert.equal(
      candidateAt(functionCandidates({ input: { image }, architectureId: 'arm64' }), address)?.startState,
      'exact',
      `${pathName} must remain an exact candidate`,
    );
  }
});
test('#8837 exact authority is source-independent but still confidence-gated', () => {
  const future = functionSeed(0xb000n, {
    source: 'future-validated-loader-source',
    confidence: 0.95,
    exactFunctionStart: true,
    functionStartEvidence: 'future loader producer validated executable file-backed target',
  });
  const lowConfidence = {
    address: 0xb100n,
    source: 'future-validated-loader-source',
    confidence: 0.89,
    exactFunctionStart: true,
  };
  const unmarked = {
    address: 0xb200n,
    source: 'future-validated-loader-source',
    confidence: 0.99,
  };
  const image = { functions: [future, lowConfidence, unmarked], functionStarts: [], unwindEntries: [] };
  assert.deepEqual(loaderProducer.produce({ image }).map((item) => item.start), ['45056']);
  const result = functionCandidates({ input: { image }, architectureId: 'arm64' });
  assert.equal(candidateAt(result, 0xb000n)?.startState, 'exact');
  assert.equal(candidateAt(result, 0xb100n), undefined);
  assert.equal(candidateAt(result, 0xb200n), undefined);
});

test('#8837 merged lifecycle provenance stays one exact candidate', () => {
  const merged = mergeFunctionSeeds([
    functionSeed(0xc000n, {
      source: 'constructor',
      confidence: 0.95,
      exactFunctionStart: true,
      functionStartEvidence: 'validated constructor target',
    }),
    functionSeed(0xc000n, {
      source: 'interpose',
      confidence: 0.995,
      exactFunctionStart: true,
      functionStartEvidence: 'validated interpose target',
    }),
  ])[0];
  assert.deepEqual(new Set(merged.sources), new Set(['constructor', 'interpose']));
  const image = { functions: [merged], functionStarts: [], unwindEntries: [] };
  const evidence = loaderProducer.produce({ image });
  assert.equal(evidence.length, 1);
  assert.ok(evidence[0].evidenceIds.includes('loader:source:constructor:49152'));
  assert.ok(evidence[0].evidenceIds.includes('loader:source:interpose:49152'));
  assert.equal(candidateAt(functionCandidates({ input: { image }, architectureId: 'arm64' }), 0xc000n)?.startState, 'exact');
});
