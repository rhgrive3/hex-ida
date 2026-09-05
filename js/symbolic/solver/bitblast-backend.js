/**
 * Exact, dependency-free QF_BV backend for browser and worker runtimes.
 *
 * Expressions are reduced to a Tseitin CNF with fixed-width bit blasting.
 * The bundled deterministic DPLL engine is a complete decision procedure: it
 * returns SAT/UNSAT only after a complete search, and reports a resource or
 * time limit otherwise. SAT witnesses are independently checked with Hex's
 * evaluator before they cross the backend boundary.
 */

import {
  EXPR_KIND,
  SORT_KIND,
  BV_UNARY_OP,
  BV_BINARY_OP,
  BV_COMPARE_OP,
  BOOL_CONNECTIVE_OP,
  CAST_OP,
} from '../expr/kinds.js';
import { validateSatModel } from '../verify/validate-model.js';
import { validateVerificationQuery } from '../verify/query.js';
import { PROOF_AUTHORITY, SolverBackend } from './backend.js';
import { collectSymbols } from './exhaustive-backend.js';
import { effectivePositiveSafeInteger, requirePositiveSafeInteger } from './limits.js';
import { validateExactModelBindings } from './model-boundary.js';
import { SOLVER_STATUS, createSolverResult } from './result.js';
import { SolverSession } from './session.js';

export const BITBLAST_BACKEND_ID = 'hex-bitblast-qfbv';
export const BITBLAST_BACKEND_VERSION = '1.0.0';

const DEFAULT_LIMITS = Object.freeze({
  maxBvWidth: 64,
  maxConstraints: 4096,
  maxExprNodes: 100000,
  maxExprDepth: 1024,
  maxVariables: 400000,
  maxClauses: 1600000,
  maxDecisions: 500000,
  maxPropagations: 8000000,
  yieldEvery: 8192,
});

class LimitError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'LimitError';
    this.reason = reason;
  }
}

function deadlineFrom(options) {
  const timeoutMs = Number(options.timeoutMs);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
}

class CnfBuilder {
  constructor(limits, signal, deadline) {
    this.limits = limits;
    this.signal = signal;
    this.deadline = deadline;
    this.variableCount = 0;
    this.clauses = [];
    this.expressionMemo = new WeakMap();
    this.symbolBits = new Map();
    this.gateMemo = new Map();
    this.trueLiteral = this.newVariable();
    this.addClause([this.trueLiteral]);
  }

  guard() {
    if (this.signal?.aborted) throw new LimitError('cancelled');
    if (Date.now() >= this.deadline) throw new LimitError('timeout');
  }

  newVariable() {
    this.guard();
    this.variableCount++;
    if (this.variableCount > this.limits.maxVariables) throw new LimitError('cnf-variable-budget-exceeded');
    return this.variableCount;
  }

  addClause(literals) {
    this.guard();
    const unique = [];
    const seen = new Set();
    for (const literal of literals) {
      if (seen.has(-literal)) return;
      if (!seen.has(literal)) {
        seen.add(literal);
        unique.push(literal);
      }
    }
    this.clauses.push(unique);
    if (this.clauses.length > this.limits.maxClauses) throw new LimitError('cnf-clause-budget-exceeded');
  }

  constant(value) { return value ? this.trueLiteral : -this.trueLiteral; }

  memoGate(kind, inputs, build) {
    const keyInputs = (kind === 'and' || kind === 'or' || kind === 'xor')
      ? [...inputs].sort((a, b) => a - b)
      : inputs;
    const key = `${kind}:${keyInputs.join(',')}`;
    if (this.gateMemo.has(key)) return this.gateMemo.get(key);
    const output = build();
    this.gateMemo.set(key, output);
    return output;
  }

  and(a, b) {
    if (a === b) return a;
    if (a === -b) return this.constant(false);
    if (a === this.trueLiteral) return b;
    if (b === this.trueLiteral) return a;
    if (a === -this.trueLiteral || b === -this.trueLiteral) return this.constant(false);
    return this.memoGate('and', [a, b], () => {
      const out = this.newVariable();
      this.addClause([-out, a]);
      this.addClause([-out, b]);
      this.addClause([out, -a, -b]);
      return out;
    });
  }

