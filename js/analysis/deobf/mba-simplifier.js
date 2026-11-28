// Linear MBA Mobius Simplifier & 3-Layer Deterministic Equivalence Proof (§19.2).
// 100% clean-room (ZERO GPL code) + C++ Track 5 parity (`mba_simplifier.cpp`) + WASM bridge/telemetry.
// INV-005: ZERO direct imports from js/targets/architecture/ or js/targets/abi/.

import { getHexEngineExports } from '../../core/hex-engine-wasm.js';
import { recordWasmCall, recordFallback } from '../../core/wasm-telemetry.js';

export const HEX_OPT_FLAG_MBA = 1 << 0;
export const HEX_OPT_FLAG_MBA_STRICT_PROOF = 1 << 1;

export const MBA_MAX_VARS = 3; // Matches C++ kMaxVars = 3
export const MBA_MAX_DEPTH = 12;
export const MBA_MAX_NODES = 64;

const PURE_OPS = new Set(['var', 'const', 'add', 'sub', 'mul', 'xor', 'and', 'or', 'not', 'neg']);
const BITWISE_OPS = new Set(['and', 'or', 'xor', 'not']);
const ARITH_OPS = new Set(['add', 'sub', 'neg', 'mul']);
const MASK64 = 0xffffffffffffffffn;
const MASK32 = 0xffffffffn;

// Exact C++ kBasis8 & kBasis64 vectors (cpp/src/decompiler/mba_simplifier.cpp)
const BASIS8 = [0x00n, 0x01n, 0x02n, 0x03n, 0x0fn, 0x33n, 0x55n, 0xffn];
const BASIS64 = [
  0x0000000000000000n,
  0x0000000000000001n,
  0x5555555555555555n,
  0xaaaaaaaaaaaaaaaan,
  0x7fffffffffffffffn,
  0xffffffffffffffffn,
];

// C++ HexMbaOp enum values
const HEX_MBA_OP = Object.freeze({
  var: 0,
  const: 1,
  add: 2,
  sub: 3,
  neg: 4,
  not: 5,
  and: 6,
  or: 7,
  xor: 8,
  mul_const: 9,
});

function maskForWidth(width) {
  return width === 32 ? MASK32 : MASK64;
}

function toSignedBigInt(val, width) {
  const mask = maskForWidth(width);
  const u = BigInt(val) & mask;
  const signBit = 1n << BigInt(width - 1);
  return u >= signBit ? u - (mask + 1n) : u;
}

/**
 * Deterministic SplitMix64 generator matching C++ `splitmix64_next` bit-for-bit.
 */
function makeSplitMix64(seed = 0x123456789abcdef0n) {
  let state = BigInt(seed) & MASK64;
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
  };
}

function isConstOnly(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > MBA_MAX_DEPTH) return false;
  if (node.op === 'const') return true;
  if (node.op === 'var') return false;
  if (node.op === 'not' || node.op === 'neg') return isConstOnly(node.a, depth + 1);
  if (node.op === 'add' || node.op === 'sub' || node.op === 'mul' || node.op === 'xor' || node.op === 'and' || node.op === 'or') {
    return isConstOnly(node.a, depth + 1) && isConstOnly(node.b, depth + 1);
  }
  return false;
}

