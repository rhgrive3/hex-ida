import { expr, effectOf, isPure, mayDuplicate, mayReorder, sameExpr, nodeCount } from '../ast/nodes.js';
import { evalBinary, evalUnary, fullMask, isPowerOfTwo, log2Exact, u } from '../truth/integer.js';
import { normalizeIntegerValue, normalizeRangeDomain } from '../../range-domain.js';

const isStable = (n) => ['pure', 'read'].includes(effectOf(n));
const isConst = (n, v = null) => n?.kind === 'const' && (v == null || n.value === BigInt(v));
const c = (v, like, bits = like?.bits || 64) => expr.constant(v, bits, like?.signed ?? null, like?.source);
const cost = (n) => nodeCount(n);
const proof = (kind, detail) => () => ({ kind, detail });

/*
 * #8866 — a typed node's `bits` is a real fixed-width modular boundary, not
 * cosmetic metadata: the width-exact evaluator resolves each child at its own
 * declared width and uses a child's width as the source-width authority for the
 * next extension/truncation. So a rewrite may not remove, re-associate or
 * replace a typed operation unless the domain it is deleting is provably the
 * same domain as the node it replaces. Unknown/non-canonical width fails
 * closed: an unproven compatibility is not a proven compatibility.
 */
const widthOf = (n) => {
  const bits = Number(n?.bits);
  return Number.isInteger(bits) && bits > 0 ? bits : null;
};
const sameWidthDomain = (...nodes) => {
  const widths = nodes.map(widthOf);
  return widths[0] != null && widths.every((w) => w === widths[0]);
};
// `sext`/`zext` whose declared result is narrower than their source truncate in
// this typed AST, so extension composition may only cancel outwards.
const wideningExtensionChain = (n) => {
  const outer = widthOf(n), middle = widthOf(n?.arg), inner = widthOf(n?.arg?.arg);
  return outer != null && middle != null && inner != null && outer >= middle && middle >= inner;
};
const algebraProof = (name, before, after) => ({
  kind: 'integer-algebra',
  detail: name,
  bits: widthOf(before) ?? null,
  domain: 'fixed-width-integer',
});

function binRule(name, phase, op, match, rewrite, precondition = null, extra = {}) {
  return { name, phase, match: (n, ctx) => n?.kind === 'binary' && n.op === op ? match(n, ctx) : null,
    precondition, rewrite, proof: (before, after) => algebraProof(name, before, after), cost, ...extra };
}

// A rewrite that returns an existing child instead of the matched node also
// deletes the matched node's result width. Admit it only when the retained
// child carries exactly that width (#8866).
function childRule(name, phase, op, match, pick) {
  return binRule(name, phase, op, match, pick, (n) => sameWidthDomain(n, pick(n)));
}