  or(a, b) {
    if (a === b) return a;
    if (a === -b) return this.constant(true);
    if (a === -this.trueLiteral) return b;
    if (b === -this.trueLiteral) return a;
    if (a === this.trueLiteral || b === this.trueLiteral) return this.constant(true);
    return this.memoGate('or', [a, b], () => {
      const out = this.newVariable();
      this.addClause([out, -a]);
      this.addClause([out, -b]);
      this.addClause([-out, a, b]);
      return out;
    });
  }

  xor(a, b) {
    if (a === b) return this.constant(false);
    if (a === -b) return this.constant(true);
    if (a === -this.trueLiteral) return b;
    if (b === -this.trueLiteral) return a;
    if (a === this.trueLiteral) return -b;
    if (b === this.trueLiteral) return -a;
    return this.memoGate('xor', [a, b], () => {
      const out = this.newVariable();
      this.addClause([-a, -b, -out]);
      this.addClause([a, b, -out]);
      this.addClause([a, -b, out]);
      this.addClause([-a, b, out]);
      return out;
    });
  }

  ite(condition, thenLiteral, elseLiteral) {
    if (thenLiteral === elseLiteral) return thenLiteral;
    if (condition === this.trueLiteral) return thenLiteral;
    if (condition === -this.trueLiteral) return elseLiteral;
    if (thenLiteral === this.trueLiteral && elseLiteral === -this.trueLiteral) return condition;
    if (thenLiteral === -this.trueLiteral && elseLiteral === this.trueLiteral) return -condition;
    return this.memoGate('ite', [condition, thenLiteral, elseLiteral], () => {
      const out = this.newVariable();
      this.addClause([-condition, -thenLiteral, out]);
      this.addClause([-condition, thenLiteral, -out]);
      this.addClause([condition, -elseLiteral, out]);
      this.addClause([condition, elseLiteral, -out]);
      return out;
    });
  }

  reduceAnd(literals) {
    return literals.reduce((acc, literal) => this.and(acc, literal), this.constant(true));
  }

  reduceOr(literals) {
    return literals.reduce((acc, literal) => this.or(acc, literal), this.constant(false));
  }

  constantBits(width, value) {
    const normalized = BigInt.asUintN(width, BigInt(value));
    return Array.from({ length: width }, (_, bit) => this.constant(((normalized >> BigInt(bit)) & 1n) === 1n));
  }

  muxBits(condition, thenBits, elseBits) {
    return thenBits.map((literal, index) => this.ite(condition, literal, elseBits[index]));
  }

  addBits(left, right, carryIn = this.constant(false)) {
    let carry = carryIn;
    const output = [];
    for (let bit = 0; bit < left.length; bit++) {
      const leftXorRight = this.xor(left[bit], right[bit]);
      output.push(this.xor(leftXorRight, carry));
      carry = this.or(this.and(left[bit], right[bit]), this.and(carry, leftXorRight));
    }
    return output;
  }

  negateBits(bits) {
    return this.addBits(bits.map((literal) => -literal), this.constantBits(bits.length, 0n), this.constant(true));
  }

  subtractBits(left, right) {
    return this.addBits(left, right.map((literal) => -literal), this.constant(true));
  }

  equalBits(left, right) {
    return this.reduceAnd(left.map((literal, index) => -this.xor(literal, right[index])));
  }

  unsignedLess(left, right) {
    let equalPrefix = this.constant(true);
    let less = this.constant(false);
    for (let bit = left.length - 1; bit >= 0; bit--) {
      less = this.or(less, this.and(equalPrefix, this.and(-left[bit], right[bit])));
      equalPrefix = this.and(equalPrefix, -this.xor(left[bit], right[bit]));
    }
    return less;
  }

