from pathlib import Path

p = Path('js/analysis/semantic-function.js')
s = p.read_text()
needle = """export function assertRequiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`semantic-function-${label}-required`);
  }
  return value.trim();
}

export function analyzeSemanticFunction(input = {}, options = {}) {
  abortIfRequested(options.signal);
  const architectureId = String(input.architecture || '').toLowerCase();
  if (!architectureId) throw new TypeError('semantic-function-architecture-required');
"""
replacement = """export function assertRequiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`semantic-function-${label}-required`);
  }
  return value.trim();
}

function normalizedProtocolSelector(value, code) {
  if (typeof value !== 'string') throw new TypeError(code);
  const text = value.trim().toLowerCase();
  if (!text) throw new TypeError(code);
  return text;
}

export function analyzeSemanticFunction(input = {}, options = {}) {
  abortIfRequested(options.signal);
  const architectureId = normalizedProtocolSelector(input.architecture, 'semantic-function-architecture-required');
"""
if needle not in s:
    raise SystemExit('architecture target not found')
s = s.replace(needle, replacement, 1)
s = s.replace("const endian = String(requestedInstructionEndianness).trim().toLowerCase();", "const endian = normalizedProtocolSelector(requestedInstructionEndianness, 'semantic-function-invalid-instruction-endianness');", 1)
s = s.replace("const endian = String(requestedMemoryEndianness).trim().toLowerCase();", "const endian = normalizedProtocolSelector(requestedMemoryEndianness, 'semantic-function-invalid-memory-endianness');", 1)
p.write_text(s)

Path('tests/phase7/issue-3134-semantic-function-selectors.test.mjs').write_text("""import assert from 'node:assert/strict';
import { analyzeSemanticFunction } from '../../js/analysis/semantic-function.js';

for (const architecture of [['arm64'], { toString(){ return 'arm64'; } }, true, 1]) {
  assert.throws(() => analyzeSemanticFunction({ architecture }), /semantic-function-architecture-required/);
}
for (const [field, value, code] of [
  ['instructionEndianness', ['little'], 'semantic-function-invalid-instruction-endianness'],
  ['instructionEndianness', { toString(){ return 'little'; } }, 'semantic-function-invalid-instruction-endianness'],
  ['dataEndianness', ['little'], 'semantic-function-invalid-memory-endianness'],
  ['dataEndianness', true, 'semantic-function-invalid-memory-endianness'],
]) {
  assert.throws(() => analyzeSemanticFunction({ architecture:'arm64', [field]:value }), new RegExp(code));
}
assert.throws(() => analyzeSemanticFunction({ architecture:' ARM64 ' }), /semantic-function-supported-abi-required|semantic-function-decoded-instructions-required|semantic-function-decoder-semantic-version-required/);
console.log('issue-3134-semantic-function-selectors: PASS');
""")