const identityRules = [
  childRule('add-zero-right', 'canonical', 'add', (n) => isConst(n.right, 0) ? {} : null, (n) => n.left),
  childRule('add-zero-left', 'canonical', 'add', (n) => isConst(n.left, 0) ? {} : null, (n) => n.right),
  childRule('sub-zero', 'canonical', 'sub', (n) => isConst(n.right, 0) ? {} : null, (n) => n.left),
  childRule('mul-one-right', 'canonical', 'mul', (n) => isConst(n.right, 1) ? {} : null, (n) => n.left),
  childRule('mul-one-left', 'canonical', 'mul', (n) => isConst(n.left, 1) ? {} : null, (n) => n.right),
  binRule('mul-zero-right', 'canonical', 'mul', (n) => isConst(n.right, 0) && isPure(n.left) ? {} : null, (n) => c(0, n)),
  binRule('mul-zero-left', 'canonical', 'mul', (n) => isConst(n.left, 0) && isPure(n.right) ? {} : null, (n) => c(0, n)),
  binRule('and-zero-right', 'canonical', 'and', (n) => isConst(n.right, 0) && isPure(n.left) ? {} : null, (n) => c(0, n)),
  binRule('and-zero-left', 'canonical', 'and', (n) => isConst(n.left, 0) && isPure(n.right) ? {} : null, (n) => c(0, n)),
  childRule('or-zero-right', 'canonical', 'or', (n) => isConst(n.right, 0) ? {} : null, (n) => n.left),
  childRule('or-zero-left', 'canonical', 'or', (n) => isConst(n.left, 0) ? {} : null, (n) => n.right),
  childRule('xor-zero-right', 'canonical', 'xor', (n) => isConst(n.right, 0) ? {} : null, (n) => n.left),
  childRule('xor-zero-left', 'canonical', 'xor', (n) => isConst(n.left, 0) ? {} : null, (n) => n.right),
  binRule('xor-self', 'canonical', 'xor', (n) => sameExpr(n.left, n.right) && isPure(n.left) ? {} : null, (n) => c(0, n)),
  binRule('sub-self', 'canonical', 'sub', (n) => sameExpr(n.left, n.right) && isPure(n.left) ? {} : null, (n) => c(0, n)),
  childRule('and-full-mask', 'canonical', 'and', (n) => isConst(n.right) && constOperandValue(n.right) === fullMask(n.bits) ? {} : null, (n) => n.left),
  childRule('shift-zero-shl', 'canonical', 'shl', (n) => isConst(n.right, 0) ? {} : null, (n) => n.left),
  childRule('shift-zero-lshr', 'canonical', 'lshr', (n) => isConst(n.right, 0) ? {} : null, (n) => n.left),
  childRule('shift-zero-ashr', 'canonical', 'ashr', (n) => isConst(n.right, 0) ? {} : null, (n) => n.left),
  childRule('and-self', 'canonical', 'and', (n) => sameExpr(n.left, n.right) && isStable(n.left) ? {} : null, (n) => n.left),
  childRule('or-self', 'canonical', 'or', (n) => sameExpr(n.left, n.right) && isStable(n.left) ? {} : null, (n) => n.left),
  childRule('udiv-one', 'canonical', 'udiv', (n) => isConst(n.right, 1) ? {} : null, (n) => n.left),
  childRule('sdiv-one', 'canonical', 'sdiv', (n) => isConst(n.right, 1) ? {} : null, (n) => n.left),
  binRule('umod-one', 'canonical', 'umod', (n) => isConst(n.right, 1) && isPure(n.left) ? {} : null, (n) => c(0, n)),
  binRule('smod-one', 'canonical', 'smod', (n) => isConst(n.right, 1) && isPure(n.left) ? {} : null, (n) => c(0, n)),
  {
    name: 'neg-zero', phase: 'canonical', match: (n) => n?.kind === 'unary' && n.op === 'neg' && isConst(n.arg, 0) ? {} : null,
    rewrite: (n) => c(0, n), proof: (before, after) => algebraProof('-0 == 0', before, after), cost,
  },
  {
    name: 'not-zero', phase: 'canonical', match: (n) => n?.kind === 'unary' && n.op === 'not' && isConst(n.arg, 0) ? {} : null,
    rewrite: (n) => c(fullMask(n.bits), n),
    proof: (before, after) => ({ kind: 'bitvector-identity', detail: '~0 == full mask', bits: widthOf(before) ?? null, domain: 'fixed-width-integer' }), cost,
  },
];