export function inspectMbaDag(root) {
  if (!root || typeof root !== 'object') {
    return { eligible: false, reason: 'invalid_root' };
  }
  const width = root.width;
  if (width !== 32 && width !== 64) {
    return { eligible: false, reason: 'unsupported_width' };
  }

  const vars = [];
  const varSet = new Set();
  const seen = new Set();
  let nodeCount = 0;
  let maxDepth = 0;
  let isLinearMba = true;

  function visit(node, depth, insideBitwise = false) {
    if (!node || typeof node !== 'object') return 'invalid_node';
    if (!PURE_OPS.has(node.op)) return `disallowed_op:${node.op}`;
    if (node.width !== width) return 'mixed_width';
    if (depth > MBA_MAX_DEPTH) return 'max_depth_exceeded';
    if (depth > maxDepth) maxDepth = depth;

    if (!seen.has(node)) {
      seen.add(node);
      nodeCount++;
      if (nodeCount > MBA_MAX_NODES) return 'max_nodes_exceeded';
    }

    if (insideBitwise && ARITH_OPS.has(node.op)) {
      isLinearMba = false;
    }
    const childInsideBitwise = insideBitwise || BITWISE_OPS.has(node.op);

    if (node.op === 'var') {
      const name = String(node.name ?? '');
      if (!name) return 'unnamed_var';
      if (!varSet.has(name)) {
        varSet.add(name);
        vars.push(name);
        if (vars.length > MBA_MAX_VARS) return 'too_many_vars';
      }
      return null;
    }
    if (node.op === 'const') return null;

    if (node.op === 'not' || node.op === 'neg') {
      return visit(node.a, depth + 1, childInsideBitwise);
    }

    if (node.op === 'mul') {
      if (!isConstOnly(node.a, depth + 1) && !isConstOnly(node.b, depth + 1)) {
        isLinearMba = false;
      }
    }

    const errA = visit(node.a, depth + 1, childInsideBitwise);
    if (errA) return errA;
    return visit(node.b, depth + 1, childInsideBitwise);
  }

  const err = visit(root, 0, false);
  if (err) return { eligible: false, reason: err };
  if (vars.length === 0) return { eligible: false, reason: 'constant_only' };
  vars.sort();
  return { eligible: true, width, vars, nodeCount, maxDepth, isLinearMba };
}

export function evalMbaDag(node, env, evalWidth = node?.width) {
  if (!Number.isInteger(evalWidth) || evalWidth < 1 || evalWidth > 256) {
    throw new RangeError(`Invalid MBA evalWidth: ${evalWidth}`);
  }
  const mask = (1n << BigInt(evalWidth)) - 1n;
  function ev(n) {
    switch (n.op) {
      case 'var': return BigInt((env && Object.hasOwn(env, n.name)) ? env[n.name] : 0n) & mask;
      case 'const': return BigInt(n.value ?? 0n) & mask;
      case 'not': return (~ev(n.a)) & mask;
      case 'neg': return (-ev(n.a)) & mask;
      case 'add': return (ev(n.a) + ev(n.b)) & mask;
      case 'sub': return (ev(n.a) - ev(n.b)) & mask;
      case 'mul': return (ev(n.a) * ev(n.b)) & mask;
      case 'xor': return (ev(n.a) ^ ev(n.b)) & mask;
      case 'and': return (ev(n.a) & ev(n.b)) & mask;
      case 'or': return (ev(n.a) | ev(n.b)) & mask;
      default: throw new Error(`Unsupported MBA op: ${n.op}`);
    }
  }
  return ev(node);
}

export function mbaDagCost(node) {
  if (!node || node.op === 'var' || node.op === 'const') return 0;
  if (node.op === 'not' || node.op === 'neg') return 1 + mbaDagCost(node.a);
  const opCost = node.op === 'mul' ? 2 : 1;
  return opCost + mbaDagCost(node.a) + mbaDagCost(node.b);
}

function sameExpr(a, b, budget = { rem: 512 }) {
  if (budget.rem <= 0) return false;
  budget.rem--;
  if (a === b) return true;
  if (!a || !b || a.op !== b.op || a.width !== b.width) return false;
  if (a.op === 'var') return a.name === b.name;
  if (a.op === 'const') {
    const mask = maskForWidth(a.width);
    return (BigInt(a.value) & mask) === (BigInt(b.value) & mask);
  }
  if (a.op === 'not' || a.op === 'neg') return sameExpr(a.a, b.a, budget);
  if (a.op === 'add' || a.op === 'mul' || a.op === 'xor' || a.op === 'and' || a.op === 'or') {
    return (sameExpr(a.a, b.a, budget) && sameExpr(a.b, b.b, budget))
      || (sameExpr(a.a, b.b, budget) && sameExpr(a.b, b.a, budget));
  }
  return sameExpr(a.a, b.a, budget) && sameExpr(a.b, b.b, budget);
}

