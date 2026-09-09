/** Reuse the real display rules as proposals, never as semantic authority.
 * The proposal is compiled back into the existing canonical Expr DAG and
 * independently checked against the original canonical target. No legacy AST,
 * rule evidence, input name or coverage row can authorize display adoption.
 */
import * as E from '../../symbolic/expr/index.js';
import { stableDigest } from '../../core/identity/index.js';
import { queryRecord, queryArray } from '../../symbolic/memory/data-input.js';
import { assertMemoryExpr } from '../../symbolic/memory/byte-memory.js';
import { createQueryGuard, QueryFailure } from '../../symbolic/memory/query-state.js';
import { verifyDeobfuscationCandidate } from '../../symbolic/taint/proof-consumer.js';
import { expr } from '../ast/nodes.js';
import { DEFAULT_RULES } from '../rewrite/rules.js';
import { RewriteEngine } from '../rewrite/engine.js';
import { compileProofExpression } from './proof-expression.js';

export const REPRESENTATION_CANDIDATE_VERSION = 'hex.representation-candidates/1';
const RULES = Object.freeze(DEFAULT_RULES.map(rule => Object.freeze({...rule})));
if (new Set(RULES.map(rule => rule.name)).size !== RULES.length) throw new TypeError('duplicate-representation-rule');
export const REPRESENTATION_RULES = Object.freeze(RULES.map(rule => Object.freeze({name:rule.name,phase:rule.phase})));
const RULESET_DIGEST = stableDigest({version:REPRESENTATION_CANDIDATE_VERSION,rules:REPRESENTATION_RULES});
const LIMITS = Object.freeze({workItems:100000,allocationUnits:100000,candidates:1});
const BINARY = new Set(['add','sub','mul','and','or','xor','shl','lshr','ashr']);
const EMPTY = Object.freeze([]);

function resize(value, bits, signed = false) {
  const from = value.sort.width;
  return from === bits ? value : E.createCast(bits < from ? 'trunc' : signed ? 'sext' : 'zext',value,bits);
}
const truth = value => E.createCompare('ne',value,E.createBv(value.sort.width,0n));
const bit = value => E.createIte(value,E.createBv(1,1n),E.createBv(1,0n));

// A disposable typed pattern view, NOT printable C or a semantic replacement.
// Keeping semantic widths here avoids mining C carrier casts as optimizations.
// Publication uses renderProofExpression only after independent verification.
function proposalView(recipe, inputs, inputMap, guard) {
  // The recipe already caps expanded tree size at 512. A display pattern is a
  // tree: distinct occurrences keep explicit bindings to the same canonical
  // input, instead of accidentally changing rule cost through DAG sharing.
  function build(index) {
    const node = recipe.nodes[index];
    guard.take('workItems'); guard.take('allocationUnits',node.args.length + 2);
    const args = node.args.map(build), bits = node.bits;
    let value;
    if (node.kind === 'fresh_symbol') {
      const input = inputs[node.input];
      value = {...input}; inputMap.set(value,inputMap.get(input));
    }
    else if (node.kind === 'const') value = expr.constant(node.value,bits,false);
    else if (node.kind === 'unary' || node.kind === 'cast') value = expr.unary(node.op,args[0],bits,node.op === 'sext');
    else if (node.kind === 'binary') value = expr.binary(node.op,args[0],args[1],bits,false);
    else if (node.kind === 'compare') value = expr.compare(['eq','ne'].includes(node.op) ? node.op : node.op.slice(1),args[0],args[1],node.op.startsWith('s'));
    else if (node.kind === 'ite') value = expr.select(args[0],args[1],args[2],bits,false);
    else if (node.kind === 'extract') value = expr.intrinsic('bit_extract',
      [args[0],expr.constant(node.low,64,false),expr.constant(bits,64,false)],bits,false);
    else if (node.kind === 'concat') value = expr.binary('or',
      expr.binary('shl',expr.unary('zext',args[0],bits,false),expr.constant(args[1].bits,bits,false),bits,false),
      expr.unary('zext',args[1],bits,false),bits,false);
    else if (node.kind === 'connective') {
      if (node.op === 'not') value = expr.unary('lnot',args[0],1,false);
      else if (['eq','ne'].includes(node.op)) value = expr.compare(node.op,args[0],args[1],false);
      else if (node.op === 'implies') value = expr.binary('or',expr.unary('lnot',args[0],1,false),args[1],1,false);
      else value = args.reduce((a,b) => expr.binary(node.op,a,b,1,false),expr.constant(node.op === 'and' ? 1n : 0n,1,false));
    }
    if (!value) throw new QueryFailure('unsupported-representation-source');
    return value;
  }
  return build(recipe.root);
}