  signedLess(left, right) {
    const leftSign = left[left.length - 1];
    const rightSign = right[right.length - 1];
    const signsDiffer = this.xor(leftSign, rightSign);
    return this.ite(signsDiffer, leftSign, this.unsignedLess(left, right));
  }

  multiplyBits(left, right) {
    let result = this.constantBits(left.length, 0n);
    for (let shift = 0; shift < left.length; shift++) {
      const row = Array.from({ length: left.length }, (_, bit) =>
        bit < shift ? this.constant(false) : this.and(left[bit - shift], right[shift]));
      result = this.addBits(result, row);
    }
    return result;
  }

  unsignedDivideRemainder(dividend, divisor) {
    const width = dividend.length;
    let remainder = this.constantBits(width, 0n);
    const quotient = this.constantBits(width, 0n);
    for (let bit = width - 1; bit >= 0; bit--) {
      const shifted = [dividend[bit], ...remainder.slice(0, width - 1)];
      const take = -this.unsignedLess(shifted, divisor);
      const difference = this.subtractBits(shifted, divisor);
      remainder = this.muxBits(take, difference, shifted);
      quotient[bit] = take;
    }
    const divisorIsZero = this.equalBits(divisor, this.constantBits(width, 0n));
    return {
      quotient: this.muxBits(divisorIsZero, this.constantBits(width, -1n), quotient),
      remainder: this.muxBits(divisorIsZero, dividend, remainder),
    };
  }

  signedDivideRemainder(dividend, divisor) {
    const width = dividend.length;
    const dividendSign = dividend[width - 1];
    const divisorSign = divisor[width - 1];
    const absDividend = this.muxBits(dividendSign, this.negateBits(dividend), dividend);
    const absDivisor = this.muxBits(divisorSign, this.negateBits(divisor), divisor);
    const unsigned = this.unsignedDivideRemainder(absDividend, absDivisor);
    const signedQuotient = this.muxBits(
      this.xor(dividendSign, divisorSign),
      this.negateBits(unsigned.quotient),
      unsigned.quotient,
    );
    const signedRemainder = this.muxBits(dividendSign, this.negateBits(unsigned.remainder), unsigned.remainder);
    const divisorIsZero = this.equalBits(divisor, this.constantBits(width, 0n));
    const divisionByZero = this.muxBits(
      dividendSign,
      this.constantBits(width, 1n),
      this.constantBits(width, -1n),
    );
    return {
      quotient: this.muxBits(divisorIsZero, divisionByZero, signedQuotient),
      remainder: this.muxBits(divisorIsZero, dividend, signedRemainder),
    };
  }

  shiftBits(value, amount, operation) {
    const width = value.length;
    const stages = Math.ceil(Math.log2(width));
    let result = value;
    for (let stage = 0; stage < stages; stage++) {
      const distance = 2 ** stage;
      const shifted = Array.from({ length: width }, (_, bit) => {
        if (operation === BV_BINARY_OP.SHL) return bit >= distance ? result[bit - distance] : this.constant(false);
        if (operation === BV_BINARY_OP.LSHR) return bit + distance < width ? result[bit + distance] : this.constant(false);
        return bit + distance < width ? result[bit + distance] : result[width - 1];
      });
      result = this.muxBits(amount[stage], shifted, result);
    }
    const outOfRange = -this.unsignedLess(amount, this.constantBits(width, BigInt(width)));
    const saturated = operation === BV_BINARY_OP.ASHR
      ? Array.from({ length: width }, () => value[width - 1])
      : this.constantBits(width, 0n);
    return this.muxBits(outOfRange, saturated, result);
  }