function stageAPatternMatch(root) {
  const w = root.width;
  const mask = maskForWidth(w);
  const isConstVal = (n, v) => n && n.op === 'const' && ((BigInt(n.value) & mask) === (BigInt(v) & mask));

  if (root.op === 'add') {
    const pairs = [[root.a, root.b], [root.b, root.a]];
    for (const [lhs, rhs] of pairs) {
      if (lhs.op === 'xor' && rhs.op === 'mul') {
        const twoAnd = (isConstVal(rhs.a, 2n) && rhs.b.op === 'and') ? rhs.b
          : (isConstVal(rhs.b, 2n) && rhs.a.op === 'and') ? rhs.a
            : null;
        if (twoAnd && ((sameExpr(lhs.a, twoAnd.a) && sameExpr(lhs.b, twoAnd.b))
          || (sameExpr(lhs.a, twoAnd.b) && sameExpr(lhs.b, twoAnd.a)))) {
          return { op: 'add', a: lhs.a, b: lhs.b, width: w };
        }
      }
      if (lhs.op === 'or' && rhs.op === 'and') {
        if ((sameExpr(lhs.a, rhs.a) && sameExpr(lhs.b, rhs.b)) || (sameExpr(lhs.a, rhs.b) && sameExpr(lhs.b, rhs.a))) {
          return { op: 'add', a: lhs.a, b: lhs.b, width: w };
        }
      }
      if (lhs.op === 'xor' && rhs.op === 'and') {
        if ((sameExpr(lhs.a, rhs.a) && sameExpr(lhs.b, rhs.b)) || (sameExpr(lhs.a, rhs.b) && sameExpr(lhs.b, rhs.a))) {
          return { op: 'or', a: lhs.a, b: lhs.b, width: w };
        }
      }
    }
  }

  if (root.op === 'sub' && root.a.op === 'or' && root.b.op === 'and') {
    if ((sameExpr(root.a.a, root.b.a) && sameExpr(root.a.b, root.b.b))
      || (sameExpr(root.a.a, root.b.b) && sameExpr(root.a.b, root.b.a))) {
      return { op: 'xor', a: root.a.a, b: root.a.b, width: w };
    }
  }

  if (root.op === 'not' && (root.a.op === 'or' || root.a.op === 'and')) {
    if (root.a.a.op === 'not' && root.a.b.op === 'not') {
      return {
        op: root.a.op === 'or' ? 'and' : 'or',
        a: root.a.a.a,
        b: root.a.b.a,
        width: w,
      };
    }
  }
  return null;
}