/** Syntax adapter for candidate mining, NOT a new evaluator or a claim about
 * arbitrary printed C. Any interpretation error must face the original-target
 * verifier; publication re-lowers the proved canonical term with the existing
 * safe projection compiler instead of publishing this tentative AST.
 */
export function compileRepresentationProposal(root, inputs, guard) {
  const done = new Map(), active = new Set();
  function visit(node, depth = 0) {
    guard?.take('workItems');
    if (depth > 64 || done.size >= 2048 || active.has(node)) throw new QueryFailure('representation-proposal-bound');
    if (done.has(node)) return done.get(node);
    const n = queryRecord(node,guard,64), bits = n.bits;
    if (!Number.isSafeInteger(bits) || bits < 1 || bits > 64 || n.effect !== 'pure'
        || n.floating === true) throw new QueryFailure('unsupported-representation-proposal');
    active.add(node);
    const child = value => visit(value,depth + 1);
    let value;
    if (n.kind === 'var') {
      value = inputs.get(node);
      if (!value || value.sort.kind !== 'bv' || value.sort.width !== bits) throw new QueryFailure('unbound-representation-input');
    } else if (n.kind === 'const' && typeof n.value === 'bigint') value = E.createBv(bits,n.value);
    else if (n.kind === 'unary') {
      const arg = child(n.arg);
      if (['trunc','zext','sext'].includes(n.op)) value = resize(arg,bits,n.op === 'sext');
      else if (['not','neg'].includes(n.op)) value = E.createUnary(n.op,resize(arg,bits));
      else if (['bool','lnot'].includes(n.op)) value = resize(bit(n.op === 'bool' ? truth(arg) : E.createConnective('not',truth(arg))),bits);
      else if (n.op === 'abs') {
        const input = resize(arg,bits);
        value = E.createIte(E.createCompare('slt',input,E.createBv(bits,0n)),E.createUnary('neg',input),input);
      }
    } else if (n.kind === 'binary' && BINARY.has(n.op)) {
      const left = resize(child(n.left),bits), rawRight = resize(child(n.right),bits);
      // Display integer shifts mask counts. The canonical DAG's SMT shifts
      // saturate, so explicitly compile that proposed count normalization.
      const right = !['shl','lshr','ashr'].includes(n.op) ? rawRight : bits === 1 ? E.createBv(1,0n)
        : rawRight.kind === 'const' ? E.createBv(bits,rawRight.value % BigInt(bits))
        : (bits & (bits - 1)) === 0 ? E.createBinary('and',rawRight,E.createBv(bits,BigInt(bits - 1)))
        : E.createBinary('urem',rawRight,E.createBv(bits,BigInt(bits)));
      value = E.createBinary(n.op,left,right);
    } else if (n.kind === 'compare' && n.comparisonDomain === 'integer') {
      const left = child(n.left), right = child(n.right);
      if (left.sort.width !== right.sort.width || bits !== 1) throw new QueryFailure('representation-comparison-width');
      const op = ['eq','ne'].includes(n.op) ? n.op
        : ['lt','le','gt','ge'].includes(n.op) && typeof n.compareSigned === 'boolean' ? `${n.compareSigned ? 's' : 'u'}${n.op}` : null;
      if (op) value = bit(E.createCompare(op,left,right));
    } else if (n.kind === 'select') {
      const condition = child(n.condition), left = child(n.whenTrue), right = child(n.whenFalse);
      value = E.createIte(truth(condition),resize(left,bits),resize(right,bits));
    } else if (n.kind === 'intrinsic' && ['min','max'].includes(n.name) && typeof n.signed === 'boolean') {
      const args = queryArray(n.args,guard,2);
      if (args.length !== 2) throw new QueryFailure('representation-intrinsic-arity');
      const left = resize(child(args[0]),bits), right = resize(child(args[1]),bits);
      value = E.createIte(E.createCompare(`${n.signed ? 's' : 'u'}${n.name === 'min' ? 'lt' : 'gt'}`,left,right),left,right);
    } else if (n.kind === 'intrinsic' && n.name === 'abs') {
      const args = queryArray(n.args,guard,1);
      if (args.length !== 1) throw new QueryFailure('representation-intrinsic-arity');
      const input = resize(child(args[0]),bits);
      value = E.createIte(E.createCompare('slt',input,E.createBv(bits,0n)),E.createUnary('neg',input),input);
    } else if (n.kind === 'intrinsic' && n.name === 'bit_extract') {
      const args = queryArray(n.args,guard,3);
      if (args.length !== 3) throw new QueryFailure('representation-intrinsic-arity');
      const offset = queryRecord(args[1],guard), width = queryRecord(args[2],guard);
      if (offset.kind !== 'const' || width.kind !== 'const' || typeof offset.value !== 'bigint'
          || width.value !== BigInt(bits) || offset.value < 0n || offset.value > 63n) throw new QueryFailure('representation-extract-bounds');
      value = E.createExtract(child(args[0]),Number(offset.value) + bits - 1,Number(offset.value));
    }
    if (!value) throw new QueryFailure('unsupported-representation-proposal');
    guard?.take('allocationUnits'); active.delete(node); done.set(node,value); return value;
  }
  return visit(root);
}

