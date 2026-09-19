import assert from 'node:assert/strict';
import test from 'node:test';

import { PASS_STAGES } from '../../js/decompiler/phase8/contract.js';
import { runPhase8Stage } from '../../js/decompiler/phase8/index.js';
import { fixture } from '../phase8/helpers/ir-fixtures.mjs';

test('aggregate field provenance dedup uses an index instead of rescanning the growing prefix', () => {
  const count = 320;
  const f = fixture('aggregate-origin-indexing');
  f.block(0);
  const pointer = f.opaque(64);
  for (let index = 0; index < count; index += 1) f.load(32, { addrBase:pointer, disp:0 });
  f.ret();
  const ir = f.build();

  const originalIncludes = Array.prototype.includes;
  let scanWork = 0;
  Array.prototype.includes = function patchedIncludes(value, ...rest) {
    if (typeof value === 'string' && value.startsWith('instruction_load_')) scanWork += this.length;
    return Reflect.apply(originalIncludes, this, [value, ...rest]);
  };
  let result;
  try { result = runPhase8Stage({ ir }, { stages:PASS_STAGES, timeBudgetMs:5000 }); }
  finally { Array.prototype.includes = originalIncludes; }

  const region = result.analysis.get('aggregates').regions.find(entry => entry.regionKey === `value:${pointer.id}`);
  assert.ok(region);
  assert.equal(region.fields[0].origin.instructionIds.length, count);
  // Legacy prefix-dedup performs 0+1+...+319 = 51,040 comparisons.
  assert.ok(scanWork < 1000,
    `aggregate provenance performed ${scanWork} growing-prefix comparisons`);
});