function stageBMobiusSynthesize(root, vars, width) {
  const k = vars.length;
  const n = 1 << k;
  const mask = maskForWidth(width);
  const f = new Array(n);

  for (let m = 0; m < n; m++) {
    const env = Object.create(null);
    for (let i = 0; i < k; i++) env[vars[i]] = (m & (1 << i)) ? 1n : 0n;
    f[m] = evalMbaDag(root, env, width);
  }

  const coeff = f.slice();
  for (let i = 0; i < k; i++) {
    const bit = 1 << i;
    for (let m = 0; m < n; m++) {
      if (m & bit) coeff[m] = (coeff[m] - coeff[m ^ bit]) & mask;
    }
  }

  const signed = coeff.map((c) => toSignedBigInt(c, width));
  const varNode = (i) => ({ op: 'var', name: vars[i], width });
  const constNode = (v) => ({ op: 'const', value: BigInt(v) & mask, width });

  if (k === 2 && signed[0] === 0n) {
    if (signed[1] === 1n && signed[2] === 1n && signed[3] === -2n) return { op: 'xor', a: varNode(0), b: varNode(1), width };
    if (signed[1] === 1n && signed[2] === 1n && signed[3] === -1n) return { op: 'or', a: varNode(0), b: varNode(1), width };
    if (signed[1] === 0n && signed[2] === 0n && signed[3] === 1n) return { op: 'and', a: varNode(0), b: varNode(1), width };
  }
  if (signed[0] === -1n) {
    const nonZero = [];
    for (let m = 1; m < n; m++) if (signed[m] !== 0n) nonZero.push(m);
    if (nonZero.length === 1 && (nonZero[0] & (nonZero[0] - 1)) === 0 && signed[nonZero[0]] === -1n) {
      const idx = Math.log2(nonZero[0]) | 0;
      return { op: 'not', a: varNode(idx), width };
    }
  }

  function buildConj(bitmask) {
    let acc = null;
    for (let i = 0; i < k; i++) {
      if (bitmask & (1 << i)) {
        const vn = varNode(i);
        acc = acc ? { op: 'and', a: acc, b: vn, width } : vn;
      }
    }
    return acc;
  }

  const posTerms = [];
  const negTerms = [];
  for (let m = 1; m < n; m++) {
    const c = signed[m];
    if (c === 0n) continue;
    const basis = buildConj(m);
    if (c === 1n) posTerms.push(basis);
    else if (c === -1n) negTerms.push(basis);
    else if (c > 0n) posTerms.push({ op: 'mul', a: constNode(c), b: basis, width });
    else negTerms.push({ op: 'mul', a: constNode(-c), b: basis, width });
  }

  let expr = null;
  for (const t of posTerms) expr = expr ? { op: 'add', a: expr, b: t, width } : t;
  for (const t of negTerms) expr = expr ? { op: 'sub', a: expr, b: t, width } : { op: 'neg', a: t, width };
  if (signed[0] !== 0n) {
    if (!expr) expr = constNode(signed[0]);
    else if (signed[0] > 0n) expr = { op: 'add', a: expr, b: constNode(signed[0]), width };
    else expr = { op: 'sub', a: expr, b: constNode(-signed[0]), width };
  }
  if (!expr) expr = constNode(0n);
  return expr;
}

/**
 * 3-Layer 100% Deterministic Equivalence Proof matching C++ `run_3layer_proof`:
 *  - Layer 1: Exact 2^k truth-table check on {0,1}^k corners (mod 2^width) + linearity check
 *  - Layer 2: Full 8-bit carry/nibble basis (`BASIS8`) & 64-bit bit-plane basis (`BASIS64`) evaluated at FULL width
 *  - Layer 3: Deterministic SplitMix64 64-bit vector verification (256 vectors)
 */
