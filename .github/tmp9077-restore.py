from pathlib import Path
p = Path('js/symbolic/solver/bitblast-backend.js')
s = p.read_text()

old = "import { collectSymbols } from './exhaustive-backend.js';"
new = "import { analyzeSolverExpressions } from './query-analysis.js';"
assert s.count(old) == 1, s.count(old)
s = s.replace(old, new, 1)

old = """function deadlineFrom(options) {
  const timeoutMs = Number(options.timeoutMs);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
}
"""
new = """function monotonicNow() {
  return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
}

function deadlineFrom(options) {
  const timeoutMs = options?.timeoutMs;
  return typeof timeoutMs === 'number' && Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? monotonicNow() + timeoutMs
    : Infinity;
}
"""
assert s.count(old) == 1, s.count(old)
s = s.replace(old, new, 1)
s = s.replace('Date.now()', 'monotonicNow()')
s = s.replace("globalThis.performance.now() : monotonicNow();", "globalThis.performance.now() : Date.now();", 1)

old = """    for (const literal of literals) {
      if (seen.has(-literal)) return;
"""
new = """    for (const literal of literals) {
      if (!Number.isSafeInteger(literal) || literal === 0) throw new LimitError('invalid-cnf-literal');
      if (seen.has(-literal)) return;
"""
assert s.count(old) == 1, s.count(old)
s = s.replace(old, new, 1)

old = "validateVerificationQuery(query, { maxExprNodes: limits.maxExprNodes })"
new = "validateVerificationQuery(query, { maxExprNodes: limits.maxExprNodes, maxExprDepth: limits.maxExprDepth })"
assert s.count(old) == 1, s.count(old)
s = s.replace(old, new, 1)

old = "collectSymbols(expressions, { maxExprNodes: limits.maxExprNodes, maxExprDepth: limits.maxExprDepth })"
new = "analyzeSolverExpressions(expressions, { maxExprNodes: limits.maxExprNodes, maxExprDepth: limits.maxExprDepth })"
assert s.count(old) == 1, s.count(old)
s = s.replace(old, new, 1)
p.write_text(s)
