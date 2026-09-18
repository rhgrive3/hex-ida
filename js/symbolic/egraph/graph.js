/** Query-local bounded e-graph over canonical Bool/BV Expr nodes.
 * This graph is a candidate store, NOT a verifier. Only the existing judge can
 * authorize an extracted expression. Rebuilding closes congruence after each
 * read/search -> batch-union phase. No memory, alias or ISA meaning lives here.
 */
import * as E from '../expr/index.js';
import { expressionChildren, rebuildCanonicalExpression } from '../memory/expression-contract.js';
import { QueryFailure } from '../memory/query-state.js';
import { proposeEqualityCandidates, EQUALITY_RULESET_VERSION } from './rules.js';

export const EGRAPH_LIMITS = Object.freeze({
  workItems:250000, allocationUnits:200000, enodes:512, eclasses:512, unions:512,
  iterations:16, rebuilds:64, extractionPasses:8192, extractedTrees:50000,
  ruleApplications:4096, candidates:8,
});
export const EGRAPH_RULE_ORDERS = Object.freeze(['canonical','reverse','discovery']);
/** Only reorder the already-generated finite proposal batch. No alternate
 * rules, comparators or semantic authority can enter through this option.
 * Default ordering and its resource charge are unchanged.
 */
export function orderEqualityProposals(pending,guard,ruleOrder = 'canonical') {
  if (!EGRAPH_RULE_ORDERS.includes(ruleOrder)) throw new QueryFailure('invalid-egraph-rule-order');
  guard.take('workItems',pending.length*Math.max(1,Math.ceil(Math.log2(pending.length+1))));
  if (ruleOrder !== 'discovery') {
    const direction = ruleOrder === 'reverse' ? -1 : 1;
    pending.sort((a,b)=>direction*((a.rule<b.rule?-1:a.rule>b.rule?1:0)||a.owner-b.owner));
  }
  return pending;
}
const MAX_TREE_SIZE=4096, MAX_TREE_DEPTH=64, MAX_FRONTIER=4;
const expensive = node => ['mul','udiv','sdiv','urem','srem'].includes(node.op) ? 1 : 0;
const sameCost = (a,b) => a.treeNodes===b.treeNodes && a.depth===b.depth && a.expensiveOps===b.expensiveOps;
const dominates = (a,b) => a.treeNodes<=b.treeNodes && a.depth<=b.depth && a.expensiveOps<=b.expensiveOps;
const compareCost = (a,b) => a.cost.expensiveOps-b.cost.expensiveOps || a.cost.treeNodes-b.cost.treeNodes || a.cost.depth-b.cost.depth || (a.digest<b.digest?-1:a.digest>b.digest?1:0);
function header(node) {
  // A lossless enode key; structural hashes are used only for candidate ranking,
  // never to establish congruence or semantic equality.
  return JSON.stringify([node.kind,node.sort.kind,node.sort.width??null,node.op??null,
    node.kind==='const'?(typeof node.value==='bigint'?node.value.toString():node.value):null,
    node.symbolId??null,node.name??null,node.high??null,node.low??null,node.targetWidth??null]);
}

