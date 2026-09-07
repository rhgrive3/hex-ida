/** Versioned candidate rules only. No e-class membership is proof authority. */
import * as E from '../expr/index.js';
import { expressionChildren } from '../memory/expression-contract.js';
export const EQUALITY_RULESET_VERSION = 'hex-pure-bv-eqs/1';

export function proposeSimpleCandidates(node) {
  const out=[];
  const propose=(rule,after)=>out.push({rule,after});
  const zero=value=>value?.kind==='const' && value.sort.kind==='bv' && value.value===0n;
  const one=value=>value?.kind==='const' && value.sort.kind==='bv' && value.value===1n;
  if(node.kind==='binary') {
    const {left:a,right:b,op}=node,width=node.sort.width;
    if(a===b && op==='xor') propose('xor-self',E.createBv(width,0n));
    if(a===b && op==='sub') propose('sub-self',E.createBv(width,0n));
    if(a===b && ['and','or'].includes(op)) propose(`${op}-self`,a);
    if(a===b && op==='add') propose('double-add',E.createBinary('shl',a,E.createBv(width,1n)));
    if(['add','or','xor','sub','shl','lshr','ashr'].includes(op) && zero(b)) propose(`${op}-zero`,a);
    if(['add','or','xor'].includes(op) && zero(a)) propose(`${op}-zero-left`,b);
    if(op==='mul' && one(b)) propose('mul-one',a);
    if(op==='mul' && one(a)) propose('mul-one-left',b);
    if(op==='and' && b.kind==='const' && b.value===(1n<<BigInt(width))-1n) propose('and-mask',a);
    // (a XOR b) + ((a AND b) << 1) = a + b in the same BV width.
    if(op==='add' && a.kind==='binary' && a.op==='xor' && b.kind==='binary' && b.op==='shl' && one(b.right) &&
       b.left.kind==='binary' && b.left.op==='and' && a.left===b.left.left && a.right===b.left.right) {
      propose('mba-add',E.createBinary('add',a.left,a.right));
    }
  }
  if(node.kind==='unary' && node.arg.kind==='unary' && node.op===node.arg.op && ['not','neg'].includes(node.op)) propose(`double-${node.op}`,node.arg.arg);
  if(node.kind==='connective' && node.op==='not' && node.args[0]?.kind==='connective' && node.args[0].op==='not') propose('double-bool-not',node.args[0].args[0]);
  if(node.kind==='ite' && node.thenExpr===node.elseExpr) propose('same-select-arms',node.thenExpr);
  return out;
}

const COMMUTATIVE = new Set(['add','mul','and','or','xor']);
const ASSOCIATIVE = COMMUTATIVE;
/** Finite local proposals. Search must reserve work/allocation before calling. */
export function proposeEqualityCandidates(node) {
  const out = proposeSimpleCandidates(node);
  const emit = (rule,after) => out.push({rule,after});
  const binary = (op,a,b) => E.createBinary(op,a,b);
  if (node.kind === 'binary') {
    const {left:a,right:b,op} = node, width = node.sort.width;
    if (COMMUTATIVE.has(op) && a !== b) emit('commute-'+op,binary(op,b,a));
    if (ASSOCIATIVE.has(op)) {
      if (a.kind === 'binary' && a.op === op) emit('associate-right-'+op,binary(op,a.left,binary(op,a.right,b)));
      if (b.kind === 'binary' && b.op === op) emit('associate-left-'+op,binary(op,binary(op,a,b.left),b.right));
    }
    if (['and','mul'].includes(op) && ((a.kind==='const' && a.value===0n) || (b.kind==='const' && b.value===0n))) emit(op+'-zero',E.createBv(width,0n));
    if (op === 'xor') {
      if (a.kind==='binary' && a.op==='xor' && a.right===b) emit('xor-cancel-right',a.left);
      if (b.kind==='binary' && b.op==='xor' && a===b.left) emit('xor-cancel-left',b.right);
    }
    if (op === 'sub' && a.kind==='binary' && a.op==='add' && a.right===b) emit('add-sub-cancel',a.left);
    if (op === 'and' || op === 'or') {
      const inner = op === 'and' ? 'or' : 'and';
      if (b.kind==='binary' && b.op===inner && (a===b.left || a===b.right)) emit('absorb-'+op,a);
    }
    if (op === 'mul') {
      if (b.kind==='binary' && b.op==='add') emit('distribute-mul',binary('add',binary('mul',a,b.left),binary('mul',a,b.right)));
      if (b.kind==='const' && b.value>0n && (b.value & (b.value-1n))===0n) {
        let shift=0n,value=b.value;while(value>1n){shift++;value>>=1n;}
        emit('mul-power-two',binary('shl',a,E.createBv(width,shift)));
      }
    }
    if (op==='add' && a.kind==='binary' && a.op==='mul' && b.kind==='binary' && b.op==='mul' && a.left===b.left) {
      emit('factor-mul',binary('mul',a.left,binary('add',a.right,b.right)));
    }
  }
  if (node.kind==='connective' && node.args.length===2) {
    const [a,b] = node.args;
    if (a===b && ['and','or'].includes(node.op)) emit('bool-idempotent',a);
    if (a===b && ['xor','ne'].includes(node.op)) emit('bool-self-false',E.createBool(false));
    if (a===b && ['eq','implies'].includes(node.op)) emit('bool-self-true',E.createBool(true));
    if (['and','or'].includes(node.op)) {
      if ((a.kind==='connective' && a.op==='not' && a.args[0]===b) || (b.kind==='connective' && b.op==='not' && b.args[0]===a)) emit('bool-complement',E.createBool(node.op==='or'));
      for(const [value,other] of [[a,b],[b,a]]) if(value.kind==='const') {
        emit('bool-constant',value.value===(node.op==='and')?other:value);
      }
    }
  }
  if (node.kind==='ite' && node.cond.kind==='const') emit('constant-select',node.cond.value?node.thenExpr:node.elseExpr);
  if (node.kind==='cast' && node.op==='trunc' && node.arg.kind==='cast' && ['zext','sext'].includes(node.arg.op) && node.targetWidth===node.arg.arg.sort.width) emit('truncate-extension',node.arg.arg);
  if (node.kind!=='const' && node.kind!=='fresh_symbol' && expressionChildren(node).every(child=>child.kind==='const')) {
    const value=E.evaluateExpr(node); // existing evaluator, only constant leaves
    if (value.status===E.EVAL_STATUS.VALUE) emit('canonical-constant-fold',node.sort.kind==='bool'?E.createBool(value.value):E.createBv(node.sort.width,value.value));
  }
  return out;
}
