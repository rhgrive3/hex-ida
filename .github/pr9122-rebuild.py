from pathlib import Path
import subprocess

repo = Path('.')
target = repo / 'js/symbolic/solver/bitblast-backend.js'
donor = subprocess.check_output([
    'git', 'show', 'origin/component/final-closure-t014-v3:js/symbolic/solver/bitblast-backend.js'
], text=True)

s = donor
s = s.replace(
    "import { collectSymbols } from './exhaustive-backend.js';",
    "import { analyzeSolverExpressions } from './query-analysis.js';",
)
old_deadline = """function deadlineFrom(options) {\n  const timeoutMs = Number(options.timeoutMs);\n  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;\n}"""
new_deadline = """function monotonicNow() {\n  return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();\n}\n\nfunction deadlineFrom(options) {\n  const timeoutMs = options?.timeoutMs;\n  return typeof timeoutMs === 'number' && Number.isSafeInteger(timeoutMs) && timeoutMs > 0\n    ? monotonicNow() + timeoutMs\n    : Infinity;\n}"""
assert old_deadline in s
s = s.replace(old_deadline, new_deadline)
s = s.replace("if (Date.now() >= this.deadline) throw new LimitError('timeout');", "if (monotonicNow() >= this.deadline) throw new LimitError('timeout');")
old_literal = """    for (const literal of literals) {\n      if (seen.has(-literal)) return;"""
new_literal = """    for (const literal of literals) {\n      if (!Number.isSafeInteger(literal) || literal === 0) throw new LimitError('invalid-cnf-literal');\n      if (seen.has(-literal)) return;"""
assert old_literal in s
s = s.replace(old_literal, new_literal)
s = s.replace("if (Date.now() >= deadline) return 'timeout';", "if (monotonicNow() >= deadline) return 'timeout';")
s = s.replace("const startedAt = Date.now();", "const startedAt = monotonicNow();")
s = s.replace("solveTimeMs: Date.now() - startedAt", "solveTimeMs: monotonicNow() - startedAt")
old_collect = "const collected = collectSymbols(expressions, { maxExprNodes: limits.maxExprNodes, maxExprDepth: limits.maxExprDepth });"
new_collect = "const collected = analyzeSolverExpressions(expressions, { maxExprNodes: limits.maxExprNodes, maxExprDepth: limits.maxExprDepth });"
assert old_collect in s
s = s.replace(old_collect, new_collect)

assert 'collectSymbols' not in s
assert 'this.muxBits0zero' not in s
assert 'analyzeSolverExpressions' in s
assert "const key = String(expr.symbolId || expr.name);" in s
target.write_text(s)
