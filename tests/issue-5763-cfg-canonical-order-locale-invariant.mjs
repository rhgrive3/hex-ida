// Regression for #5763: Semantic CFG canonical ordering (blocks, edges,
// dominance tie-breaks) must be a fixed total order — UTF-16 code-unit — not
// host-locale collation. The frozen graph IS the canonical representation.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSemanticCfg, analyzeSemanticDominance } from '../js/semantics/cfg/index.js';

function build() {
  return createSemanticCfg({
    functionId: 'fn_5763',
    entryBlockId: 'entry',
    blocks: [
      { id: 'entry', successors: [{ to: 'ä', kind: 'branch' }, { to: 'z', kind: 'branch' }] },
      { id: 'ä', successors: [] },
      { id: 'z', successors: [] },
    ],
  });
}

const codeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

test('#5763 block order follows code-unit order, not collation', () => {
  const cfg = build();
  const blockIds = cfg.blocks.map((block) => block.id);
  assert.deepEqual(blockIds, [...blockIds].sort(codeUnit));
  assert.deepEqual(blockIds, ['entry', 'z', 'ä']);
});

test('#5763 successor edge order follows code-unit order', () => {
  const cfg = build();
  const entry = cfg.blocks.find((block) => block.id === 'entry');
  const targets = entry.successors.map((edge) => edge.to);
  assert.deepEqual(targets, [...targets].sort(codeUnit));
  assert.deepEqual(targets, ['z', 'ä']);
});

test('#5763 dominance tie-breaks are locale-invariant too', () => {
  const cfg = createSemanticCfg({
    functionId: 'fn_5763_dom',
    entryBlockId: 'entry',
    blocks: [
      { id: 'entry', successors: [{ to: 'ä', kind: 'branch' }, { to: 'z', kind: 'branch' }] },
      { id: 'ä', successors: [{ to: 'join', kind: 'fallthrough' }] },
      { id: 'z', successors: [{ to: 'join', kind: 'fallthrough' }] },
      { id: 'join', successors: [] },
    ],
  });
  const dominance = analyzeSemanticDominance(cfg);
  assert.equal(dominance.immediateDominators.join, 'entry');
  // Whatever the host locale, the frozen sets must be in code-unit order.
  assert.deepEqual(dominance.dominators['join'], ['entry', 'join'].sort(codeUnit));
  assert.deepEqual(dominance.dominanceFrontier['ä'], ['join']);
  assert.deepEqual(dominance.dominanceFrontier['z'], ['join']);
  assert.deepEqual(dominance.reachable, ['entry', 'join', 'z', 'ä']);
});

test('#5763 companion: repeated construction is deterministic', () => {
  const first = JSON.stringify(build());
  for (let i = 0; i < 3; i++) assert.equal(JSON.stringify(build()), first);
});