  compile(expr) {
    if (this.expressionMemo.has(expr)) return this.expressionMemo.get(expr);
    let compiled;
    switch (expr.kind) {
      case EXPR_KIND.CONST:
        compiled = expr.sort.kind === SORT_KIND.BOOL
          ? { kind: SORT_KIND.BOOL, literal: this.constant(expr.value) }
          : { kind: SORT_KIND.BV, bits: this.constantBits(expr.sort.width, expr.value) };
        break;
      case EXPR_KIND.FRESH_SYMBOL: {
        const key = String(expr.symbolId || expr.name);
        if (!this.symbolBits.has(key)) {
          this.symbolBits.set(key, expr.sort.kind === SORT_KIND.BOOL
            ? { kind: SORT_KIND.BOOL, literal: this.newVariable() }
            : { kind: SORT_KIND.BV, bits: Array.from({ length: expr.sort.width }, () => this.newVariable()) });
        }
        compiled = this.symbolBits.get(key);
        break;
      }
      case EXPR_KIND.UNARY: {
        const arg = this.compile(expr.arg).bits;
        compiled = { kind: SORT_KIND.BV, bits: expr.op === BV_UNARY_OP.NOT ? arg.map((literal) => -literal) : this.negateBits(arg) };
        break;
      }
      case EXPR_KIND.BINARY: {
        const left = this.compile(expr.left).bits;
        const right = this.compile(expr.right).bits;
        let bits;
        switch (expr.op) {
          case BV_BINARY_OP.ADD: bits = this.addBits(left, right); break;
          case BV_BINARY_OP.SUB: bits = this.subtractBits(left, right); break;
          case BV_BINARY_OP.MUL: bits = this.multiplyBits(left, right); break;
          case BV_BINARY_OP.UDIV: bits = this.unsignedDivideRemainder(left, right).quotient; break;
          case BV_BINARY_OP.UREM: bits = this.unsignedDivideRemainder(left, right).remainder; break;
          case BV_BINARY_OP.SDIV: bits = this.signedDivideRemainder(left, right).quotient; break;
          case BV_BINARY_OP.SREM: bits = this.signedDivideRemainder(left, right).remainder; break;
          case BV_BINARY_OP.AND: bits = left.map((literal, bit) => this.and(literal, right[bit])); break;
          case BV_BINARY_OP.OR: bits = left.map((literal, bit) => this.or(literal, right[bit])); break;
          case BV_BINARY_OP.XOR: bits = left.map((literal, bit) => this.xor(literal, right[bit])); break;
          case BV_BINARY_OP.SHL:
          case BV_BINARY_OP.LSHR:
          case BV_BINARY_OP.ASHR: bits = this.shiftBits(left, right, expr.op); break;
          default: throw new LimitError(`unsupported-binary-op:${expr.op}`);
        }
        compiled = { kind: SORT_KIND.BV, bits };
        break;
      }
      case EXPR_KIND.COMPARE: {
        const left = this.compile(expr.left).bits;
        const right = this.compile(expr.right).bits;
        const eq = () => this.equalBits(left, right);
        const ult = () => this.unsignedLess(left, right);
        const slt = () => this.signedLess(left, right);
        let literal;
        switch (expr.op) {
          case BV_COMPARE_OP.EQ: literal = eq(); break;
          case BV_COMPARE_OP.NE: literal = -eq(); break;
          case BV_COMPARE_OP.ULT: literal = ult(); break;
          case BV_COMPARE_OP.ULE: literal = -this.unsignedLess(right, left); break;
          case BV_COMPARE_OP.UGT: literal = this.unsignedLess(right, left); break;
          case BV_COMPARE_OP.UGE: literal = -ult(); break;
          case BV_COMPARE_OP.SLT: literal = slt(); break;
          case BV_COMPARE_OP.SLE: literal = -this.signedLess(right, left); break;
          case BV_COMPARE_OP.SGT: literal = this.signedLess(right, left); break;
          case BV_COMPARE_OP.SGE: literal = -slt(); break;
          default: throw new LimitError(`unsupported-compare-op:${expr.op}`);
        }
        compiled = { kind: SORT_KIND.BOOL, literal };
        break;
      }
      case EXPR_KIND.CONNECTIVE: {
        const args = expr.args.map((arg) => this.compile(arg).literal);
        let literal;
        switch (expr.op) {
          case BOOL_CONNECTIVE_OP.AND: literal = this.reduceAnd(args); break;
          case BOOL_CONNECTIVE_OP.OR: literal = this.reduceOr(args); break;
          case BOOL_CONNECTIVE_OP.NOT: literal = -args[0]; break;
          case BOOL_CONNECTIVE_OP.XOR: literal = args.reduce((acc, arg) => this.xor(acc, arg), this.constant(false)); break;
          case BOOL_CONNECTIVE_OP.IMPLIES: literal = this.or(-args[0], args[1]); break;
          case BOOL_CONNECTIVE_OP.EQ: literal = -this.xor(args[0], args[1]); break;
          case BOOL_CONNECTIVE_OP.NE: literal = this.xor(args[0], args[1]); break;
          default: throw new LimitError(`unsupported-connective-op:${expr.op}`);
        }
        compiled = { kind: SORT_KIND.BOOL, literal };
        break;
      }
      case EXPR_KIND.ITE: {
        const condition = this.compile(expr.cond).literal;
        const thenValue = this.compile(expr.thenExpr);
        const elseValue = this.compile(expr.elseExpr);
        compiled = thenValue.kind === SORT_KIND.BOOL
          ? { kind: SORT_KIND.BOOL, literal: this.ite(condition, thenValue.literal, elseValue.literal) }
          : { kind: SORT_KIND.BV, bits: this.muxBits(condition, thenValue.bits, elseValue.bits) };
        break;
      }
      case EXPR_KIND.EXTRACT:
        compiled = { kind: SORT_KIND.BV, bits: this.compile(expr.arg).bits.slice(expr.low, expr.high + 1) };
        break;
      case EXPR_KIND.CONCAT: {
        const left = this.compile(expr.left).bits;
        const right = this.compile(expr.right).bits;
        compiled = { kind: SORT_KIND.BV, bits: [...right, ...left] };
        break;
      }
      case EXPR_KIND.CAST: {
        const arg = this.compile(expr.arg).bits;
        if (expr.op === CAST_OP.TRUNC) compiled = { kind: SORT_KIND.BV, bits: arg.slice(0, expr.targetWidth) };
        else {
          const fill = expr.op === CAST_OP.SEXT ? arg[arg.length - 1] : this.constant(false);
          compiled = { kind: SORT_KIND.BV, bits: [...arg, ...Array.from({ length: expr.targetWidth - arg.length }, () => fill)] };
        }
        break;
      }
      default:
        throw new LimitError(`unsupported-expression-kind:${expr.kind}`);
    }
    this.expressionMemo.set(expr, compiled);
    return compiled;
  }
}