class CandidateEGraph {
  constructor(guard,ruleOrder) {
    this.guard=guard;this.ruleOrder=ruleOrder;this.nodes=[];this.parents=[];this.sorts=[];this.index=new Map();
    this.memo=new WeakMap();this.revision=0;this.rules=new Set();
  }
  find(id) {
    this.guard.take('workItems');let root=id;
    while(this.parents[root]!==root){this.guard.take('workItems');root=this.parents[root];}
    while(this.parents[id]!==id){const next=this.parents[id];this.parents[id]=root;id=next;}
    return root;
  }
  key(head,children){return head+'|'+children.map(id=>this.find(id)).join(',');}
  add(expression) {
    const stack=[[expression,false]];
    while(stack.length) {
      this.guard.take('workItems');const [node,finish]=stack.pop();
      if(this.memo.has(node))continue;
      const children=expressionChildren(node);
      if(!finish){
        this.guard.take('allocationUnits',children.length+1);stack.push([node,true]);
        for(let i=children.length-1;i>=0;i--)if(!this.memo.has(children[i]))stack.push([children[i],false]);
        continue;
      }
      const ids=children.map(child=>this.find(this.memo.get(child))),head=header(node),key=this.key(head,ids);
      if(this.index.has(key)){this.memo.set(node,this.find(this.index.get(key)));continue;}
      this.guard.take('enodes');this.guard.take('eclasses');this.guard.take('allocationUnits',ids.length+4);
      const id=this.parents.length;this.parents.push(id);this.sorts.push(node.sort);
      this.nodes.push({owner:id,header:head,children:ids,witness:node});
      this.index.set(key,id);this.memo.set(node,id);this.revision++;
    }
    return this.find(this.memo.get(expression));
  }
  union(a,b,rule) {
    a=this.find(a);b=this.find(b);if(a===b)return false;
    if(!E.sameSort(this.sorts[a],this.sorts[b]))throw new QueryFailure('egraph-sort-mismatch');
    this.guard.take('unions');this.guard.take('allocationUnits');
    this.parents[Math.max(a,b)]=Math.min(a,b);this.revision++;
    if(rule)this.rules.add(rule);return true;
  }
  rebuild() {
    let changed=true;
    while(changed) {
      this.guard.take('rebuilds');changed=false;const index=new Map();
      this.guard.take('allocationUnits',this.nodes.length);
      for(const node of this.nodes) {
        this.guard.take('workItems');const key=this.key(node.header,node.children);
        if(index.has(key))changed=this.union(node.owner,index.get(key),'congruence')||changed;
        else index.set(key,this.find(node.owner));
      }
      this.index=index;
    }
  }
  insert(frontier,candidate) {
    for(let index=0;index<frontier.length;index++){
      const old=frontier[index];
      if(sameCost(old.cost,candidate.cost)) {
        if(old.digest<=candidate.digest)return false;
      } else if(dominates(old.cost,candidate.cost))return false;
    }
    const kept=frontier.filter(old=>!dominates(candidate.cost,old.cost));
    if(kept.length>=MAX_FRONTIER)throw new QueryFailure('budget:extraction-frontier');
    kept.push(candidate);kept.sort(compareCost);frontier.splice(0,frontier.length,...kept);return true;
  }
  extract() {
    const frontiers=new Map();
    this.guard.take('allocationUnits',this.nodes.length);
    for(const node of this.nodes)frontiers.set(this.find(node.owner),[]);
    // Positive tree costs ensure a shortest finite derivation never needs to
    // revisit an e-class. Cyclic classes require a non-cyclic witness, not an
    // arbitrary cycle cut that would invent a value.
    for(let pass=0;pass<=frontiers.size;pass++) {
      this.guard.take('extractionPasses');let changed=false;
      for(const node of this.nodes) {
        this.guard.take('workItems');const inputs=node.children.map(id=>frontiers.get(this.find(id)));
        if(inputs.some(frontier=>frontier.length===0))continue;
        let choices=[[]];
        for(const input of inputs) {
          const next=[];
          for(const choice of choices)for(const candidate of input){this.guard.take('workItems');this.guard.take('allocationUnits',choice.length+1);next.push([...choice,candidate]);}
          choices=next;
        }
        for(const choice of choices) {
          this.guard.take('extractedTrees');
          const cost={treeNodes:1,depth:1,expensiveOps:expensive(node.witness)};
          for(const child of choice){cost.treeNodes+=child.cost.treeNodes;cost.depth=Math.max(cost.depth,1+child.cost.depth);cost.expensiveOps+=child.cost.expensiveOps;}
          if(cost.treeNodes>MAX_TREE_SIZE || cost.depth>MAX_TREE_DEPTH)continue;
          this.guard.take('allocationUnits',choice.length+2);
          const expression=rebuildCanonicalExpression(node.witness,choice.map(child=>child.expression));
          this.guard.take('workItems',cost.treeNodes);
          const digest=E.computeStructuralHash(expression),frontier=frontiers.get(this.find(node.owner));
          changed=this.insert(frontier,{expression,cost:Object.freeze(cost),digest})||changed;
        }
      }
      if(!changed)return frontiers;
    }
    throw new QueryFailure('egraph-extraction-not-converged');
  }
  saturate(expression) {
    const root=this.add(expression);let frontier;
    for(;;) {
      this.guard.take('iterations');const before=this.revision;
      frontier=this.extract();const pending=[];
      // Snapshot the searchable nodes. New nodes/unions are written only after
      // this round's representative discovery, preventing greedy rule order.
      this.guard.take('allocationUnits',this.nodes.length);const nodes=this.nodes.slice();
      for(const node of nodes) {
        this.guard.take('workItems');const children=node.children.map(id=>frontier.get(this.find(id))?.[0]);
        if(children.some(value=>!value))continue;
        this.guard.take('allocationUnits',children.length+128);this.guard.take('workItems',64);
        const witness=rebuildCanonicalExpression(node.witness,children.map(child=>child.expression));
        for(const proposal of proposeEqualityCandidates(witness)) {
          this.guard.take('ruleApplications');this.guard.take('allocationUnits',2);
          pending.push({owner:node.owner,rule:proposal.rule,after:proposal.after});
        }
      }
      // Ordering changes only the application of this completed read batch.
      // No newly generated term is searched until the next rebuild/iteration.
      orderEqualityProposals(pending,this.guard,this.ruleOrder);
      this.guard.take('allocationUnits',pending.length*2);
      const unions=[];
      for(const entry of pending)unions.push({...entry,target:this.add(entry.after)});
      for(const entry of unions)this.union(entry.owner,entry.target,entry.rule);
      this.rebuild();
      if(this.revision===before)break;
    }
    const choices=frontier.get(this.find(root));
    if(!choices?.length)throw new QueryFailure('budget:extraction-tree');
    this.guard.check();
    return Object.freeze({saturated:true,rulesetVersion:EQUALITY_RULESET_VERSION,ruleOrder:this.ruleOrder,
      rules:Object.freeze([...this.rules].sort()),choices:Object.freeze(choices.map(value=>Object.freeze(value))),
      optimality:'explored-bounded-pareto-frontier-only'});
  }
}

export function saturatePureExpression(expression,guard,ruleOrder = 'canonical') {
  if (!EGRAPH_RULE_ORDERS.includes(ruleOrder)) throw new QueryFailure('invalid-egraph-rule-order');
  return new CandidateEGraph(guard,ruleOrder).saturate(expression);
}
