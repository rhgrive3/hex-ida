export function positiveFiniteBudget(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new TypeError('invalid-solver-budget');
    }
    return value;
  }
  throw new TypeError('invalid-solver-budget');
}
