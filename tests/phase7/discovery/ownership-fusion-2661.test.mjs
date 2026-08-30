import assert from 'node:assert/strict';
import test from 'node:test';
import {fuseFunctionCandidates} from '../../../js/analysis/discovery/fusion.js';
const e=(producerId,ownership,extentRole='complete')=>({kind:'loader-function-start',authority:'authoritative',producerId,start:'4096',extentRole,regions:[{start:'4096',end:'4112',ownership}]});
test('same ownership agrees exactly',()=>{const c=fuseFunctionCandidates([e('a','exclusive'),e('b','exclusive')]).candidates[0];assert.equal(c.extentState,'exact');assert.equal(c.regions[0].ownership,'exclusive');});
test('complete ownership disagreement fails closed independent of order',()=>{const x=[e('a','exclusive'),e('b','shared')];for(const v of [x,[...x].reverse()]){const c=fuseFunctionCandidates(v).candidates[0];assert.equal(c.extentState,'unknown');assert.deepEqual(c.regions,[]);assert.ok(c.conflicts.some(z=>z.kind==='extent'));}});
test('partial ownership disagreement is never silently overwritten',()=>{const x=[e('a','exclusive','partial'),e('b','shared','partial')];for(const v of [x,[...x].reverse()]){const c=fuseFunctionCandidates(v).candidates[0];assert.equal(c.extentState,'unknown');assert.deepEqual(c.regions,[]);assert.ok(c.conflicts.some(z=>/ownership/.test(z.detail)));}});
