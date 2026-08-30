from pathlib import Path


def replace(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'anchor missing: {path}: {old[:120]!r}')
    p.write_text(s.replace(old, new, 1))

replace(
    'js/targets/architecture/arm64/effects/common.js',
    "  function shiftImmediate(value, widthBits, kind, amount) {\n    const n = Number(amount);\n    if (!Number.isInteger(n) || n < 0 || n >= widthBits) return null;",
    "  function shiftImmediate(value, widthBits, kind, amount) {\n    const n = amount;\n    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= widthBits) return null;",
)
replace(
    'js/targets/architecture/arm64/effects/common.js',
    "    const kind = String(modifier.op || '').toLowerCase();\n    const amount = modifier.amount == null ? 0 : Number(modifier.amount);",
    "    if (typeof modifier.op !== 'string') return null;\n    const kind = modifier.op.toLowerCase();\n    const amount = modifier.amount == null ? 0 : modifier.amount;\n    if (typeof amount !== 'number' || !Number.isInteger(amount)) return null;",
)
replace(
    'js/targets/architecture/arm64/effects/common.js',
    "      const modifierKind = String(op.shift?.op || '').toLowerCase();",
    "      const modifierKind = typeof op.shift?.op === 'string' ? op.shift.op.toLowerCase() : '';",
)

replace(
    'js/targets/architecture/arm64/effects/integer.js',
    "  return String(op.shift.op || '').toLowerCase() === 'lsl' && Number(op.shift.amount) === 12;",
    "  return typeof op.shift.op === 'string'\n    && op.shift.op.toLowerCase() === 'lsl'\n    && typeof op.shift.amount === 'number'\n    && Number.isInteger(op.shift.amount)\n    && op.shift.amount === 12;",
)
replace(
    'js/targets/architecture/arm64/effects/integer.js',
    "  const kind = String(modifier.op || '').toLowerCase();\n  const amount = Number(modifier.amount ?? 0);\n  if (!Number.isInteger(amount) || amount < 0 || amount > 4) return false;",
    "  if (typeof modifier.op !== 'string') return false;\n  const kind = modifier.op.toLowerCase();\n  const amount = modifier.amount ?? 0;\n  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || amount > 4) return false;",
)
replace(
    'js/targets/architecture/arm64/effects/integer.js',
    "  const kind = String(modifier.op || '').toLowerCase();\n  const amount = Number(modifier.amount ?? 0);\n  return ['lsl','lsr','asr'].includes(kind)\n    && Number.isInteger(amount) && amount >= 0 && amount < targetBits;",
    "  if (typeof modifier.op !== 'string') return false;\n  const kind = modifier.op.toLowerCase();\n  const amount = modifier.amount ?? 0;\n  return ['lsl','lsr','asr'].includes(kind)\n    && typeof amount === 'number' && Number.isInteger(amount) && amount >= 0 && amount < targetBits;",
)
replace(
    'js/targets/architecture/arm64/effects/integer.js',
    "  const explicitExtend = EXTEND_KINDS.has(String(modifier?.op || '').toLowerCase());",
    "  const explicitExtend = typeof modifier?.op === 'string' && EXTEND_KINDS.has(modifier.op.toLowerCase());",
)
replace(
    'js/targets/architecture/arm64/effects/integer.js',
    "  if (String(src.shift.op || '').toLowerCase() !== 'lsl') return false;\n  const amount = Number(src.shift.amount);\n  if (!Number.isInteger(amount)) return false;",
    "  if (typeof src.shift.op !== 'string' || src.shift.op.toLowerCase() !== 'lsl') return false;\n  const amount = src.shift.amount;\n  if (typeof amount !== 'number' || !Number.isInteger(amount)) return false;",
)

replace(
    'js/targets/architecture/arm64/effects/index.js',
    "  return String(op.shift.op || '').toLowerCase() === 'lsl' && Number(op.shift.amount) === 12;",
    "  return typeof op.shift.op === 'string'\n    && op.shift.op.toLowerCase() === 'lsl'\n    && typeof op.shift.amount === 'number'\n    && Number.isInteger(op.shift.amount)\n    && op.shift.amount === 12;",
)
replace(
    'js/targets/architecture/arm64/effects/index.js',
    "  const kind = String(operand.shift.op || '').toLowerCase();\n  const amount = Number(operand.shift.amount ?? 0);\n  return ['lsl','lsr','asr','ror'].includes(kind) && Number.isInteger(amount) && amount >= 0 && amount < widthBits;",
    "  if (typeof operand.shift.op !== 'string') return false;\n  const kind = operand.shift.op.toLowerCase();\n  const amount = operand.shift.amount ?? 0;\n  return ['lsl','lsr','asr','ror'].includes(kind)\n    && typeof amount === 'number' && Number.isInteger(amount) && amount >= 0 && amount < widthBits;",
)