const constFoldOps = new Set(['add','sub','mul','and','or','xor','shl','lshr','ashr','ror','sdiv','udiv','smod','umod']);
// A stored constant is only authoritative modulo its own declared width (#8866):
// the width-exact evaluator resolves `const` as `u(value, node.bits)`, so folding
// must apply the same per-operand width before combining at the result width.
const constOperandValue = (n) => u(n.value, widthOf(n) ?? n.bits);
const constantRules = [{
  name: 'constant-fold-binary', phase: 'fold',
  match: (n) => n?.kind === 'binary' && constFoldOps.has(n.op) && isConst(n.left) && isConst(n.right) ? {} : null,
  precondition: () => true,
  rewrite: (n) => { const v = evalBinary(n.op, constOperandValue(n.left), constOperandValue(n.right), n.bits, n.signed); return v == null ? null : c(v, n); },
  proof: (before, after) => ({ kind: 'width-exact-evaluation', bits: widthOf(before) ?? null, domain: 'fixed-width-integer', result: after.value.toString() }),
  cost,
}, {
  name: 'constant-fold-unary', phase: 'fold',
  match: (n) => n?.kind === 'unary' && isConst(n.arg) ? {} : null,
  precondition: () => true,
  rewrite: (n) => { const v = evalUnary(n.op, constOperandValue(n.arg), n.bits, n.arg.bits); return v == null ? null : c(v, n); },
  proof: (before, after) => ({ kind: 'width-exact-evaluation', bits: widthOf(before) ?? null, domain: 'fixed-width-integer', result: after.value.toString() }),
  cost,
}];

function nestedConst(op, n) {
  if (n?.kind !== 'binary' || n.op !== op || !isConst(n.right)) return null;
  const x = n.left;
  if (x?.kind !== 'binary' || x.op !== op || !isConst(x.right)) return null;
  return { inner: x, a: constOperandValue(x.right), b: constOperandValue(n.right) };
}

const associativeRules = [
  binRule('collect-add-constants', 'algebra', 'add', (n) => nestedConst('add', n), (n, m) =>
    expr.binary('add', m.inner.left, c(u(m.a + m.b, n.bits), n), n.bits, n.signed, n.source),
    (n, m) => mayReorder(m.inner.left, n.right) && sameWidthDomain(n, m.inner)),
  binRule('collect-mul-constants', 'algebra', 'mul', (n) => nestedConst('mul', n), (n, m) =>
    expr.binary('mul', m.inner.left, c(u(m.a * m.b, n.bits), n), n.bits, n.signed, n.source),
    (n, m) => mayReorder(m.inner.left, n.right) && sameWidthDomain(n, m.inner)),
  binRule('double-term', 'algebra', 'add', (n) => sameExpr(n.left, n.right) && mayDuplicate(n.left) ? {} : null,
    (n) => expr.binary('mul', n.left, c(2, n), n.bits, n.signed, n.source)),
  binRule('strength-mul-power-two', 'idiom', 'mul', (n) => {
    if (!isConst(n.right)) return null;
    const factor = constOperandValue(n.right);
    return isPowerOfTwo(factor) ? { sh: log2Exact(factor) } : null;
  },
    (n, m) => expr.binary('shl', n.left, c(m.sh, n), n.bits, n.signed, n.source),
    (n, m) => isPure(n.left) && widthOf(n) != null && m.sh < widthOf(n)),
];

