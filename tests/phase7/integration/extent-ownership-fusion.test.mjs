import assert from 'node:assert/strict';
import test from 'node:test';
import { fuseFunctionCandidates } from '../../../js/analysis/discovery/fusion.js';
const ev=(producerId, ownership, extentRole='complete')=>({kind:'debug-symbol',extentRole,producerId,start:'4096',regions:[{start:'4096',end:'4112',ownership}]});
test('complete extent ownership disagreement never becomes exact',()=>{const {candidates}=fuseFunctionCandidates([ev('a','exclusive'),ev('b','shared')]);assert.equal(candidates.length,1);assert.equal(candidates[0].extentState,'unknown');assert.deepEqual(candidates[0].regions,[]);assert.ok(candidates[0].conflicts.some(x=>x.kind==='extent'));});
test('partial extent ownership mismatch is preserved without silent overwrite',()=>{const {candidates}=fuseFunctionCandidates([ev('a','exclusive','partial'),ev('b','shared','partial')]);assert.equal(candidates.length,1);assert.deepEqual(candidates[0].regions.map(r=>r.ownership).sort(),['exclusive','shared']);});
test('ownership-aware fusion is input-order deterministic',()=>{const a=fuseFunctionCandidates([ev('a','exclusive'),ev('b','shared')]).candidates[0];const b=fuseFunctionCandidates([ev('b','shared'),ev('a','exclusive')]).candidates[0];assert.equal(a.extentState,b.extentState);assert.deepEqual(a.regions,b.regions);assert.deepEqual(a.conflicts,b.conflicts);});
