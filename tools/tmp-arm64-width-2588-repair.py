from pathlib import Path


def replace(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"anchor missing: {path}: {old[:100]!r}")
    p.write_text(s.replace(old, new, 1))

# Structured register width is decoder evidence. Never coerce strings/booleans/
# objects into architectural 32/64-bit widths.
replace(
    'js/targets/architecture/arm64/effects/common.js',
    "export function instructionBits(op, fallback = 64) {\n  const bits = Number(op?.bits ?? fallback);\n  return bits === 32 || bits === 64 ? bits : fallback;\n}",
    "export function instructionBits(op, fallback = 64) {\n  const bits = op?.bits;\n  if (bits == null) return fallback === 32 || fallback === 64 ? fallback : 0;\n  return typeof bits === 'number' && Number.isInteger(bits) && (bits === 32 || bits === 64) ? bits : 0;\n}",
)
replace(
    'js/targets/architecture/arm64/effects/common.js',
    "  const bits = instructionBits(op);\n  const register31 = op.num == null || (Number.isInteger(op.num) && op.num === 31);",
    "  const bits = instructionBits(op);\n  if (bits !== 32 && bits !== 64) return null;\n  const register31 = op.num == null || (Number.isInteger(op.num) && op.num === 31);",
)
replace(
    'js/targets/architecture/arm64/effects/integer.js',
    "function regBits(op) { return Number(op?.bits || 0); }",
    "function regBits(op) {\n  const bits = op?.bits;\n  return typeof bits === 'number' && Number.isInteger(bits) && (bits === 32 || bits === 64) ? bits : 0;\n}",
)
replace(
    'js/targets/architecture/arm64/effects/fp-core.js',
    "function scalarWidth(op) {\n  const bits = Number(op?.bits || 0);\n  return Number.isSafeInteger(bits) && bits > 0 ? bits : null;\n}",
    "function scalarWidth(op) {\n  const bits = op?.bits;\n  return typeof bits === 'number' && Number.isSafeInteger(bits) && bits > 0 ? bits : null;\n}",
)
replace(
    'js/targets/architecture/arm64/effects/system.js',
    "    && Number(op.bits) === 64",
    "    && typeof op.bits === 'number'\n    && Number.isInteger(op.bits)\n    && op.bits === 64",
)
replace(
    'js/targets/architecture/arm64/effects/system.js',
    "function gpRead(operations, op, id) {\n  if (op?.k === 'reg' && op.cls === 'zr') return createBitVectorValue(Number(op.bits || 64), 0n);\n  const regId = gpId(op);\n  if (!regId) return null;\n  const width = Number(op.bits || 64);",
    "function gpRead(operations, op, id) {\n  const width = op?.bits;\n  if (typeof width !== 'number' || !Number.isInteger(width) || width !== 64) return null;\n  if (op?.k === 'reg' && op.cls === 'zr') return createBitVectorValue(width, 0n);\n  const regId = gpId(op);\n  if (!regId) return null;",
)
replace(
    'js/targets/architecture/arm64/effects/system.js',
    "function gpWrite(operations, op, value) {\n  if (op?.k === 'reg' && op.cls === 'zr') return true;\n  const regId = gpId(op);\n  if (!regId) return false;\n  const width = Number(op.bits || 64);",
    "function gpWrite(operations, op, value) {\n  const width = op?.bits;\n  if (typeof width !== 'number' || !Number.isInteger(width) || width !== 64) return false;\n  if (op?.k === 'reg' && op.cls === 'zr') return true;\n  const regId = gpId(op);\n  if (!regId) return false;",
)

p = Path('js/targets/architecture/arm64/effects/index.js')
s = p.read_text()
anchor = "function isPlainGpSource(operand) {\n  return isGpOrZrRegister(operand) && operand.shift == null && operand.extend == null;\n}\n"
helper = anchor + "\nfunction structuredRegisterWidth(operand) {\n  const bits = operand?.bits;\n  return typeof bits === 'number' && Number.isInteger(bits) && (bits === 32 || bits === 64) ? bits : 0;\n}\n"
if anchor not in s:
    raise SystemExit('index helper anchor missing')
s = s.replace(anchor, helper, 1)
s = s.replace('Number(operand.bits) === widthBits', 'structuredRegisterWidth(operand) === widthBits')
s = s.replace('Number(operand.bits) !== widthBits', 'structuredRegisterWidth(operand) !== widthBits')
s = s.replace('Number(ops[0]?.bits || 0)', 'structuredRegisterWidth(ops[0])')
p.write_text(s)

# Add a focused public-path regression. Legal numeric widths stay semantic;
# malformed structured widths must not produce definite operations.
test = r'''import assert from 'node:assert/strict';

import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { instructionBits } from '../../js/targets/architecture/arm64/effects/common.js';

let seq = 0;
const gp = (num, bits = 64) => ({ k:'reg', cls:'gp', num, bits, text:`${bits === 32 ? 'w' : 'x'}${num}` });
const fp = (num, bits = 64) => ({ k:'reg', cls:'fp', num, bits, text:`${bits === 32 ? 's' : 'd'}${num}` });
const sysreg = (text) => ({ k:'sysreg', text });
function lift(mnemonic, ops) {
  const instructionId = `arm64-structured-width:${++seq}`;
  return liftArm64MachineEffects({ instructionId, mnemonic, mode:'a64', ops, origin:{ instructionIds:[instructionId] } });
}
function assertFailClosed(bundle, label) {
  assert.ok(bundle, `${label}: family remains explicitly owned`);
  assert.equal(bundle.completeness, 'partial', `${label}: malformed structured width must be partial`);
  assert.equal(bundle.operations.length, 0, `${label}: malformed structured width must emit no definite operation`);
}

assert.equal(instructionBits({ bits:64 }), 64);
assert.equal(instructionBits({ bits:32 }), 32);
for (const bits of ['64', true, false, {}, [], 64.5, NaN, Infinity, -Infinity, 16, 128]) {
  assert.equal(instructionBits({ bits }), 0, `instructionBits rejects ${String(bits)}`);
}

const add = lift('add', [gp(0), gp(1), gp(2)]);
assert.ok(add && add.completeness !== 'partial' && add.operations.length > 0, 'numeric-width ADD remains semantic');
assertFailClosed(lift('add', [{ ...gp(0), bits:'64' }, gp(1), gp(2)]), 'ADD string width');
assertFailClosed(lift('add', [gp(0), { ...gp(1), bits:true }, gp(2)]), 'ADD boolean width');
assertFailClosed(lift('add', [gp(0), gp(1), { ...gp(2), bits:64.5 }]), 'ADD fractional width');

const fadd = lift('fadd', [fp(0), fp(1), fp(2)]);
assert.ok(fadd && fadd.completeness !== 'partial' && fadd.operations.length > 0, 'numeric-width FADD remains semantic');
assertFailClosed(lift('fadd', [{ ...fp(0), bits:'64' }, fp(1), fp(2)]), 'FADD string width');

const mrs = lift('mrs', [gp(0), sysreg('fpcr')]);
assert.ok(mrs && mrs.completeness !== 'partial' && mrs.operations.length > 0, 'numeric-width MRS remains semantic');
assertFailClosed(lift('mrs', [{ ...gp(0), bits:'64' }, sysreg('fpcr')]), 'MRS string width');

console.log('arm64-structured-width-validation: PASS');
'''
Path('tests/machine-effects/arm64-structured-width-validation.test.mjs').write_text(test)