function literalIndex(literal) {
  return literal > 0 ? literal * 2 : (-literal * 2) + 1;
}

function literalValue(literal, assignment) {
  const value = assignment[Math.abs(literal)];
  return value === 0 ? 0 : (literal > 0 ? value : -value);
}

async function solveCnf(builder, { signal, deadline, limits }) {
  const { clauses, variableCount } = builder;
  const assignment = new Int8Array(variableCount + 1);
  const watches = Array.from({ length: (variableCount + 1) * 2 + 2 }, () => []);
  const watchA = new Int32Array(clauses.length);
  const watchB = new Int32Array(clauses.length);
  const trail = [];
  let propagationHead = 0;
  let decisions = 0;
  let propagations = 0;
  let yieldedAt = 0;

  function enqueue(literal) {
    const variable = Math.abs(literal);
    const wanted = literal > 0 ? 1 : -1;
    if (assignment[variable] === wanted) return true;
    if (assignment[variable] === -wanted) return false;
    assignment[variable] = wanted;
    trail.push(literal);
    return true;
  }

  for (let index = 0; index < clauses.length; index++) {
    const clause = clauses[index];
    if (clause.length === 0) return { status: 'unsat', assignment, decisions, propagations };
    watchA[index] = 0;
    watchB[index] = clause.length > 1 ? 1 : 0;
    watches[literalIndex(clause[watchA[index]])].push(index);
    if (watchB[index] !== watchA[index]) watches[literalIndex(clause[watchB[index]])].push(index);
    if (clause.length === 1 && !enqueue(clause[0])) return { status: 'unsat', assignment, decisions, propagations };
  }

  async function guard() {
    if (signal?.aborted) return 'cancelled';
    if (Date.now() >= deadline) return 'timeout';
    if (decisions > limits.maxDecisions) return 'decision-budget-exceeded';
    if (propagations > limits.maxPropagations) return 'propagation-budget-exceeded';
    if (propagations - yieldedAt >= limits.yieldEvery) {
      yieldedAt = propagations;
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted) return 'cancelled';
      if (Date.now() >= deadline) return 'timeout';
    }
    return null;
  }

  async function propagate() {
    while (propagationHead < trail.length) {
      const guardResult = await guard();
      if (guardResult) return guardResult;
      const falseLiteral = -trail[propagationHead++];
      const list = watches[literalIndex(falseLiteral)];
      let position = 0;
      while (position < list.length) {
        const clauseIndex = list[position];
        const clause = clauses[clauseIndex];
        const falseWatchIsA = clause[watchA[clauseIndex]] === falseLiteral;
        const falseWatchPosition = falseWatchIsA ? watchA[clauseIndex] : watchB[clauseIndex];
        const otherWatchPosition = falseWatchIsA ? watchB[clauseIndex] : watchA[clauseIndex];
        const otherLiteral = clause[otherWatchPosition];
        if (literalValue(otherLiteral, assignment) === 1) {
          position++;
          continue;
        }
        let replacement = -1;
        for (let candidate = 0; candidate < clause.length; candidate++) {
          if (candidate === otherWatchPosition || candidate === falseWatchPosition) continue;
          if (literalValue(clause[candidate], assignment) !== -1) {
            replacement = candidate;
            break;
          }
        }
        propagations++;
        if (replacement >= 0) {
          if (falseWatchIsA) watchA[clauseIndex] = replacement;
          else watchB[clauseIndex] = replacement;
          list[position] = list[list.length - 1];
          list.pop();
          watches[literalIndex(clause[replacement])].push(clauseIndex);
          continue;
        }
        if (literalValue(otherLiteral, assignment) === -1) return 'conflict';
        if (!enqueue(otherLiteral)) return 'conflict';
        position++;
      }
    }
    return null;
  }

  function decisionLiteral() {
    for (const clause of clauses) {
      let satisfied = false;
      let candidate = 0;
      for (const literal of clause) {
        const value = literalValue(literal, assignment);
        if (value === 1) {
          satisfied = true;
          break;
        }
        if (value === 0 && candidate === 0) candidate = literal;
      }
      if (!satisfied && candidate !== 0) return candidate;
      if (!satisfied && candidate === 0) return null;
    }
    return 0;
  }

  function restore(mark) {
    while (trail.length > mark) assignment[Math.abs(trail.pop())] = 0;
    propagationHead = Math.min(propagationHead, mark);
  }

  async function search() {
    const propagation = await propagate();
    if (propagation === 'conflict') return 'unsat';
    if (propagation) return propagation;
    const literal = decisionLiteral();
    if (literal === null) return 'unsat';
    if (literal === 0) return 'sat';
    decisions++;
    const guardResult = await guard();
    if (guardResult) return guardResult;
    const mark = trail.length;
    for (const choice of [-Math.abs(literal), Math.abs(literal)]) {
      if (enqueue(choice)) {
        const result = await search();
        if (result === 'sat') return result;
        if (result !== 'unsat') return result;
      }
      restore(mark);
    }
    return 'unsat';
  }

  const status = await search();
  return { status, assignment, decisions, propagations };
}

