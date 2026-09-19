import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSemanticModel } from '../../../js/blocks-base.js';
import { proveClosedArm64AnalysisWindow } from '../../../js/analysis/query/app-adapter.js';

const confirmedSymbols = {
  functionEvidence:() => ({ source:'binary-symbol', confidence:0.995, confirmed:true }),
  functionAt:() => null,
};
const range = { complete:false, reason:'function-end-unproven', start:0x1000n };

test('unknown extent may publish complete decompilation when reachable CFG closes on return', () => {
  const model = buildSemanticModel([
    { row:0, address:0x1000n, mn:'mov', ops:'x0, #1' },
    { row:1, address:0x1004n, mn:'ret', ops:'' },
  ], { startRow:0, endRow:1, rowOfAddress:(a) => Number((BigInt(a) - 0x1000n) / 4n) });
  const proof = proveClosedArm64AnalysisWindow(model, range, confirmedSymbols);
  assert.equal(proof?.complete, true);
  assert.equal(proof?.provenance, 'control-flow-closed-within-analysis-window');
});

test('mere fallthrough to the analysis-window boundary is never promoted to complete', () => {
  const model = buildSemanticModel([
    { row:0, address:0x1000n, mn:'mov', ops:'x0, #1' },
  ], { startRow:0, endRow:0, rowOfAddress:() => 0 });
  assert.equal(proveClosedArm64AnalysisWindow(model, range, confirmedSymbols), null);
});

test('unresolved indirect control flow remains fail closed', () => {
  const model = buildSemanticModel([
    { row:0, address:0x1000n, mn:'br', ops:'x16' },
  ], { startRow:0, endRow:0, rowOfAddress:() => 0 });
  assert.equal(proveClosedArm64AnalysisWindow(model, range, confirmedSymbols), null);
});
