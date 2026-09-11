// Regression for #5763: Semantic CFG canonical ordering (blocks, edges,
// dominance tie-breaks) must be a fixed total order — UTF-16 code-unit — not
// host-locale collation. The frozen graph IS the canonical representation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

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

test('#5763 equivalent insertion orders have identical CFG and dominance', () => {
  const first = build();
  const permuted = createSemanticCfg({
    functionId: first.functionId, entryBlockId: first.entryBlockId,
    blocks: [...first.blocks].reverse().map(({ id, successors }) => ({
      id, successors: [...successors].reverse(),
    })),
  });
  assert.deepEqual(permuted, first);
  assert.deepEqual(analyzeSemanticDominance(permuted), analyzeSemanticDominance(first));
});

test('#5763 separate host locales serialize identical CFG and dominance', () => {
  const moduleUrl = new URL('../js/semantics/cfg/index.js', import.meta.url).href;
  const script = `import {createSemanticCfg, analyzeSemanticDominance} from ${JSON.stringify(moduleUrl)};
    ${build.toString()}
    const cfg = build(); console.log(JSON.stringify({cfg, dominance: analyzeSemanticDominance(cfg)}));`;
  const results = ['de_DE.UTF-8', 'sv_SE.UTF-8'].map((locale) => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 10000,
      env: {...process.env, LANG: locale, LC_ALL: locale},
    });
    assert.equal(child.status, 0, child.error?.message || child.stderr);
    return JSON.parse(child.stdout);
  });
  assert.deepEqual(results[0], results[1]);
});