function extractModel(symbols, builder, assignment) {
  const model = new Map();
  for (const symbol of symbols) {
    const compiled = builder.symbolBits.get(symbol.key);
    let value;
    if (symbol.sort.kind === SORT_KIND.BOOL) {
      value = literalValue(compiled.literal, assignment) === 1;
    } else {
      value = 0n;
      for (let bit = 0; bit < compiled.bits.length; bit++) {
        if (literalValue(compiled.bits[bit], assignment) === 1) value |= 1n << BigInt(bit);
      }
    }
    model.set(symbol.symbolId, value);
  }
  return model;
}

class BitBlastSolverSession extends SolverSession {
  async _executeCheck(query, options = {}, _token, signal) {
    const startedAt = Date.now();
    const resultBase = { backend: this.backend.id, backendVersion: this.backend.version, queryHash: query?.queryHash || null };
    let limits;
    try {
      limits = Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((name) => [
        name,
        effectivePositiveSafeInteger(options, name, this.options[name], this.backend[name]),
      ]));
    } catch (error) {
      return createSolverResult({ ...resultBase, queryHash: null, status: SOLVER_STATUS.INVALID_QUERY, reason: `invalid-budget:${error.message}`, lifecycle: { publishable: false } });
    }
    const queryValidation = validateVerificationQuery(query, { maxExprNodes: limits.maxExprNodes });
    if (!queryValidation.valid) {
      return createSolverResult({
        ...resultBase,
        queryHash: null,
        status: queryValidation.limitExceeded ? SOLVER_STATUS.RESOURCE_LIMIT : SOLVER_STATUS.INVALID_QUERY,
        reason: queryValidation.reason,
        lifecycle: { budgetExceeded: queryValidation.limitExceeded === true, publishable: false },
      });
    }
    const constraints = query.constraints;
    const expressions = [...constraints, ...(query.assertion ? [query.assertion] : [])];
    if (constraints.length > limits.maxConstraints) {
      return createSolverResult({ ...resultBase, status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'constraint-budget-exceeded', lifecycle: { budgetExceeded: true, publishable: false } });
    }
    const collected = collectSymbols(expressions, { maxExprNodes: limits.maxExprNodes, maxExprDepth: limits.maxExprDepth });
    if (collected.limitExceeded) {
      return createSolverResult({ ...resultBase, status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'expression-node-budget-exceeded', lifecycle: { budgetExceeded: true, publishable: false } });
    }
    if (collected.depthExceeded) {
      return createSolverResult({ ...resultBase, status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'expression-depth-budget-exceeded', lifecycle: { budgetExceeded: true, publishable: false } });
    }
    if (collected.unsupportedReason) {
      return createSolverResult({ ...resultBase, status: SOLVER_STATUS.UNSUPPORTED, reason: collected.unsupportedReason, lifecycle: { publishable: false } });
    }
    if (constraints.some((constraint) => constraint?.sort?.kind !== SORT_KIND.BOOL) ||
        (query.assertion && query.assertion.sort?.kind !== SORT_KIND.BOOL)) {
      return createSolverResult({ ...resultBase, status: SOLVER_STATUS.UNSUPPORTED, reason: 'non-boolean-query-predicate', lifecycle: { publishable: false } });
    }
    if (collected.maxBvWidth > limits.maxBvWidth) {
      return createSolverResult({ ...resultBase, status: SOLVER_STATUS.UNSUPPORTED, reason: `bitvector-width-exceeds-${limits.maxBvWidth}`, lifecycle: { publishable: false } });
    }

