// Regression for #4044: js/auto.js::fairFunctionList() fell back to
// `symbols.functionList(region, max)` whenever no region was requested. That
// fallback returns a plain Array with no `complete`/`sampled` metadata, and
// notableFunctions() read the missing metadata fail-open (`list.complete !==
// false`). A binary with more than the 20,000-function cap therefore reported
// complete:true / sampled:false while unanalyzed functions were still hidden.
// The fallback now publishes the same completeness authority as the sampled
// in-region path.
import assert from 'node:assert/strict';
import { notableFunctions } from '../js/auto.js';

const MAX = 20000;
const total = MAX + 1;
const funcs = new BigUint64Array(total);
for (let i = 0; i < total; i++) funcs[i] = 0x1000n + BigInt(i * 4);

function makeSymbols(count) {
  const starts = new BigUint64Array(count);
  for (let i = 0; i < count; i++) starts[i] = 0x1000n + BigInt(i * 4);
  return {
    funcs: starts,
    functionCount: count,
    functionAt(addr) { return { start: addr, end: addr + 0x10n }; },
    nameAt() { return null; },
    // The product fallback: a plain, truncated list with no completeness metadata.
    functionList(region, max = 50000) {
      const out = [];
      for (let i = 0; i < starts.length && out.length < max; i++) out.push({ addr: starts[i], name: null, size: null });
      return out;
    },
  };
}

const program = {
  functionRange(addr) { return { start: addr, end: addr + 0x10n }; },
  statsOf() { return { total: 10, numeric: 0, store: 0, load: 0, cmp: 2 }; },
  callCountOf() { return 2; },
};

// 1. The capped fallback list is a sample, not a complete inventory.
{
  const result = notableFunctions(program, makeSymbols(total), undefined, 5);
  assert.equal(result.length, 5);
  assert.equal(result.sampled, true, 'a list truncated at the 20,000 cap is sampled');
  assert.equal(result.complete, false, 'a truncated inventory is not complete');
  assert.equal(result[0].sampleComplete, false, 'per-function sample provenance must agree');
}

// 2. A binary below the cap is still reported as complete, so the fix does not
//    turn every unknown-region call into a sampled read.
{
  const result = notableFunctions(program, makeSymbols(8), undefined, 5);
  assert.equal(result.sampled, false);
  assert.equal(result.complete, true);
  assert.equal(result[0].sampleComplete, true);
}

console.log('issue #4044 auto function-list completeness regression passed');