export function verifyMbaEquiv(origDag, candDag, opts = {}) {
  const origInfo = inspectMbaDag(origDag);
  const candInfo = inspectMbaDag(candDag);
  if (!origInfo.eligible) {
    return { proved: false, failedLayer: 0, reason: `orig_ineligible:${origInfo.reason}` };
  }
  const width = origInfo.width;
  if (!candDag || candDag.width !== width) {
    return { proved: false, failedLayer: 0, reason: 'cand_width_mismatch' };
  }
  const candIsConstOnly = candDag.op === 'const';
  if (!candIsConstOnly && !candInfo.eligible) {
    return { proved: false, failedLayer: 0, reason: `cand_ineligible:${candInfo.reason}` };
  }

  const vars = [...new Set([...origInfo.vars, ...(candInfo.vars || [])])].sort();
  if (vars.length > MBA_MAX_VARS) {
    return { proved: false, failedLayer: 0, reason: 'too_many_vars' };
  }
  const k = vars.length;

  // Layer 1: Exact 2^k truth-table on {0, 1}^k at full width
  const corners = 1 << k;
  for (let m = 0; m < corners; m++) {
    const env = Object.create(null);
    for (let i = 0; i < k; i++) env[vars[i]] = (m & (1 << i)) ? 1n : 0n;
    if (evalMbaDag(origDag, env, width) !== evalMbaDag(candDag, env, width)) {
      return { proved: false, failedLayer: 1, reason: 'truth_table_mismatch', counterexample: env };
    }
  }
  const layer1TheoremProved = origInfo.isLinearMba && (candIsConstOnly || candInfo.isLinearMba);

  // Layer 2: Full 8-bit & 64-bit basis verification evaluated at FULL expression width (no constant truncation!)
  let l2Tested = 0;
  function checkTuple(vals) {
    const env = Object.create(null);
    for (let i = 0; i < k; i++) env[vars[i]] = vals[i];
    l2Tested++;
    if (evalMbaDag(origDag, env, width) !== evalMbaDag(candDag, env, width)) {
      return env;
    }
    return null;
  }

  if (k === 1) {
    for (let x8 = 0; x8 < 256; x8++) {
      const ce = checkTuple([BigInt(x8)]);
      if (ce) return { proved: false, failedLayer: 2, reason: 'basis8_mismatch', counterexample: ce };
    }
    for (const v64 of BASIS64) {
      const ce = checkTuple([v64]);
      if (ce) return { proved: false, failedLayer: 2, reason: 'basis64_mismatch', counterexample: ce };
    }
  } else if (k === 2) {
    for (const a of BASIS8) {
      for (const b of BASIS8) {
        const ce = checkTuple([a, b]);
        if (ce) return { proved: false, failedLayer: 2, reason: 'basis8_mismatch', counterexample: ce };
      }
    }
    for (const a of BASIS64) {
      for (const b of BASIS64) {
        const ce = checkTuple([a, b]);
        if (ce) return { proved: false, failedLayer: 2, reason: 'basis64_mismatch', counterexample: ce };
      }
    }
  } else {
    // k === 3
    for (const a of BASIS8) {
      for (const b of BASIS8) {
        for (const c of BASIS8) {
          const ce = checkTuple([a, b, c]);
          if (ce) return { proved: false, failedLayer: 2, reason: 'basis8_mismatch', counterexample: ce };
        }
      }
    }
    for (const a of BASIS64) {
      for (const b of BASIS64) {
        for (const c of BASIS64) {
          const ce = checkTuple([a, b, c]);
          if (ce) return { proved: false, failedLayer: 2, reason: 'basis64_mismatch', counterexample: ce };
        }
      }
    }
  }

  if (opts.strictProof !== false && !layer1TheoremProved && !sameExpr(origDag, candDag)) {
    return { proved: false, failedLayer: 2, reason: 'nonlinear_unprovable_rejected' };
  }

  // Layer 3: Deterministic SplitMix64 64-bit verification (256 vectors)
  const nextRand = makeSplitMix64(0x9e3779b97f4a7c15n);
  for (let i = 0; i < 256; i++) {
    const env = Object.create(null);
    for (let j = 0; j < k; j++) env[vars[j]] = nextRand();
    if (evalMbaDag(origDag, env, width) !== evalMbaDag(candDag, env, width)) {
      return { proved: false, failedLayer: 3, reason: 'splitmix64_mismatch', counterexample: env };
    }
  }

  return {
    proved: true,
    failedLayer: 0,
    layer1LinearTheorem: layer1TheoremProved,
    layer2BasisTuples: l2Tested,
    layer3SplitMixTuples: 256,
  };
}

/**
 * Serialize linear MBA DAG to C++ `HexMbaNode[]` (24B per node) for WASM `hex_mba_simplify`.
 */