    const deadline = deadlineFrom(options);
    let builder;
    try {
      builder = new CnfBuilder(limits, signal, deadline);
      for (const predicate of expressions) builder.addClause([builder.compile(predicate).literal]);
    } catch (error) {
      if (!(error instanceof LimitError)) throw error;
      const status = error.reason === 'cancelled' ? SOLVER_STATUS.CANCELLED
        : error.reason === 'timeout' ? SOLVER_STATUS.TIMEOUT
          : error.reason.startsWith('unsupported-') ? SOLVER_STATUS.UNSUPPORTED
            : SOLVER_STATUS.RESOURCE_LIMIT;
      return createSolverResult({
        ...resultBase,
        status,
        reason: error.reason,
        stats: { solveTimeMs: Date.now() - startedAt },
        lifecycle: { cancelled: status === SOLVER_STATUS.CANCELLED, timedOut: status === SOLVER_STATUS.TIMEOUT, budgetExceeded: status === SOLVER_STATUS.RESOURCE_LIMIT, publishable: false },
      });
    }

    const solved = await solveCnf(builder, { signal, deadline, limits });
    const stats = {
      solveTimeMs: Date.now() - startedAt,
      nodesEvaluated: solved.decisions,
      cnfVariables: builder.variableCount,
      cnfClauses: builder.clauses.length,
      decisions: solved.decisions,
      propagations: solved.propagations,
      engine: 'tseitin-cnf+dpll',
    };
    if (solved.status === 'sat') {
      const model = extractModel(collected.symbols, builder, solved.assignment);
      const bindingValidation = validateExactModelBindings(collected.symbols, model);
      if (!bindingValidation.valid) {
        return createSolverResult({ ...resultBase, status: SOLVER_STATUS.PROVIDER_FAILURE, reason: `exact-model-binding-validation-failed:${bindingValidation.reason}`, stats, lifecycle: { publishable: false } });
      }
      const validation = validateSatModel(query, model);
      if (!validation.valid) {
        return createSolverResult({ ...resultBase, status: SOLVER_STATUS.PROVIDER_FAILURE, reason: `independent-model-validation-failed:${validation.reason}`, stats, lifecycle: { publishable: false } });
      }
      return createSolverResult({ ...resultBase, status: SOLVER_STATUS.SAT, model, stats });
    }
    if (solved.status === 'unsat') return createSolverResult({ ...resultBase, status: SOLVER_STATUS.UNSAT, stats });
    const status = solved.status === 'cancelled' ? SOLVER_STATUS.CANCELLED
      : solved.status === 'timeout' ? SOLVER_STATUS.TIMEOUT
        : SOLVER_STATUS.RESOURCE_LIMIT;
    return createSolverResult({
      ...resultBase,
      status,
      reason: solved.status,
      stats,
      lifecycle: { cancelled: status === SOLVER_STATUS.CANCELLED, timedOut: status === SOLVER_STATUS.TIMEOUT, budgetExceeded: status === SOLVER_STATUS.RESOURCE_LIMIT, publishable: false },
    });
  }
}