const arithmeticRules = [
  binRule('collect-add-sub-constants', 'algebra', 'sub', (n) => n.left?.kind === 'binary' && n.left.op === 'add' && isConst(n.left.right) && isConst(n.right) ? { inner:n.left } : null,
    (n,m) => expr.binary('add', m.inner.left, c(u(constOperandValue(m.inner.right) - constOperandValue(n.right), n.bits), n), n.bits, n.signed, n.source),
    (n,m) => isStable(m.inner.left) && sameWidthDomain(n, m.inner)),
  binRule('collect-sub-add-constants', 'algebra', 'add', (n) => n.left?.kind === 'binary' && n.left.op === 'sub' && isConst(n.left.right) && isConst(n.right) ? { inner:n.left } : null,
    (n,m) => expr.binary('add', m.inner.left, c(u(constOperandValue(n.right) - constOperandValue(m.inner.right), n.bits), n), n.bits, n.signed, n.source),
    (n,m) => isStable(m.inner.left) && sameWidthDomain(n, m.inner)),
  binRule('collect-sub-sub-constants', 'algebra', 'sub', (n) => n.left?.kind === 'binary' && n.left.op === 'sub' && isConst(n.left.right) && isConst(n.right) ? { inner:n.left } : null,
    (n,m) => expr.binary('sub', m.inner.left, c(u(constOperandValue(m.inner.right) + constOperandValue(n.right), n.bits), n), n.bits, n.signed, n.source),
    (n,m) => isStable(m.inner.left) && sameWidthDomain(n, m.inner)),
  // Factoring moves a multiplication across an addition/subtraction. That is only
  // sound when every intermediate it deletes wraps at the same fixed width as the
  // parent, otherwise each narrower product loses its own modular boundary (#8866).
  binRule('factor-common-left-add', 'algebra', 'add', (n) => {
    const a=n.left,b=n.right;
    if (a?.kind!=='binary'||b?.kind!=='binary'||a.op!=='mul'||b.op!=='mul') return null;
    if (sameExpr(a.left,b.left) && isStable(a.left) && isPure(a.right) && isPure(b.right)) return { common:a.left, x:a.right, y:b.right };
    return null;
  }, (n,m) => expr.binary('mul', m.common, expr.binary('add',m.x,m.y,n.bits,n.signed,n.source), n.bits,n.signed,n.source),
  (n) => sameWidthDomain(n, n.left, n.right)),
  binRule('factor-common-left-sub', 'algebra', 'sub', (n) => {
    const a=n.left,b=n.right;
    if (a?.kind!=='binary'||b?.kind!=='binary'||a.op!=='mul'||b.op!=='mul') return null;
    if (sameExpr(a.left,b.left) && isStable(a.left) && isPure(a.right) && isPure(b.right)) return { common:a.left, x:a.right, y:b.right };
    return null;
  }, (n,m) => expr.binary('mul', m.common, expr.binary('sub',m.x,m.y,n.bits,n.signed,n.source), n.bits,n.signed,n.source),
  (n) => sameWidthDomain(n, n.left, n.right)),
];

/*
 * #8861 — `min`/`max` is not one operator. The width-exact evaluator resolves
 * `signed === false` as unsigned bitvector ordering and anything else as signed
 * ordering, so two intrinsics that share a name can implement different total
 * orders. Idempotence `op(op(x,y),y) == op(x,y)` only holds inside one order
 * domain, therefore nested collapse compares the full ordering signature
 * (result width, resolved signedness, retained comparison provenance) and fails
 * closed on any mismatch or one-sided unknown metadata.
 */
const orderSignature = (n) => `${n?.signed === false ? 'unsigned' : n?.signed === true ? 'signed' : 'unknown'}:${n?.compareSigned === undefined ? null : n.compareSigned}`;
const sameOrderDomain = (a, b) => orderSignature(a) === orderSignature(b) && a?.signed != null && b?.signed != null;

const intrinsicRules = [{
  name:'idempotent-minmax', phase:'select',
  match:(n)=>n?.kind==='intrinsic' && ['min','max'].includes(n.name) && n.args?.length===2 && sameExpr(n.args[0],n.args[1]) && isStable(n.args[0]) ? {} : null,
  precondition:(n)=>sameWidthDomain(n, n.args[0]),
  rewrite:(n)=>n.args[0], proof:(before)=>({ kind:'order-identity', detail:'min/max(x,x) == x', bits: widthOf(before) ?? null, ordering: before?.signed === false ? 'unsigned' : 'signed' }), cost,
}, {
  name:'nested-minmax-idempotent', phase:'select',
  match:(n)=>n?.kind==='intrinsic' && ['min','max'].includes(n.name) && n.args?.length===2 && n.args[0]?.kind==='intrinsic' && n.args[0].name===n.name
    && n.args[0].args?.some((a)=>sameExpr(a,n.args[1])) && isStable(n.args[1]) ? { inner:n.args[0] } : null,
  precondition:(n,m)=>sameWidthDomain(n, m.inner) && sameOrderDomain(n, m.inner),
  rewrite:(n,m)=>m.inner,
  proof:(before, after, m)=>({ kind:'order-idempotence', detail:'min/max(min/max(x,y),y)', bits: widthOf(before) ?? null,
    ordering: before?.signed === false ? 'unsigned' : 'signed', domainSignature: orderSignature(before), innerSignature: orderSignature(m.inner) }), cost,
}];