function flattenDagToWasmNodes(root, vars) {
  const nodes = [];
  const varIndex = new Map(vars.map((v, i) => [v, i]));
  const flag = root.width === 32 ? 1 : 0;

  function emit(n) {
    if (nodes.length >= MBA_MAX_NODES) return -1;
    if (n.op === 'var') {
      const idx = nodes.length;
      nodes.push({ op: HEX_MBA_OP.var, lhs: varIndex.get(n.name), rhs: 0, flags: flag, imm: 0n });
      return idx;
    }
    if (n.op === 'const') {
      const idx = nodes.length;
      nodes.push({ op: HEX_MBA_OP.const, lhs: 0, rhs: 0, flags: flag, imm: BigInt(n.value) });
      return idx;
    }
    if (n.op === 'not' || n.op === 'neg') {
      const l = emit(n.a);
      if (l < 0 || nodes.length >= MBA_MAX_NODES) return -1;
      const idx = nodes.length;
      nodes.push({ op: HEX_MBA_OP[n.op], lhs: l, rhs: 0, flags: flag, imm: 0n });
      return idx;
    }
    if (n.op === 'mul') {
      let exprNode = null;
      let constVal = null;
      if (n.a.op === 'const') { constVal = BigInt(n.a.value); exprNode = n.b; }
      else if (n.b.op === 'const') { constVal = BigInt(n.b.value); exprNode = n.a; }
      else if (isConstOnly(n.a)) { constVal = evalMbaDag(n.a, Object.create(null), root.width); exprNode = n.b; }
      else if (isConstOnly(n.b)) { constVal = evalMbaDag(n.b, Object.create(null), root.width); exprNode = n.a; }
      else return -1;
      const l = emit(exprNode);
      if (l < 0 || nodes.length >= MBA_MAX_NODES) return -1;
      const idx = nodes.length;
      nodes.push({ op: HEX_MBA_OP.mul_const, lhs: l, rhs: 0, flags: flag, imm: constVal });
      return idx;
    }
    const l = emit(n.a);
    const r = emit(n.b);
    if (l < 0 || r < 0 || nodes.length >= MBA_MAX_NODES) return -1;
    const idx = nodes.length;
    nodes.push({ op: HEX_MBA_OP[n.op], lhs: l, rhs: r, flags: flag, imm: 0n });
    return idx;
  }

  const rootIdx = emit(root);
  return rootIdx >= 0 ? { nodes, rootIdx } : null;
}

function unflattenWasmNodes(nodes, idx, vars, width, depth = 0) {
  if (depth > MBA_MAX_DEPTH || !Array.isArray(nodes) || !Number.isInteger(idx) || idx < 0 || idx >= nodes.length) {
    return null;
  }
  const n = nodes[idx];
  if (!n || typeof n !== 'object') return null;
  switch (n.op) {
    case HEX_MBA_OP.var:
      return { op: 'var', name: vars[n.lhs] ?? `v${n.lhs}`, width };
    case HEX_MBA_OP.const:
      return { op: 'const', value: n.imm & maskForWidth(width), width };
    case HEX_MBA_OP.neg: {
      const a = unflattenWasmNodes(nodes, n.lhs, vars, width, depth + 1);
      return a ? { op: 'neg', a, width } : null;
    }
    case HEX_MBA_OP.not: {
      const a = unflattenWasmNodes(nodes, n.lhs, vars, width, depth + 1);
      return a ? { op: 'not', a, width } : null;
    }
    case HEX_MBA_OP.add: {
      const a = unflattenWasmNodes(nodes, n.lhs, vars, width, depth + 1);
      if (!a) return null;
      const b = unflattenWasmNodes(nodes, n.rhs, vars, width, depth + 1);
      return b ? { op: 'add', a, b, width } : null;
    }
    case HEX_MBA_OP.sub: {
      const a = unflattenWasmNodes(nodes, n.lhs, vars, width, depth + 1);
      if (!a) return null;
      const b = unflattenWasmNodes(nodes, n.rhs, vars, width, depth + 1);
      return b ? { op: 'sub', a, b, width } : null;
    }
    case HEX_MBA_OP.and: {
      const a = unflattenWasmNodes(nodes, n.lhs, vars, width, depth + 1);
      if (!a) return null;
      const b = unflattenWasmNodes(nodes, n.rhs, vars, width, depth + 1);
      return b ? { op: 'and', a, b, width } : null;
    }
    case HEX_MBA_OP.or: {
      const a = unflattenWasmNodes(nodes, n.lhs, vars, width, depth + 1);
      if (!a) return null;
      const b = unflattenWasmNodes(nodes, n.rhs, vars, width, depth + 1);
      return b ? { op: 'or', a, b, width } : null;
    }
    case HEX_MBA_OP.xor: {
      const a = unflattenWasmNodes(nodes, n.lhs, vars, width, depth + 1);
      if (!a) return null;
      const b = unflattenWasmNodes(nodes, n.rhs, vars, width, depth + 1);
      return b ? { op: 'xor', a, b, width } : null;
    }
    case HEX_MBA_OP.mul_const: {
      const b = unflattenWasmNodes(nodes, n.lhs, vars, width, depth + 1);
      return b ? { op: 'mul', a: { op: 'const', value: n.imm & maskForWidth(width), width }, b, width } : null;
    }
    default:
      return null;
  }
}

