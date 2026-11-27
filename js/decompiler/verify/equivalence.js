import { evalBinary, evalUnary, u } from '../truth/integer.js';

const MAX_EVAL_DEPTH = 128;
const MAX_BIT_EXTRACT_SHIFT = 4096n;

export function evaluateExpression(n, env = {}, memory = {}, depth = 0, memo = new Map()) {
  if (!n || typeof n !== 'object' || depth > MAX_EVAL_DEPTH) return null;
  if (memo.has(n)) return memo.get(n);
  memo.set(n, null);
  let result = null;
  switch (n.kind) {
    case 'const': result = u(n.value, n.bits); break;
    case 'var': {
      const val = env && Object.hasOwn(env, n.name) ? env[n.name] : null;
      result = val == null ? null : u(val, n.bits);
      break;
    }
    case 'unary': {
      const a = evaluateExpression(n.arg, env, memory, depth + 1, memo);
      result = a == null ? null : evalUnary(n.op, a, n.bits, n.arg?.bits || n.bits);
      break;
    }
    case 'binary': {
      const a = evaluateExpression(n.left, env, memory, depth + 1, memo);
      const b = evaluateExpression(n.right, env, memory, depth + 1, memo);
      result = (a == null || b == null) ? null : evalBinary(n.op, a, b, n.bits, n.signed);
      break;
    }
    case 'compare': {
      const a = evaluateExpression(n.left, env, memory, depth + 1, memo);
      const b = evaluateExpression(n.right, env, memory, depth + 1, memo);
      result = (a == null || b == null) ? null : evalBinary(n.op, a, b, n.left?.bits || n.right?.bits || 64, n.compareSigned);
      break;
    }
    case 'select': {
      const q = evaluateExpression(n.condition, env, memory, depth + 1, memo);
      result = q == null ? null : evaluateExpression(q === 0n ? n.whenFalse : n.whenTrue, env, memory, depth + 1, memo);
      break;
    }
    case 'intrinsic': {
      const args = (n.args || []).map((a) => evaluateExpression(a, env, memory, depth + 1, memo));
      if (args.some((a) => a == null)) { result = null; break; }
      const bits = Number(n.bits) || 64;
      if (n.name === 'min' && args.length >= 2) {
        result = n.signed === false ? (args[0] < args[1] ? args[0] : args[1]) : (BigInt.asIntN(bits, args[0]) < BigInt.asIntN(bits, args[1]) ? args[0] : args[1]);
      } else if (n.name === 'max' && args.length >= 2) {
        result = n.signed === false ? (args[0] > args[1] ? args[0] : args[1]) : (BigInt.asIntN(bits, args[0]) > BigInt.asIntN(bits, args[1]) ? args[0] : args[1]);
      } else if (n.name === 'abs' && args.length >= 1) {
        result = evalUnary('abs', args[0], bits);
      } else if (n.name === 'bit_extract' && args.length >= 3) {
        if (args[1] < 0n || args[1] > MAX_BIT_EXTRACT_SHIFT || args[2] < 0n || args[2] > MAX_BIT_EXTRACT_SHIFT) { result = null; break; }
        const lsb = args[1], width = Number(args[2]);
        result = u(args[0] >> lsb, width);
      } else if (n.name === 'madd' && args.length >= 3) {
        result = u(args[0] * args[1] + args[2], bits);
      } else if (n.name === 'msub' && args.length >= 3) {
        result = u(args[2] - args[0] * args[1], bits);
      }
      break;
    }
    case 'load': {
      const key = n.location?.key || n.location?.name;
      result = (memory && key != null && Object.hasOwn(memory, key)) ? (memory[key] ?? null) : null;
      break;
    }
    default: result = null; break;
  }
  memo.set(n, result);
  return result;
}

export function verifyRewrite(original, rewritten, opts = {}) {
  const widths = opts.widths || [8, 16, 32, 64];
  const seeds = opts.samples || [0n, 1n, -1n, 2n, 7n, 0x7fn, 0x80n, 0xffn, 0x7fffffffn, 0x80000000n, 0xffffffffn, 0x7fffffffffffffffn, 0xffffffffffffffffn];
  const variables = [...collectVariables(original), ...collectVariables(rewritten)];
  const names = [...new Set(variables)];
  let checked = 0;
  let skipped = 0;
  const checkEnv = (bits, env) => {
    const a = evaluateExpression(original, env), b = evaluateExpression(rewritten, env);
    if (a == null || b == null) { skipped++; return null; }
    checked++;
    if (u(a, original.bits || bits) !== u(b, rewritten.bits || bits)) return { equivalent: false, checked, counterexample: { bits, env, original: a, rewritten: b } };
    return null;
  };
  for (const bits of widths) {
    for (let i = 0; i < seeds.length; i++) {
      const env = Object.create(null);
      for (let j = 0; j < names.length; j++) env[names[j]] = u(seeds[(i + j) % seeds.length], bits);
      const fail = checkEnv(bits, env);
      if (fail) return fail;
    }
    if (names.length >= 2) {
      for (let i = 0; i < Math.min(4, seeds.length); i++) {
        const sameEnv = Object.create(null);
        const v = u(seeds[i], bits);
        for (const name of names) sameEnv[name] = v;
        const fail = checkEnv(bits, sameEnv);
        if (fail) return fail;
      }
    }
  }
  if (checked === 0) return { equivalent: null, checked, skipped, reason: 'no-evaluable-samples' };
  if (skipped > 0) return { equivalent: null, checked, skipped, reason: 'incomplete-evaluator-coverage' };
  return { equivalent: true, checked };
}

export function collectVariables(n, out = new Set(), seen = new WeakSet(), depth = 0) {
  if (!n || typeof n !== 'object' || depth > MAX_EVAL_DEPTH || seen.has(n)) return out;
  seen.add(n);
  if (n.kind === 'var') out.add(n.name);
  if (n.arg) collectVariables(n.arg, out, seen, depth + 1);
  if (n.left) collectVariables(n.left, out, seen, depth + 1);
  if (n.right) collectVariables(n.right, out, seen, depth + 1);
  if (n.condition) collectVariables(n.condition, out, seen, depth + 1);
  if (n.whenTrue) collectVariables(n.whenTrue, out, seen, depth + 1);
  if (n.whenFalse) collectVariables(n.whenFalse, out, seen, depth + 1);
  for (const a of n.args || []) collectVariables(a, out, seen, depth + 1);
  if (n.base) collectVariables(n.base, out, seen, depth + 1);
  if (n.index) collectVariables(n.index, out, seen, depth + 1);
  return out;
}

export async function verifyWithFunctionSandbox(adapter, original, rewritten, cases = []) {
  if (!adapter || typeof adapter.execute !== 'function') return { available: false, reason: 'sandbox adapter unavailable' };
  const mismatches = [];
  for (const c of cases) {
    const a = await adapter.execute(original, c);
    const b = await adapter.execute(rewritten, c);
    const serialize = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
    if (serialize(a) !== serialize(b)) mismatches.push({ input: c, original: a, rewritten: b });
  }
  if (cases.length === 0) return { available: true, equivalent: null, checked: 0, mismatches, reason: 'no-cases' };
  return { available: true, equivalent: mismatches.length === 0, checked: cases.length, mismatches: mismatches.slice(0, 8) };
}
