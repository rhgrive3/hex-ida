import assert from 'node:assert/strict';
import { backwardSlice, memoryOrigins } from '../js/slice.js';

const s1={id:1},s2={id:2},s3={id:3};
const nested={kind:'phi',incoming:[
  {node:{kind:'store',inst:s1}},
  {node:{kind:'phi',incoming:[
    {node:{kind:'store',inst:s2}},
    {node:{kind:'phi',incoming:[{node:{kind:'store',inst:s3}}]}},
  ]}},
]};

const complete=memoryOrigins(nested,{maxNodes:32,maxEdges:32});
assert.equal(complete.truncated,false);
assert.deepEqual(new Set(complete.stores),new Set([s1,s2,s3]));

const zeroNodeBudget=memoryOrigins(nested,{maxNodes:0,maxEdges:32});
assert.equal(zeroNodeBudget.truncated,true);
assert.equal(zeroNodeBudget.nodes,1);
assert.deepEqual(zeroNodeBudget.stores,[]);

const zeroEdgeBudget=memoryOrigins(nested,{maxNodes:32,maxEdges:0});
assert.equal(zeroEdgeBudget.truncated,true);
assert.equal(zeroEdgeBudget.nodes,1);
assert.deepEqual(zeroEdgeBudget.stores,[]);

const negativeBudget=memoryOrigins(nested,{maxNodes:-1,maxEdges:-1});
assert.equal(negativeBudget.truncated,true);
assert.equal(negativeBudget.nodes,1);

const fallbackBudget=memoryOrigins(nested,{maxNodes:null,maxEdges:NaN});
assert.equal(fallbackBudget.truncated,false);
assert.deepEqual(new Set(fallbackBudget.stores),new Set([s1,s2,s3]));

const load={id:4,op:'load',args:[],memUse:nested,row:0,block:0};
const boundedSlice=backwardSlice({instructions:[s1,s2,s3,load]},load,{memoryNodeLimit:0,memoryEdgeLimit:0});
assert.equal(boundedSlice.memoryTraversalTruncated,true);

console.log('issue #4727 memoryOrigins zero budgets: PASS');
