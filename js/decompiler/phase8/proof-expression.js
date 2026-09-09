/** Bounded display lowering, not a solver or candidate/proof authority.
 * Only the committed proof plan may publish expressions made from this recipe.
 * Inputs are slots in the actual target-local translator relation, never names.
 */
import { expr } from '../ast/nodes.js';

const BINARY = new Set(['add','sub','mul','and','or','xor','shl','lshr','ashr']);
const COMPARE = new Set(['eq','ne','ult','ule','ugt','uge','slt','sle','sgt','sge']);
const CONNECTIVE = new Set(['and','or','xor','not','implies','eq','ne']);
export const PROOF_EXPRESSION_VERSION = 'hex.proof-expression/1';

/** Exact display recipe + actual input endpoints; hashes/names are not enough
 * when two target-local symbol scopes share an observed rendered root. */
export function sameProofExpression(a, aInputs, b, bInputs) {
  return a.version === b.version && a.root === b.root && a.nodes.length === b.nodes.length
    && a.nodes.every((node,index) => {
      const other = b.nodes[index];
      return ['kind','bits','op','value','low'].every(key => node[key] === other[key])
        && node.args.length === other.args.length && node.args.every((arg,i) => arg === other.args[i])
        && (node.kind !== 'fresh_symbol' || aInputs[node.input] === bInputs[other.input]);
    });
}

export function compileProofExpression(root, binding, guard) {
  const inputs = new Map(binding.inputs.map((input, index) => [input.symbol, index]));
  const nodes = [], done = new Map(), active = new Set(), stack = [[root, false, 1]];
  while (stack.length) {
    guard?.take('workItems');
    const [node, exit, depth] = stack.pop();
    if (done.has(node)) continue;
    if (!node || depth > 24 || nodes.length >= 128) return null;
    const bits = node.sort?.kind === 'bool' ? 1 : node.sort?.kind === 'bv' ? node.sort.width : 0;
    if (!Number.isInteger(bits) || bits < 1 || bits > 64) return null;
    let children;
    if (node.kind === 'const') children = [];
    else if (node.kind === 'fresh_symbol' && inputs.has(node)) children = [];
    else if (node.kind === 'unary' && ['not','neg'].includes(node.op)
      || node.kind === 'cast' && ['trunc','zext','sext'].includes(node.op)
      || node.kind === 'extract') children = [node.arg];
    else if (node.kind === 'binary' && BINARY.has(node.op)
      || node.kind === 'compare' && COMPARE.has(node.op) || node.kind === 'concat') children = [node.left,node.right];
    else if (node.kind === 'ite') children = [node.cond,node.thenExpr,node.elseExpr];
    else if (node.kind === 'connective' && CONNECTIVE.has(node.op) && node.args.length <= 32) children = node.args;
    else return null;
    if (!exit) {
      if (active.has(node)) return null;
      active.add(node); stack.push([node,true,depth]);
      for (let i = children.length - 1; i >= 0; i--) stack.push([children[i],false,depth + 1]);
      continue;
    }
    active.delete(node);
    const args = children.map(child => done.get(child));
    const isShift = node.kind === 'binary' && ['shl','lshr','ashr'].includes(node.op);
    const expanded = 1 + args.reduce((sum,index,operand) => sum + nodes[index].expanded
      * (isShift && (operand === 1 || node.op === 'ashr') ? 2 : 1), 0);
    // Account for tree expansion even when the canonical expression is a DAG.
    // Include duplicated operands in guarded shift lowering. The printer and
    // origin union must not expand an exponential canonical OR lowered tree.
    if (expanded > 512) return null;
    guard?.take('allocationUnits', 2 + args.length);
    done.set(node,nodes.length);
    nodes.push(Object.freeze({kind:node.kind, bits, op:node.op ?? null,
      value:node.kind === 'const' ? BigInt(node.value) : null,
      input:node.kind === 'fresh_symbol' ? inputs.get(node) : null,
      low:node.kind === 'extract' ? node.low : null,
      args:Object.freeze(args),expanded}));
  }
  return Object.freeze({version:PROOF_EXPRESSION_VERSION,nodes:Object.freeze(nodes),root:done.get(root)});
}