export async function queryRepresentationCandidates(options = {}) {
  let guard, submitted, applications = null;
  const coverage = (disposition,reason) => Object.freeze({version:REPRESENTATION_CANDIDATE_VERSION,
    rulesetDigest:RULESET_DIGEST,registered:RULES.length,scope:'candidate-generation-not-rule-theorems-or-render-adoption',
    rows:Object.freeze(REPRESENTATION_RULES.map(rule => Object.freeze({...rule,
      candidateApplications:applications?.[rule.name] ?? 0,
      disposition:applications && !applications[rule.name] ? 'not-selected' : disposition,reason}))) });
  const result = (status,reason,candidates = EMPTY,disposition = 'unknown') => {
    if (status !== 'complete') applications = null;
    const report = Object.freeze({version:REPRESENTATION_CANDIDATE_VERSION,status,reason,candidates,
      ruleCoverage:coverage(disposition,reason),metrics:guard?.metrics() ?? null});
    if (status === 'complete') guard.check();
    return report;
  };
  try {
    submitted = queryRecord(options);
    guard = createQueryGuard(submitted,LIMITS); guard.check();
    if (['rules','proof','verified','solverResult','session','backend'].some(key => Object.hasOwn(submitted,key))) {
      throw new QueryFailure('external-representation-authority');
    }
    for (const key of ['memoryObservables','effectObservables','preconditions']) {
      if (queryArray(submitted[key] ?? EMPTY,guard).length) throw new QueryFailure('conditional-or-effect-representation-handoff');
    }
    const correspondence = queryRecord(submitted.correspondence ?? {inputs:EMPTY});
    if (queryArray(correspondence.inputs ?? EMPTY,guard).length) throw new QueryFailure('conditional-or-effect-representation-handoff');
    if (Object.hasOwn(submitted,'executionSnapshot')) throw new QueryFailure('execution-path-proof-handoff');
    if (typeof submitted.valueId !== 'string' || !submitted.valueId || submitted.valueId.length > 512) throw new QueryFailure('invalid-representation-value-id');
    guard.take('allocationUnits',RULES.length * 2);
    const expression = submitted.expression, binding = queryRecord(submitted.inputBinding);
    if (binding.expression !== expression) throw new QueryFailure('representation-input-binding-mismatch');
    const sourceInputs = queryArray(binding.inputs,guard,128).map(input => queryRecord(input,guard));
    assertMemoryExpr(expression,guard);
    if (expression.sort.kind !== 'bv') throw new QueryFailure('unsupported-representation-target');
    const recipe = compileProofExpression(expression,{inputs:sourceInputs},guard);
    if (!recipe) throw new QueryFailure('unsupported-representation-source');
    const variables = sourceInputs.map((input,index) => expr.variable(`proof_input_${index}`,input.bits,false));
    const inputMap = new Map(variables.map((variable,index) => [variable,sourceInputs[index].symbol]));
    const root = proposalView(recipe,variables,inputMap,guard);
    const engine = new RewriteEngine(RULES,{nodeBudget:512,maxIterations:12,maxApplications:128,maxHistoryOrigins:0});
    const rewritten = engine.rewrite(root,{deterministicTransforms:true,shouldAbort() {
      guard.take('workItems'); return false;
    }});
    guard.check();
    if (rewritten.stats.budgetExceeded) throw new QueryFailure('representation-rewrite-budget');
    applications = rewritten.stats.byRule;
    if (!rewritten.proof.length) return result('complete',null,EMPTY,'unchanged');
    // The display carrier can be wider than the semantic result (e.g. BV4
    // uses uint8_t). Propose the original target width, then prove that term;
    // never let a carrier-width change redefine the verification obligation.
    const after = resize(compileRepresentationProposal(rewritten.root,inputMap,guard),expression.sort.width);
    const afterHash = E.computeStructuralHash(after);
    if (E.computeStructuralHash(expression) === afterHash) return result('complete',null,EMPTY,'unchanged');
    guard.take('candidates');
    const candidateId = `representation:${RULESET_DIGEST}:${afterHash}`;
    const verification = await verifyDeobfuscationCandidate({before:expression,after,candidateId,
      beforeValueId:submitted.valueId,afterValueId:`${submitted.valueId}:representation:${afterHash}`,
      identity:guard.identity,preconditions:[],correspondence:{inputs:[]},memoryObservables:[],effectObservables:[],
      taintResult:submitted.taintResult,backendTier:submitted.backendTier ?? 'tiered',
      signal:submitted.signal,isCancelled:submitted.isCancelled,getCurrentIdentity:submitted.getCurrentIdentity,
      timeoutMs:Math.max(0,Math.floor(guard.remainingMilliseconds()))});
    guard.check();
    if (!verification.eligible && /budget|timeout|deadline|cancel|stale/.test(verification.reason ?? '')) {
      throw new QueryFailure(verification.reason);
    }
    const rules = Object.freeze([...new Set(rewritten.proof.map(record => record.rule))]);
    const candidate = Object.freeze({rule:'representation-rules',rules,rulesetVersion:REPRESENTATION_CANDIDATE_VERSION,
      candidateId,before:expression,after,eligible:verification.eligible,verification});
    const complete = result('complete',null,Object.freeze([candidate]),verification.eligible ? 'proved-candidate'
      : verification.verdict === 'refuted' ? 'refuted' : 'unknown');
    guard.check(); return complete;
  } catch (error) {
    if (error instanceof QueryFailure) return result('partial',error.reason);
    if (error instanceof TypeError || error instanceof RangeError) return result('partial','invalid-representation-request');
    throw error;
  }
}