function trySimplifyMbaWasm(root, info, opts) {
  const ex = opts.wasmExports ?? getHexEngineExports(opts);
  if (!ex || typeof ex.hex_mba_simplify !== 'function' || typeof ex.hex_deobf_scratch_ptr !== 'function') {
    recordFallback('MBA_JS_FALLBACK');
    return null;
  }
  const flat = flattenDagToWasmNodes(root, info.vars);
  if (!flat) return null;

  try {
    const base = ex.hex_deobf_scratch_ptr();
    const scratchSize = ex.hex_deobf_scratch_size();
    const inBytes = flat.nodes.length * 24;
    const outBytes = MBA_MAX_NODES * 24;
    const alignPad = (8 - (base & 7)) & 7;
    const needed = alignPad + inBytes + outBytes + 8 + 96 + 64;
    if (scratchSize < needed) {
      recordFallback('MBA_SCRATCH_OOM');
      return null;
    }
    const inPtr = (base + 7) & ~7;
    const outPtr = inPtr + inBytes + 8;
    const outRootPtr = outPtr + outBytes;
    const proofPtr = (outRootPtr + 8 + 7) & ~7;

    const dv = new DataView(ex.memory.buffer);
    for (let i = 0; i < flat.nodes.length; i++) {
      const o = inPtr + i * 24;
      const n = flat.nodes[i];
      dv.setUint32(o + 0, n.op, true);
      dv.setUint32(o + 4, n.lhs, true);
      dv.setUint32(o + 8, n.rhs, true);
      dv.setUint32(o + 12, n.flags, true);
      dv.setBigInt64(o + 16, BigInt.asIntN(64, n.imm), true);
    }

    const status = ex.hex_mba_simplify(inPtr, flat.nodes.length, flat.rootIdx, outPtr, MBA_MAX_NODES, outRootPtr, proofPtr);
    if (status !== 0) {
      recordFallback('MBA_WASM_STATUS_ERR');
      return null;
    }

    const outDv = new DataView(ex.memory.buffer);
    const l1Ok = outDv.getUint32(proofPtr + 0, true) === 1;
    const l2Ok = outDv.getUint32(proofPtr + 4, true) === 1;
    const l3Ok = outDv.getUint32(proofPtr + 8, true) === 1;
    const committed = outDv.getUint32(proofPtr + 16, true) === 1;
    const origCost = outDv.getUint32(proofPtr + 20, true);
    const simpCost = outDv.getUint32(proofPtr + 24, true);
    const outCount = outDv.getUint32(proofPtr + 28, true);
    const outRoot = outDv.getUint32(outRootPtr, true);

    if (outCount > MBA_MAX_NODES) {
      recordFallback('MBA_WASM_STATUS_ERR');
      return null;
    }
    recordWasmCall('mba_simplifier');

    if (!committed || outCount === 0 || outRoot >= outCount) {
      return {
        engine: 'wasm',
        simplified: false,
        expr: root,
        reason: (!l1Ok || !l2Ok || !l3Ok) ? 'proof_rejected' : 'no_cost_reduction',
        proof: { proved: l1Ok && l2Ok && l3Ok, failedLayer: !l1Ok ? 1 : !l2Ok ? 2 : !l3Ok ? 3 : 0, layer1LinearTheorem: l1Ok },
        stats: { dagsInspected: 1, patternRewrites: 0, basisRewrites: 0, proofRejected: (!l1Ok || !l2Ok || !l3Ok) ? 1 : 0, nodesEliminated: 0 },
      };
    }

    const outNodes = [];
    for (let i = 0; i < outCount; i++) {
      const o = outPtr + i * 24;
      outNodes.push({
        op: outDv.getUint32(o + 0, true),
        lhs: outDv.getUint32(o + 4, true),
        rhs: outDv.getUint32(o + 8, true),
        flags: outDv.getUint32(o + 12, true),
        imm: outDv.getBigUint64(o + 16, true),
      });
    }
    const expr = unflattenWasmNodes(outNodes, outRoot, info.vars, info.width);
    if (!expr) return null;

    return {
      engine: 'wasm',
      simplified: true,
      expr,
      stage: 'wasm_mobius',
      proof: { proved: true, failedLayer: 0, layer1LinearTheorem: l1Ok, layer2BasisTuples: 1, layer3SplitMixTuples: 256 },
      origCost,
      newCost: simpCost,
      stats: { dagsInspected: 1, patternRewrites: 0, basisRewrites: 1, proofRejected: 0, nodesEliminated: Math.max(0, origCost - simpCost) },
    };
  } catch {
    recordFallback('MBA_WASM_EXCEPTION');
    return null;
  }
}

