import test from 'node:test';
import assert from 'node:assert/strict';
import {valueDependsOnAny} from '../../js/decompiler/value-dependency.js';

test('shared SSA diamonds are visited once, and deep cyclic graphs need no recursion',()=>{
  const leaf={id:'leaf'};let root=leaf,visits=0;
  for(let i=0;i<6000;i++) {
    const next={id:'v'+i},previous=root;
    Object.defineProperty(next,'def',{get(){visits++;return {args:[{value:previous},{value:previous}]};}});
    root=next;
  }
  assert.equal(valueDependsOnAny(root,new Set(['absent'])),false);
  assert.equal(visits,6000,'a shared dependency is not walked once per path');
  assert.equal(valueDependsOnAny(root,new Set(['leaf'])),true);
  const a={id:'a'},b={id:'b'};
  a.def={args:[{value:b}]};b.def={incoming:[{value:a},{value:leaf}]};
  assert.equal(valueDependsOnAny(a,new Set(['leaf'])),true);
  assert.equal(valueDependsOnAny(a,new Set(['absent'])),false);
});

test('dependency budgets and cancellation return unknown, never an absence proof',()=>{
  const leaf={id:'leaf'},root={id:'root',def:{args:[{value:leaf}]}};
  assert.equal(valueDependsOnAny(root,new Set(['absent']),{maxNodes:0}),null);
  assert.equal(valueDependsOnAny(root,new Set(['leaf']),{maxEdges:0}),null);
  assert.equal(valueDependsOnAny(root,new Set(['leaf']),{shouldAbort:()=>true}),null);
  assert.equal(valueDependsOnAny(leaf,new Set(['leaf']),{maxNodes:0}),true);
  assert.equal(valueDependsOnAny(root,new Set(['absent'])),false);
});