export class BitBlastBvBackend extends SolverBackend {
  constructor(options = {}) {
    super({
      id: options.id || BITBLAST_BACKEND_ID,
      version: options.version || BITBLAST_BACKEND_VERSION,
      proofAuthority: PROOF_AUTHORITY.EXACT,
      isRemote: false,
      isWasm: false,
      requiresCanonicalQueryIdentity: true,
    });
    for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
      this[key] = requirePositiveSafeInteger(
        Object.prototype.hasOwnProperty.call(options, key) ? options[key] : fallback,
        key,
      );
    }
  }

  baseCapabilities() {
    return {
      ...super.baseCapabilities(),
      supportedSorts: ['bool', 'bv'],
      supportedLogic: 'QF_BV',
      maxBvWidth: this.maxBvWidth,
      supportsIncremental: false,
      supportsCancellation: true,
      supportsModelExtraction: true,
      sessionReuseAfterTimeout: false,
      exactProofs: true,
      executionIsolation: 'caller-selected',
      memoryBudgetClass: 'measured-only',
      algorithm: 'bitblast-tseitin-dpll',
      maxConstraints: this.maxConstraints,
      maxExprNodes: this.maxExprNodes,
      maxExprDepth: this.maxExprDepth,
      maxVariables: this.maxVariables,
      maxClauses: this.maxClauses,
      maxDecisions: this.maxDecisions,
      maxPropagations: this.maxPropagations,
    };
  }

  createSession(options = {}) {
    return new BitBlastSolverSession(this, {
      ...Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((key) => [key, this[key]])),
      ...options,
    });
  }
}