const carrier = bits => bits <= 8 ? 8 : bits <= 16 ? 16 : bits <= 32 ? 32 : 64;
const mask = bits => (1n << BigInt(bits)) - 1n;
// Make integer promotions, signed input declarations and non-native BV widths
// explicit in the existing C AST. No uint4_t / int1_t casts are manufactured.
function unsigned(value, bits) {
  if (value.bits < bits) value = unsigned(value,value.bits);
  const width = carrier(bits);
  const cast = expr.unary('zext',value,width,false);
  return width === bits ? cast : expr.binary('and',cast,expr.constant(mask(bits),width,false),bits,false);
}
function signExtend(value, from, to) {
  const sign = expr.constant(1n << BigInt(from - 1),to,false);
  return unsigned(expr.binary('sub',expr.binary('xor',unsigned(value,to),sign,to,false),sign,to,false),to);
}
function signed(value, bits) {
  const width = carrier(bits);
  return expr.unary('sext',signExtend(value,bits,width),width,true);
}

/** Caller supplies actual producer expressions, in the compiled input order.
 * The recipe is immutable private-plan data at the publication callsite.
 */
export function renderProofExpression(recipe, inputs, shouldAbort) {
  if (recipe?.version !== PROOF_EXPRESSION_VERSION || recipe.nodes.length > 128) return null;
  const built = [];
  for (const node of recipe.nodes) {
    if (shouldAbort?.()) return null;
    const args = node.args.map(index => built[index]), bits = node.bits;
    let value;
    if (node.kind === 'const') value = expr.constant(node.value,bits,false);
    else if (node.kind === 'fresh_symbol') {
      value = inputs[node.input];
      if (!value || value.bits !== bits || value.effect !== 'pure') return null;
      value = unsigned(value,bits);
    } else if (node.kind === 'unary') value = unsigned(expr.unary(node.op,unsigned(args[0],bits),bits,false),bits);
    else if (node.kind === 'binary') {
      const [left,right] = args;
      if (['shl','lshr','ashr'].includes(node.op)) {
        const width = carrier(bits), count = unsigned(right,bits);
        const input = node.op === 'ashr' ? signed(left,bits) : unsigned(left,bits);
        const shift = amount => unsigned(expr.binary(node.op,input,amount,width,node.op === 'ashr'),bits);
        const fallback = node.op === 'ashr' ? shift(expr.constant(BigInt(bits - 1),width,false)) : expr.constant(0n,bits,false);
        // Solver BV shifts saturate, whereas the existing machine AST evaluator
        // masks counts. The guard makes both AST evaluation and printed C exact.
        value = expr.select(expr.compare('lt',count,expr.constant(BigInt(bits),carrier(bits),false),false),
          shift(count),fallback,bits,false);
      } else value = unsigned(expr.binary(node.op,unsigned(left,bits),unsigned(right,bits),bits,false),bits);
    } else if (node.kind === 'cast') {
      value = node.op === 'sext' ? signExtend(args[0],args[0].bits,bits) : unsigned(args[0],bits);
    } else if (node.kind === 'extract') {
      const width = carrier(args[0].bits);
      value = unsigned(expr.binary('lshr',unsigned(args[0],args[0].bits),expr.constant(BigInt(node.low),width,false),width,false),bits);
    } else if (node.kind === 'concat') {
      const left = expr.binary('shl',unsigned(args[0],bits),expr.constant(BigInt(args[1].bits),carrier(bits),false),carrier(bits),false);
      value = unsigned(expr.binary('or',left,unsigned(args[1],bits),carrier(bits),false),bits);
    } else if (node.kind === 'compare') {
      const isSigned = node.op.startsWith('s'), op = ['eq','ne'].includes(node.op) ? node.op : node.op.slice(1);
      const view = arg => isSigned ? signed(arg,arg.bits) : unsigned(arg,arg.bits);
      value = expr.compare(op,view(args[0]),view(args[1]),isSigned);
    } else if (node.kind === 'ite') value = expr.select(args[0],args[1],args[2],bits,false);
    else if (node.kind === 'connective') {
      if (node.op === 'not') value = expr.unary('lnot',args[0],1,false);
      else if (['eq','ne'].includes(node.op)) value = expr.compare(node.op,args[0],args[1],false);
      else if (node.op === 'implies') value = expr.binary('or',expr.unary('lnot',args[0],1,false),args[1],1,false);
      else value = args.reduce((left,right) => expr.binary(node.op,left,right,1,false),expr.constant(node.op === 'and' ? 1n : 0n,1,false));
    } else return null;
    built.push(value);
  }
  return built[recipe.root] ?? null;
}
