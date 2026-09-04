import assert from 'node:assert/strict';
import { mergeFunctionSeeds } from '../../js/binary/model.js';

const validatedIfunc = {
  address: 0x1000n,
  source: 'ifunc-resolver',
  confidence: 0.995,
  exactFunctionStart: true,
  functionStartEvidence: { kind: 'validated-ifunc' },
  name: 'foo$resolver',
};
const heuristic = {
  address: 0x1000n,
  source: 'heuristic',
  confidence: 0.5,
  exactFunctionStart: false,
  name: null,
};

for (const seeds of [
  [validatedIfunc, heuristic],
  [heuristic, validatedIfunc],
]) {
  const [merged] = mergeFunctionSeeds(seeds);
  assert.equal(merged.source, 'ifunc-resolver');
  assert.equal(merged.confidence, 0.995);
  assert.equal(merged.name, 'foo$resolver');
  assert.equal(merged.exactFunctionStart, true);
  assert.deepEqual(merged.functionStartEvidence, { kind: 'validated-ifunc' });
  assert.deepEqual(new Set(merged.sources), new Set(['ifunc-resolver', 'heuristic']));
}

const [symbolWins] = mergeFunctionSeeds([
  { address: 0x2000n, source: 'symbol', confidence: 0.2, name: 'symbol' },
  { address: 0x2000n, source: 'heuristic', confidence: 1, name: 'heuristic' },
]);
assert.equal(symbolWins.source, 'symbol');
assert.equal(symbolWins.name, 'symbol');

const [equalRankTieBreak] = mergeFunctionSeeds([
  { address: 0x3000n, source: 'exception', confidence: 0.7, name: 'exception' },
  { address: 0x3000n, source: 'unwind', confidence: 0.8, name: 'unwind' },
]);
assert.equal(equalRankTieBreak.source, 'unwind');
assert.equal(equalRankTieBreak.name, 'unwind');

const [ifuncVsSymbol] = mergeFunctionSeeds([
  { address: 0x4000n, source: 'ifunc-resolver', confidence: 0.7, name: 'resolver' },
  { address: 0x4000n, source: 'symbol', confidence: 0.8, name: 'symbol' },
]);
assert.equal(ifuncVsSymbol.source, 'symbol');
assert.equal(ifuncVsSymbol.name, 'symbol');

console.log('issue-3680-ifunc-resolver-rank: PASS');