const bitRules = [
  binRule('merge-and-masks', 'bits', 'and', (n) => n.left?.kind === 'binary' && n.left.op === 'and' && isConst(n.left.right) && isConst(n.right)
    ? { inner: n.left } : null,
    (n, m) => expr.binary('and', m.inner.left, c(u(constOperandValue(m.inner.right) & constOperandValue(n.right), n.bits), n), n.bits, n.signed, n.source),
    (n, m) => isPure(m.inner.left) && sameWidthDomain(n, m.inner)),
  binRule('merge-or-masks', 'bits', 'or', (n) => n.left?.kind === 'binary' && n.left.op === 'or' && isConst(n.left.right) && isConst(n.right)
    ? { inner: n.left } : null,
    (n, m) => expr.binary('or', m.inner.left, c(u(constOperandValue(m.inner.right) | constOperandValue(n.right), n.bits), n), n.bits, n.signed, n.source),
    (n, m) => isPure(m.inner.left) && sameWidthDomain(n, m.inner)),
  {
    // `~~x == x` only holds when the two NOTs share one fixed-width domain; the
    // outer NOT also has to be the width the replacement keeps (#8866).
    name: 'double-bitwise-not', phase: 'bits',
    match: (n) => n?.kind === 'unary' && n.op === 'not' && n.arg?.kind === 'unary' && n.arg.op === 'not' ? {} : null,
    precondition: (n) => isPure(n.arg.arg) && sameWidthDomain(n, n.arg, n.arg.arg),
    rewrite: (n) => n.arg.arg,
    proof: (before) => ({ kind: 'bitvector-identity', detail: '~~x == x', bits: widthOf(before) ?? null, domain: 'fixed-width-integer' }), cost,
  },
  {
    name: 'collapse-nested-extract', phase: 'bits',
    match: (n) => n?.kind === 'intrinsic' && n.name === 'bit_extract' && n.args?.[0]?.kind === 'intrinsic' && n.args[0].name === 'bit_extract'
      && isConst(n.args[1]) && isConst(n.args[2]) && isConst(n.args[0].args?.[1]) && isConst(n.args[0].args?.[2]) ? { inner: n.args[0] } : null,
    precondition: (n, m) => {
      const lsb = constOperandValue(n.args[1]), width = constOperandValue(n.args[2]);
      const innerWidth = constOperandValue(m.inner.args[2]);
      return lsb + width <= innerWidth;
    },
    rewrite: (n, m) => expr.intrinsic('bit_extract', [m.inner.args[0], c(constOperandValue(m.inner.args[1]) + constOperandValue(n.args[1]), n), n.args[2]], n.bits, n.signed, n.source),
    proof: proof('bit-slice-composition', 'nested fixed-width extraction'), cost,
  },
];

const compareRules = [{
  name: 'compare-self-eq-ne', phase: 'boolean',
  match: (n) => n?.kind === 'compare' && n.comparisonDomain !== 'floating' && ['eq','ne'].includes(n.op) && sameExpr(n.left, n.right) && isPure(n.left) ? {} : null,
  rewrite: (n) => c(n.op === 'eq' ? 1 : 0, n, 1),
  proof: proof('comparison-reflexivity', 'pure expression compared with itself'), cost,
}, {
  name: 'boolean-eq-zero', phase: 'boolean',
  match: (n) => n?.kind === 'compare' && n.op === 'eq' && isConst(n.right, 0) && n.left?.bits === 1 ? {} : null,
  rewrite: (n) => expr.unary('lnot', n.left, 1, false, n.source), proof: proof('boolean-normalization', 'bool == 0'), cost,
}, {
  name: 'boolean-ne-zero', phase: 'boolean',
  match: (n) => n?.kind === 'compare' && n.op === 'ne' && isConst(n.right, 0) && n.left?.bits === 1 ? {} : null,
  rewrite: (n) => n.left, proof: proof('boolean-normalization', 'bool != 0'), cost,
}, {
  name: 'double-logical-not', phase: 'boolean',
  match: (n) => n?.kind === 'unary' && n.op === 'lnot' && n.arg?.kind === 'unary' && n.arg.op === 'lnot' ? {} : null,
  precondition: (n) => isPure(n.arg.arg) && n.arg.arg?.bits === 1 && widthOf(n) === 1, rewrite: (n) => n.arg.arg, proof: proof('boolean-identity', '!!bool'), cost,
}];

