import assert from 'node:assert/strict';
import test from 'node:test';

import { PASS_STAGES } from '../../js/decompiler/phase8/contract.js';
import { runPhase8Stage } from '../../js/decompiler/phase8/index.js';
import { fixture } from '../phase8/helpers/ir-fixtures.mjs';

function diamonds(count = 40) {
  const f = fixture('structuring-edge-indexing');
  for (let index = 0; index < count; index += 1) {
    const block = index * 3;
    const condition = f.block(block, { succ:[block + 1, block + 2] }).opaque(1);
    f.conditionalBranch(condition, block + 1, block + 2);
    f.block(block + 1, { succ:[block + 3] }).branch(block + 3);
    f.block(block + 2, { succ:[block + 3] }).branch(block + 3);
  }
  f.block(count * 3).ret();
  return f.build();
}

test('structuring indexes residual and constraint edges by source block for region projection', () => {
  const ir = diamonds();
  const originalFilter = Array.prototype.filter;
  let perRegionEdgeFilters = 0;
  Array.prototype.filter = function patchedFilter(callback, ...rest) {
    if (String(callback).includes('edge.from === index')) perRegionEdgeFilters += 1;
    return Reflect.apply(originalFilter, this, [callback, ...rest]);
  };
  let result;
  try {
    result = runPhase8Stage({ ir }, { stages:PASS_STAGES, timeBudgetMs:5000 });
  } finally {
    Array.prototype.filter = originalFilter;
  }
  const facts = result.analysis.get('structuredRegions');
  assert.equal(facts.completeness, 'complete');
  assert.equal(facts.regions.filter(region => region.kind === 'conditional').length, 40);
  assert.equal(perRegionEdgeFilters, 0,
    `structuring performed ${perRegionEdgeFilters} full edge filters while projecting regions`);
});


function serialLoops(count = 30) {
  const f = fixture('structuring-loop-indexing');
  f.block(0, { succ:[1] }).branch(1);
  for (let index = 0; index < count; index += 1) {
    const header = 1 + index * 2;
    const body = header + 1;
    const next = header + 2;
    const condition = f.block(header, { succ:[body, next] }).opaque(1);
    f.conditionalBranch(condition, body, next);
    f.block(body, { succ:[header] }).branch(header);
  }
  f.block(1 + count * 2).ret();
  return f.build();
}

test('loop region projection avoids full residual/constraint edge filters', () => {
  const ir = serialLoops();
  const originalFilter = Array.prototype.filter;
  let loopEdgeFilters = 0;
  Array.prototype.filter = function patchedFilter(callback, ...rest) {
    if (String(callback).includes('nodeSets.get(loop.header).has(edge.from)')) loopEdgeFilters += 1;
    return Reflect.apply(originalFilter, this, [callback, ...rest]);
  };
  let result;
  try { result = runPhase8Stage({ ir }, { stages:PASS_STAGES, timeBudgetMs:5000 }); }
  finally { Array.prototype.filter = originalFilter; }
  const facts = result.analysis.get('structuredRegions');
  assert.equal(facts.completeness, 'complete');
  assert.equal(facts.regions.filter(region => region.kind === 'loop').length, 30);
  assert.equal(loopEdgeFilters, 0,
    `loop region projection performed ${loopEdgeFilters} full edge filters`);
});
