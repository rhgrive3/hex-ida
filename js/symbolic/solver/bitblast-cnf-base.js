import { BV_BINARY_OP } from '../expr/kinds.js';

export class LimitError extends Error {
  constructor(reason) { super(reason); this.name = 'LimitError'; this.reason = reason; }
}

export function monotonicNow() {
  return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
}

export function deadlineFrom(options) {
  const timeoutMs = options?.timeoutMs;
  return typeof timeoutMs === 'number' && Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? monotonicNow() + timeoutMs
    : Infinity;
}

export class CnfBuilderBase {
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
    if (monotonicNow() >= this.deadline) throw new LimitError('timeout');
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
      if (!Number.isSafeInteger(literal) || literal === 0) throw new LimitError('invalid-cnf-literal');
      if (seen.has(-literal)) return;
      if (!seen.has(literal)) { seen.add(literal); unique.push(literal); }
    }
    this.clauses.push(unique);
    if (this.clauses.length > this.limits.maxClauses) throw new LimitError('cnf-clause-budget-exceeded');
  }

  constant(value) { return value ? this.trueLiteral : -this.trueLiteral; }

  memoGate(kind, inputs, build) {
    const normalized = ['and', 'or', 'xor'].includes(kind) ? [...inputs].sort((a, b) => a - b) : inputs;
    const key = `${kind}:${normalized.join(',')}`;
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
      this.addClause([-out, a]); this.addClause([-out, b]); this.addClause([out, -a, -b]);
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
      this.addClause([out, -a]); this.addClause([out, -b]); this.addClause([-out, a, b]);
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
      this.addClause([-a, -b, -out]); this.addClause([a, b, -out]);
      this.addClause([a, -b, out]); this.addClause([-a, b, out]);
      return out;
    });
  }

  ite(c, t, e) {
    if (t === e) return t;
    if (c === this.trueLiteral) return t;
    if (c === -this.trueLiteral) return e;
    if (t === this.trueLiteral && e === -this.trueLiteral) return c;
    if (t === -this.trueLiteral && e === this.trueLiteral) return -c;
    return this.memoGate('ite', [c, t, e], () => {
      const out = this.newVariable();
      this.addClause([-c, -t, out]); this.addClause([-c, t, -out]);
      this.addClause([c, -e, out]); this.addClause([c, e, -out]);
      return out;
    });
  }

  reduceAnd(xs) { return xs.reduce((a, b) => this.and(a, b), this.constant(true)); }
  reduceOr(xs) { return xs.reduce((a, b) => this.or(a, b), this.constant(false)); }
  constantBits(width, value) {
    const v = BigInt.asUintN(width, BigInt(value));
    return Array.from({ length: width }, (_, bit) => this.constant(((v >> BigInt(bit)) & 1n) === 1n));
  }
  muxBits(c, t, e) { return t.map((v, i) => this.ite(c, v, e[i])); }

  addBits(left, right, carryIn = this.constant(false)) {
    let carry = carryIn;
    const out = [];
    for (let i = 0; i < left.length; i++) {
      const x = this.xor(left[i], right[i]);
      out.push(this.xor(x, carry));
      carry = this.or(this.and(left[i], right[i]), this.and(carry, x));
    }
    return out;
  }
  negateBits(bits) { return this.addBits(bits.map((x) => -x), this.constantBits(bits.length, 0n), this.constant(true)); }
  subtractBits(left, right) { return this.addBits(left, right.map((x) => -x), this.constant(true)); }
  equalBits(left, right) { return this.reduceAnd(left.map((x, i) => -this.xor(x, right[i]))); }

  unsignedLess(left, right) {
    let eq = this.constant(true);
    let less = this.constant(false);
    for (let i = left.length - 1; i >= 0; i--) {
      less = this.or(less, this.and(eq, this.and(-left[i], right[i])));
      eq = this.and(eq, -this.xor(left[i], right[i]));
    }
    return less;
  }

  signedLess(left, right) {
    const ls = left[left.length - 1], rs = right[right.length - 1];
    return this.ite(this.xor(ls, rs), ls, this.unsignedLess(left, right));
  }

  multiplyBits(left, right) {
    let out = this.constantBits(left.length, 0n);
    for (let shift = 0; shift < left.length; shift++) {
      const row = Array.from({ length: left.length }, (_, bit) => bit < shift
        ? this.constant(false)
        : this.and(left[bit - shift], right[shift]));
      out = this.addBits(out, row);
    }
    return out;
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

}