const compareCanonicalRules = [{
  name:'compare-constant-right', phase:'boolean',
  match:(n)=>n?.kind==='compare' && isConst(n.left) && !isConst(n.right) && ['eq','ne','lt','le','gt','ge'].includes(n.op) ? {} : null,
  precondition:(n)=>isStable(n.right),
  rewrite:(n)=>expr.compare(({eq:'eq',ne:'ne',lt:'gt',le:'ge',gt:'lt',ge:'le'})[n.op], n.right, n.left, n.compareSigned, n.source),
  proof:proof('comparison-symmetry','swap operands and invert ordering'), cost,
}, {
  name:'bool-eq-one', phase:'boolean',
  match:(n)=>n?.kind==='compare' && n.op==='eq' && isConst(n.right,1) && n.left?.bits===1 ? {} : null,
  rewrite:(n)=>n.left, proof:proof('boolean-normalization','bool == 1'), cost,
}, {
  name:'bool-ne-one', phase:'boolean',
  match:(n)=>n?.kind==='compare' && n.op==='ne' && isConst(n.right,1) && n.left?.bits===1 ? {} : null,
  rewrite:(n)=>expr.unary('lnot',n.left,1,false,n.source), proof:proof('boolean-normalization','bool != 1'), cost,
}];

const rangeRules = [{
  name:'range-proven-compare', phase:'range',
  match:(n)=>{
    if (n?.kind!=='compare' || !n.left?.range || !isConst(n.right)) return null;
    const source=n.left.range;
    const bits=Number(n.left.bits || source.bits || 64);
    const relational=!['eq','ne'].includes(n.op);
    const compareSigned=relational ? n.compareSigned : (source.signed ?? n.compareSigned);
    if (relational && compareSigned == null) return null;
    const r=normalizeRangeDomain(source,bits,compareSigned);
    if (!r) return null;
    const c=normalizeIntegerValue(n.right.value,bits,compareSigned);
    let value=null;
    if (n.op==='eq' && (c<r.min || c>r.max)) value=0;
    else if (n.op==='ne' && (c<r.min || c>r.max)) value=1;
    else if (n.op==='lt' && r.max<c) value=1;
    else if (n.op==='lt' && r.min>=c) value=0;
    else if (n.op==='le' && r.max<=c) value=1;
    else if (n.op==='le' && r.min>c) value=0;
    else if (n.op==='gt' && r.min>c) value=1;
    else if (n.op==='gt' && r.max<=c) value=0;
    else if (n.op==='ge' && r.min>=c) value=1;
    else if (n.op==='ge' && r.max<c) value=0;
    return value==null ? null : {
      value,
      range:{min:String(r.min),max:String(r.max),bits:r.bits,signed:r.signed},
      constant:String(c),
    };
  },
  precondition:(n)=>isStable(n.left),
  rewrite:(n,m)=>c(m.value,n,1),
  proof:(before,after,m)=>({kind:'range-proof',relation:before.op,range:m.range,constant:m.constant,result:m.value}),
  cost,
}];

