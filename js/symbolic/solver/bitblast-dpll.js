import { SORT_KIND } from '../expr/kinds.js';
import { monotonicNow } from './bitblast-cnf-base.js';

function literalIndex(literal) {
  return literal > 0 ? literal * 2 : (-literal * 2) + 1;
}

function literalValue(literal, assignment) {
  const value = assignment[Math.abs(literal)];
  return value === 0 ? 0 : (literal > 0 ? value : -value);
}

export async function solveCnf(builder, { signal, deadline, limits }) {
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
    if (monotonicNow() >= deadline) return 'timeout';
    if (decisions > limits.maxDecisions) return 'decision-budget-exceeded';
    if (propagations > limits.maxPropagations) return 'propagation-budget-exceeded';
    if (propagations - yieldedAt >= limits.yieldEvery) {
      yieldedAt = propagations;
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted) return 'cancelled';
      if (monotonicNow() >= deadline) return 'timeout';
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

export function extractModel(symbols, builder, assignment) {
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

