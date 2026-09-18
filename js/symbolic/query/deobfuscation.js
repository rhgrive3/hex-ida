/** Small, bounded pure-DAG rewrite proposals. These rules are NOT proof rules:
 * every proposal goes through the existing equivalence query/session/judge.
 * No IR, structuring transaction, memory/effect observable or solver is changed.
 */
import { proposeSimpleCandidates as proposals } from '../egraph/rules.js';
import { queryRecord, queryArray } from '../memory/data-input.js';
import * as E from '../expr/index.js';
import { assertMemoryExpr } from '../memory/byte-memory.js';
import { expressionChildren } from '../memory/expression-contract.js';
import { createQueryGuard, QueryFailure } from '../memory/query-state.js';
import { verifyDeobfuscationCandidate } from '../taint/proof-consumer.js';
const LIMITS=Object.freeze({workItems:250000,allocationUnits:100000,candidates:32});

function uniqueNodes(root,guard) {
  const stack=[root],seen=new Set(),nodes=[];
  while(stack.length) {
    guard.take('workItems');const node=stack.pop();
    if(seen.has(node)) continue;
    const children=expressionChildren(node);
    guard.take('allocationUnits',children.length+1);
    seen.add(node);nodes.push(node);
    for(let i=children.length-1;i>=0;i--) stack.push(children[i]);
  }
  return nodes;
}
function replace(root,target,replacement,guard) {
  const memo=new Map();
  function visit(node) {
    guard.take('workItems');
    if(node===target) return replacement;
    if(memo.has(node)) return memo.get(node);
    const before=expressionChildren(node),after=before.map(visit);
    let result=node;
    if(before.some((x,i)=>x!==after[i])) {
      guard.take('allocationUnits');
      switch(node.kind) {
        case 'unary':result=E.createUnary(node.op,after[0]);break;
        case 'binary':result=E.createBinary(node.op,after[0],after[1]);break;
        case 'compare':result=E.createCompare(node.op,after[0],after[1]);break;
        case 'connective':result=E.createConnective(node.op,...after);break;
        case 'ite':result=E.createIte(...after);break;
        case 'extract':result=E.createExtract(after[0],node.high,node.low);break;
        case 'concat':result=E.createConcat(after[0],after[1]);break;
        case 'cast':result=E.createCast(node.op,after[0],node.targetWidth);break;
        default:throw new QueryFailure('unsupported-rewrite-node');
      }
    }
    guard.take('allocationUnits');memo.set(node,result);return result;
  }
  return visit(root);
}
export async function queryDeobfuscationCandidates(options={}) {
  options = { ...options };
  const {expression,valueId,identity}=options;
  if(typeof valueId!=='string' || !valueId || valueId.length>512) throw new TypeError('bounded semantic value ID required');
  const guard=createQueryGuard({...options,timeoutMs:options.timeoutMs??120},LIMITS);
  let verificationQueries=0;
  const result=(status,reason,candidates=[])=>Object.freeze({schemaVersion:'hex-deobfuscation-candidates/v1',
    status,reason,identity:guard.identity,scope:'pure-expression-only',candidates:Object.freeze(candidates),
    metrics:Object.freeze({...guard.metrics(),verificationQueries})});
  try {
    guard.check();
    if(!Array.isArray(options.memoryObservables) || !Array.isArray(options.effectObservables)) return result('partial','missing-memory-effect-observables');
    if(options.memoryObservables.length || options.effectObservables.length) return result('partial','memory-effect-judge-handoff');
    if(options.executionSnapshot) return result('partial','execution-path-proof-handoff');
    // A batch is one submitted scope, not a series of views of a caller-owned
    // mutable request. Reserve before copying all bounded list inputs.
    const preconditions = options.preconditions ?? [];
    const correspondence = queryRecord(options.correspondence ?? { inputs: [] });
    if (!Array.isArray(preconditions) || preconditions.length > 4096 || !Array.isArray(correspondence.inputs) || correspondence.inputs.length > 4096) {
      return result('partial', 'invalid-precondition-correspondence');
    }
    guard.take('allocationUnits', preconditions.length + correspondence.inputs.length);
    guard.take('workItems', correspondence.inputs.length);
    const submittedInputs = queryArray(correspondence.inputs, guard).map(pair => queryRecord(pair, guard));
    if (submittedInputs.some(pair => typeof pair.before !== 'string' || typeof pair.after !== 'string')) {
      return result('partial', 'invalid-input-correspondence');
    }
    options.preconditions = queryArray(preconditions, guard);
    options.correspondence = Object.freeze({ inputs: Object.freeze(submittedInputs.map(pair => Object.freeze({ before: pair.before, after: pair.after }))) });
    options.memoryObservables = Object.freeze([]);
    options.effectObservables = Object.freeze([]);

    assertMemoryExpr(expression,guard);
    const nodes=uniqueNodes(expression,guard),seen=new Set(),candidates=[];
    for(const node of nodes) {
      // The fixed rule set has at most 16 constant-size proposals; reserve before
      // constructing any new Expr. Only accepted candidates consume that limit.
      guard.take('workItems',16);guard.take('allocationUnits',32);
      for(const proposal of proposals(node)) {
        const after=replace(expression,node,proposal.after,guard);
        guard.take('workItems',nodes.length);
        const digest=E.computeStructuralHash(after);
        if(seen.has(digest)) continue;
        guard.take('candidates');guard.take('allocationUnits');seen.add(digest);
        const candidateId=`${proposal.rule}:${digest}`;
        const remaining=Math.max(0,Math.floor((options.timeoutMs??120)-guard.metrics().wallClock));
        verificationQueries++;
        const verification=await verifyDeobfuscationCandidate({...options,
          candidateId,beforeValueId:valueId,afterValueId:`${valueId}:candidate:${digest}`,
          before:expression,after,timeoutMs:remaining,identity:guard.identity});
        guard.check();
        candidates.push(Object.freeze({rule:proposal.rule,candidateId,before:expression,after,
          eligible:verification.eligible,verification}));
      }
    }
    guard.check();return result('complete',null,candidates);
  } catch(error) {
    if(!(error instanceof QueryFailure)) throw error;
    // Atomic publication: never leak an earlier proved proposal from a batch
    // that exceeded its work/time bound or whose snapshot became stale.
    return result('partial',error.reason);
  }
}