const selectRules = [{
  name: 'select-identical-arms', phase: 'select',
  match: (n) => n?.kind === 'select' && sameExpr(n.whenTrue, n.whenFalse) && isPure(n.condition) && mayDuplicate(n.whenTrue) ? {} : null,
  precondition: (n) => sameWidthDomain(n, n.whenTrue),
  rewrite: (n) => n.whenTrue, proof: proof('conditional-identity', 'both select arms identical'), cost,
}, {
  name: 'select-bool-materialize', phase: 'select',
  match: (n) => n?.kind === 'select' && n.condition?.bits === 1 && isConst(n.whenTrue, 1) && isConst(n.whenFalse, 0) ? {} : null,
  precondition: (n) => sameWidthDomain(n, n.condition),
  rewrite: (n) => n.condition, proof: proof('conditional-identity', 'cond ? 1 : 0'), cost,
}, {
  name: 'select-bool-invert', phase: 'select',
  match: (n) => n?.kind === 'select' && isConst(n.whenTrue, 0) && isConst(n.whenFalse, 1) ? {} : null,
  precondition: (n) => widthOf(n) === 1,
  rewrite: (n) => expr.unary('lnot', n.condition, 1, false, n.source), proof: proof('conditional-identity', 'cond ? 0 : 1'), cost,
}, {
  name: 'select-min-max', phase: 'select',
  match: (n) => {
    if (n?.kind !== 'select' || n.condition?.kind !== 'compare') return null;
    const q = n.condition;
    // Constant signedness/nominal width is metadata; select equivalence is over
    // the result bitvector. This keeps WZR and #0 equivalent after width-aware
    // operand reconstruction while retaining strict structural matching for
    // non-constant expressions.
    const unwrapCast = (x) => x?.kind === 'cast' ? unwrapCast(x.arg) : x;
    const sameArm = (a,b) => {
      const ua = unwrapCast(a), ub = unwrapCast(b);
      return sameExpr(a,b) || sameExpr(ua, ub) || (isConst(a) && isConst(b)
        && BigInt.asUintN(Number(n.bits || q.left?.bits || 64), a.value) === BigInt.asUintN(Number(n.bits || q.left?.bits || 64), b.value));
    };
    const ta = sameArm(n.whenTrue, q.left), tb = sameArm(n.whenTrue, q.right);
    const fa = sameArm(n.whenFalse, q.left), fb = sameArm(n.whenFalse, q.right);
    if (!(isStable(q.left) && isStable(q.right))) return null;
    if ((q.op === 'gt' || q.op === 'ge') && ta && fb) return { name: 'max' };
    if ((q.op === 'gt' || q.op === 'ge') && tb && fa) return { name: 'min' };
    if ((q.op === 'lt' || q.op === 'le') && ta && fb) return { name: 'min' };
    if ((q.op === 'lt' || q.op === 'le') && tb && fa) return { name: 'max' };
    return null;
  },
  // The ordering semantics come from the compare that guards the select, not
  // from the result storage type. This matters at -O0 where Clang spills both
  // arms to stack slots whose recovered value type can remain unsigned/unknown.
  rewrite: (n, m) => expr.intrinsic(m.name, [n.condition.left, n.condition.right], n.bits, n.condition.compareSigned ?? n.signed, n.source, { compareSigned: n.condition.compareSigned }),
  proof: (before, after, m) => ({ kind: 'select-comparison-equivalence', operation: m.name, signed: before.condition.compareSigned }), cost,
}, {
  name: 'select-abs', phase: 'select',
  match: (n) => {
    if (n?.kind !== 'select' || n.condition?.kind !== 'compare') return null;
    const q = n.condition;
    if (!isConst(q.right, 0) || !isStable(q.left)) return null;
    const unwrapCast = (x) => x?.kind === 'cast' ? unwrapCast(x.arg) : x;
    const neg = (x) => {
      const ux = unwrapCast(x);
      return ux?.kind === 'unary' && ux.op === 'neg' && (sameExpr(ux.arg, q.left) || sameExpr(unwrapCast(ux.arg), unwrapCast(q.left)));
    };
    const sameL = (x) => sameExpr(x, q.left) || sameExpr(unwrapCast(x), unwrapCast(q.left));
    if ((q.op === 'lt' || q.op === 'le') && neg(n.whenTrue) && sameL(n.whenFalse)) return {};
    if ((q.op === 'ge' || q.op === 'gt') && sameL(n.whenTrue) && neg(n.whenFalse)) return {};
    return null;
  },
  rewrite: (n) => expr.intrinsic('abs', [n.condition.left], n.bits, true, n.source),
  proof: proof('select-comparison-equivalence', 'two-arm signed absolute value'), cost,
}];

