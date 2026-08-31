from pathlib import Path

p = Path('js/analysis/semantic-function-base.js')
s = p.read_text()
old = """      for (const entry of classified?.arguments ?? []) {
        if (!entry || !['register','registers'].includes(entry.location)) continue;
        const registers = Array.isArray(entry.regs) ? entry.regs : typeof entry.reg === 'string' ? [entry.reg] : [];
        for (const register of registers) {
          const reg = String(register || '');
          if (!reg) continue;
          const key = String(entry.index ?? locations.length) + ':' + reg;
          if (seen.has(key)) continue;
          seen.add(key);
          locations.push(Object.freeze({
            index:Number.isInteger(Number(entry.index)) ? Number(entry.index) : locations.length,
            reg,
"""
new = """      for (const entry of classified?.arguments ?? []) {
        if (!entry || !['register','registers'].includes(entry.location)) continue;
        const hasExplicitIndex = entry.index != null;
        if (hasExplicitIndex && (typeof entry.index !== 'number' || !Number.isSafeInteger(entry.index))) continue;
        const index = hasExplicitIndex ? entry.index : locations.length;
        const registers = Array.isArray(entry.regs) ? entry.regs : typeof entry.reg === 'string' ? [entry.reg] : [];
        for (const register of registers) {
          if (typeof register !== 'string' || !register.length) continue;
          const reg = register;
          const key = index + ':' + reg;
          if (seen.has(key)) continue;
          seen.add(key);
          locations.push(Object.freeze({
            index,
            reg,
"""
if old not in s:
    raise SystemExit('target argumentLocations block not found')
s = s.replace(old, new, 1)
old_piece = """            pieceIndex:Array.isArray(entry.pieces)
              ? (entry.pieces.findIndex((piece) => String(piece?.reg || '') === reg) >= 0
                ? entry.pieces.findIndex((piece) => String(piece?.reg || '') === reg)
                : null)
"""
new_piece = """            pieceIndex:Array.isArray(entry.pieces)
              ? (entry.pieces.findIndex((piece) => typeof piece?.reg === 'string' && piece.reg === reg) >= 0
                ? entry.pieces.findIndex((piece) => typeof piece?.reg === 'string' && piece.reg === reg)
                : null)
"""
if old_piece not in s:
    raise SystemExit('target pieceIndex block not found')
p.write_text(s.replace(old_piece, new_piece, 1))

test = Path('tests/phase7/issue-3118-semantic-abi-argument-metadata.test.mjs')
test.write_text("""import assert from 'node:assert/strict';
import { semanticAbiAdapter } from '../../js/analysis/semantic-function-base.js';
import { ABIPlugin, registerABIPlugin } from '../../js/targets/abi/index.js';

let arguments_ = [];
const plugin = registerABIPlugin(new ABIPlugin({
  id:'test-3118-strict-argument-metadata', architectureId:'test-3118', semanticVersion:'1',
  classifyArguments:() => ({ arguments:arguments_, stackArguments:[] }),
}));
const adapter = semanticAbiAdapter(plugin);

arguments_ = [{ location:'register', reg:'x0', index:0 }, { location:'register', regs:['x1','x2'] }];
assert.deepEqual(adapter.argumentLocations().map(({ index, reg }) => ({ index, reg })), [
  { index:0, reg:'x0' }, { index:1, reg:'x1' }, { index:1, reg:'x2' },
]);
for (const reg of [['x0'], { toString(){ return 'x0'; } }, true, 1]) {
  arguments_ = [{ location:'registers', regs:[reg], index:0 }];
  assert.deepEqual(adapter.argumentLocations(), []);
}
for (const index of [['0'], '0', { valueOf(){ return 0; } }, true, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  arguments_ = [{ location:'register', reg:'x0', index }];
  assert.deepEqual(adapter.argumentLocations(), []);
}
arguments_ = [{ location:'register', reg:'x0' }];
assert.equal(adapter.argumentLocations()[0]?.index, 0);
console.log('issue-3118-semantic-abi-argument-metadata: PASS');
""")