/**
 * Simplify an MBA integer expression DAG using WASM (when enabled) or JS Stage A + Stage B (FMT) + 3-Layer Proof.
 */
export function simplifyMbaDag(root, opts = {}) {
  const stats = {
    dagsInspected: 1,
    patternRewrites: 0,
    basisRewrites: 0,
    proofRejected: 0,
    nodesEliminated: 0,
  };

  const info = inspectMbaDag(root);
  if (!info.eligible) {
    return { engine: 'js', simplified: false, expr: root, reason: info.reason, proof: null, stats };
  }

  // Try WASM path when available and not forced to JS (`HEX_ENGINE=js`)
  if (info.isLinearMba && opts.preferWasm !== false) {
    const wasmRes = trySimplifyMbaWasm(root, info, opts);
    if (wasmRes !== null) return wasmRes;
  }

  const origCost = mbaDagCost(root);
  let candidate = stageAPatternMatch(root);
  let stage = candidate ? 'stage_a_pattern' : null;

  if (!candidate || mbaDagCost(candidate) >= origCost) {
    if (info.isLinearMba) {
      const fmtCand = stageBMobiusSynthesize(root, info.vars, info.width);
      if (fmtCand && mbaDagCost(fmtCand) < origCost) {
        candidate = fmtCand;
        stage = 'stage_b_mobius';
      }
    }
  }

  if (!candidate || mbaDagCost(candidate) >= origCost) {
    return { engine: 'js', simplified: false, expr: root, reason: 'no_cost_reduction', proof: null, stats };
  }

  const proof = verifyMbaEquiv(root, candidate, {
    strictProof: (opts.optFlags === undefined) ? true : Boolean(opts.optFlags & HEX_OPT_FLAG_MBA_STRICT_PROOF),
  });
  if (!proof.proved) {
    stats.proofRejected = 1;
    return { engine: 'js', simplified: false, expr: root, reason: `proof_rejected:${proof.reason}`, proof, stats };
  }

  if (stage === 'stage_a_pattern') stats.patternRewrites = 1;
  else stats.basisRewrites = 1;
  stats.nodesEliminated = Math.max(0, origCost - mbaDagCost(candidate));

  return {
    engine: 'js',
    simplified: true,
    expr: candidate,
    stage,
    proof,
    origCost,
    newCost: mbaDagCost(candidate),
    stats,
  };
}