const extensionRules = [{
  name: 'redundant-trunc', phase: 'width',
  match: (n) => n?.kind === 'unary' && n.op === 'trunc' && Number(n.arg?.bits) === Number(n.bits) ? {} : null,
  rewrite: (n) => n.arg, proof: proof('width-identity', 'same-width truncation'), cost,
}, {
  name: 'redundant-zext', phase: 'width',
  match: (n) => n?.kind === 'unary' && n.op === 'zext' && Number(n.arg?.bits) === Number(n.bits) ? {} : null,
  rewrite: (n) => n.arg, proof: proof('width-identity', 'same-width zero extension'), cost,
}, {
  name: 'redundant-sext', phase: 'width',
  match: (n) => n?.kind === 'unary' && n.op === 'sext' && Number(n.arg?.bits) === Number(n.bits) ? {} : null,
  rewrite: (n) => n.arg, proof: proof('width-identity', 'same-width sign extension'), cost,
}, {
  // A declared `zext`/`sext` whose result is *narrower* than its source is a
  // truncation in this typed AST, so chain composition only cancels when the
  // widths are monotonically non-decreasing outwards (#8866).
  name: 'collapse-zext-chain', phase: 'width',
  match: (n) => n?.kind === 'unary' && n.op === 'zext' && n.arg?.kind === 'unary' && n.arg.op === 'zext' ? {} : null,
  precondition: (n) => wideningExtensionChain(n),
  rewrite: (n) => expr.unary('zext', n.arg.arg, n.bits, false, n.source), proof: proof('extension-composition', 'zext(zext(x))'), cost,
}, {
  name: 'trunc-after-zext-to-source-width', phase: 'width',
  match: (n) => n?.kind === 'unary' && n.op === 'trunc' && n.arg?.kind === 'unary' && n.arg.op === 'zext' && Number(n.bits) === Number(n.arg.arg?.bits) ? {} : null,
  precondition: (n) => wideningExtensionChain(n),
  rewrite: (n) => n.arg.arg, proof: proof('extension-truncation-cancel', 'trunc(zext(x)) to original width'), cost,
}, {
  name: 'trunc-after-sext-to-source-width', phase: 'width',
  match: (n) => n?.kind === 'unary' && n.op === 'trunc' && n.arg?.kind === 'unary' && n.arg.op === 'sext' && Number(n.bits) === Number(n.arg.arg?.bits) ? {} : null,
  precondition: (n) => wideningExtensionChain(n),
  rewrite: (n) => n.arg.arg, proof: proof('extension-truncation-cancel', 'trunc(sext(x)) to original width'), cost,
}, {
  name: 'collapse-sext-chain', phase: 'width',
  match: (n) => n?.kind === 'unary' && n.op === 'sext' && n.arg?.kind === 'unary' && n.arg.op === 'sext' ? {} : null,
  precondition: (n) => wideningExtensionChain(n),
  rewrite: (n) => expr.unary('sext', n.arg.arg, n.bits, true, n.source), proof: proof('extension-composition', 'sext(sext(x))'), cost,
}];

export const DEFAULT_RULES = Object.freeze([
  ...identityRules,
  ...constantRules,
  ...associativeRules,
  ...arithmeticRules,
  ...bitRules,
  ...compareRules,
  ...compareCanonicalRules,
  ...rangeRules,
  ...selectRules,
  ...intrinsicRules,
  ...extensionRules,
]);