replace(
    'js/targets/architecture/arm64/effects/addressing.js',
    "  const op = String(shift.op || '').toLowerCase();\n  const amount = shift.amount == null ? 0 : Number(shift.amount);\n  if (!Number.isInteger(amount) || amount < 0 || amount > 4) fail('arm64-invalid-register-offset-shift');",
    "  if (typeof shift.op !== 'string') fail('arm64-invalid-register-offset-shift');\n  const op = shift.op.toLowerCase();\n  const amount = shift.amount == null ? 0 : shift.amount;\n  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || amount > 4) fail('arm64-invalid-register-offset-shift');",
)

Path('tests/machine-effects/arm64-structured-shift-validation.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let seq = 0;
const gp = (num, bits = 64, extra = {}) => ({ k:'reg', cls:'gp', num, bits, text:`${bits === 32 ? 'w' : 'x'}${num}`, ...extra });
const imm = (value, extra = {}) => ({ k:'imm', value:BigInt(value), text:`#${value}`, ...extra });
const mem = (shift) => ({ k:'mem', base:gp(1), index:gp(2), mode:'offset', ...(shift == null ? {} : {shift}) });
function lift(mnemonic, ops) {
  const instructionId = `arm64-structured-shift:${++seq}`;
  return liftArm64MachineEffects({ instructionId, mnemonic, mode:'a64', ops, origin:{instructionIds:[instructionId]} });
}
function assertSemantic(bundle, label) {
  assert.ok(bundle && bundle.completeness !== 'partial', `${label}: valid encoding remains semantic`);
  assert.ok(bundle.operations.some((op) => op.kind !== 'unknown'), `${label}: valid encoding emits definite operation`);
}
function assertFailClosed(bundle, label) {
  assert.ok(bundle, `${label}: family remains owned`);
  assert.equal(bundle.completeness, 'partial', `${label}: malformed shift descriptor is partial`);
  assert.ok(bundle.operations.every((op) => op.kind === 'unknown'), `${label}: malformed shift descriptor emits no definite operation`);
}

assertSemantic(lift('add', [gp(0), gp(1), gp(2, 64, {shift:{op:'lsl', amount:1}})]), 'ADD lsl #1');
for (const [label, shift] of [
  ['string amount', {op:'lsl', amount:'1'}],
  ['boolean amount', {op:'lsl', amount:true}],
  ['object amount', {op:'lsl', amount:{valueOf(){return 1;}}}],
  ['array amount', {op:'lsl', amount:[1]}],
  ['fraction amount', {op:'lsl', amount:1.5}],
  ['NaN amount', {op:'lsl', amount:NaN}],
  ['Infinity amount', {op:'lsl', amount:Infinity}],
  ['negative amount', {op:'lsl', amount:-1}],
  ['width amount', {op:'lsl', amount:64}],
  ['object op', {op:{toString(){return 'lsl';}}, amount:1}],
  ['array op', {op:['lsl'], amount:1}],
]) assertFailClosed(lift('add', [gp(0), gp(1), gp(2, 64, {shift})]), `ADD ${label}`);

assertSemantic(lift('add', [gp(0), gp(1), imm(1, {shift:{op:'lsl', amount:12}})]), 'ADD immediate lsl #12');
assertFailClosed(lift('add', [gp(0), gp(1), imm(1, {shift:{op:'lsl', amount:'12'}})]), 'ADD immediate string #12');
assertFailClosed(lift('add', [gp(0), gp(1), imm(1, {shift:{op:{toString(){return 'lsl';}}, amount:12}})]), 'ADD immediate object op');

assertSemantic(lift('movz', [gp(0), imm(1, {shift:{op:'lsl', amount:16}})]), 'MOVZ lsl #16');
assertFailClosed(lift('movz', [gp(0), imm(1, {shift:{op:'lsl', amount:'16'}})]), 'MOVZ string shift');

assertSemantic(lift('add', [gp(0), gp(1), gp(2, 32, {shift:{op:'uxtw', amount:1}})]), 'ADD extended uxtw #1');
assertFailClosed(lift('add', [gp(0), gp(1), gp(2, 32, {shift:{op:{toString(){return 'uxtw';}}, amount:1}})]), 'ADD object extend op');

assertSemantic(lift('ldr', [gp(0), mem({op:'lsl', amount:3})]), 'LDR register offset lsl #3');
assertFailClosed(lift('ldr', [gp(0), mem({op:'lsl', amount:'3'})]), 'LDR register offset string amount');
assertFailClosed(lift('ldr', [gp(0), mem({op:{toString(){return 'lsl';}}, amount:3})]), 'LDR register offset object op');

console.log('arm64-structured-shift-validation: PASS');
''')
