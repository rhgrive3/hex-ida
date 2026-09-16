import assert from 'node:assert/strict';
import test from 'node:test';

import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline.js';

// #8653: a canonical Semantic IR that is explicitly truncated (or projected
// from a partial v2 result, which sets `truncated:true`) can still mint a
// Phase 8 ledger published as `complete` and a final
// `decompilerPipeline.completeness === 'complete'`, even though the same
// result emits a human-readable "the result is partial" warning. Machine
// authority must not disagree with the source's own completeness claim.

function buildResult(truncated) {
  const v = { id: 1, reg: 'x0', bits: 32, kind: 'arg', uses: [], def: null, const: null,
    origin: { kind: 'instruction', address: 0x1000n } };
  const ret = { id: 1, op: 'ret', row: 0, block: 0, address: 0x1000n, args: [] };
  const ir = {
    truncated,
    origin: { kind: 'function', address: 0x1000n },
    values: [v],
    instructions: [ret],
    args: new Map([['x0', v]]),
    blocks: [{ index: 0, startRow: 0, endRow: 0, succ: [], insts: [ret] }],
  };
  return {
    semantic: true,
    ir,
    types: { values: new Map(), locations: new Map() },
    lines: [
      { kind: 'sig', indent: 0, text: 'void f(void)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
    warnings: truncated ? ['Semantic IR budget truncated this function; the result is partial.'] : [],
    evidence: [],
    summary: 'fallback',
    coverage: { mode: 'structured' },
  };
}

test('a truncated source Semantic IR must not mint a complete Phase 8 ledger or a complete pipeline result', () => {
  const out = enhanceSemanticDecompilation(buildResult(true), { calls: [] }, { decompilerTimeBudgetMs: 5000 });
  assert.equal(out.ir.truncated, true, 'the source really is truncated');
  assert.notEqual(out.phase8?.completeness, 'complete', 'Phase 8 must not publish completeness=complete over a truncated source');
  assert.notEqual(out.phase8?.published, true, 'no authoritative complete ledger may be published for a truncated source');
  assert.equal(out.ctx?.decompilerPipeline?.completeness, 'partial', 'the pipeline must not launder a truncated source into complete');
  // Known positive facts are still reported.
  assert.ok(Array.isArray(out.lines) && out.lines.length > 0);
  assert.ok(out.warnings.some((w) => /partial/i.test(w)));
});

test('the same non-truncated function still publishes a complete Phase 8 ledger', () => {
  const out = enhanceSemanticDecompilation(buildResult(false), { calls: [] }, { decompilerTimeBudgetMs: 5000 });
  assert.notEqual(out.ir.truncated, true);
  assert.equal(out.phase8?.published, true, 'a complete source still publishes its Phase 8 ledger');
  assert.equal(out.phase8?.completeness, 'complete');
  assert.equal(out.ctx?.decompilerPipeline?.completeness, 'complete', 'the fix must not weaken the honest-complete path');
});
