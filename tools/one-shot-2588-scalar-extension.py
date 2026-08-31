from pathlib import Path


def edit(path, replacements):
    p = Path(path)
    s = p.read_text()
    for old, new, label in replacements:
        if old not in s:
            raise SystemExit(f'{path}: anchor drift: {label}')
        s = s.replace(old, new, 1)
    p.write_text(s)


# #2588 was reopened/expanded to every structured-register scalar authority owner.
# Keep the already-strict canonical k:'reg' path, but reject coercion in generic,
# control/flags/FP/system/outer gates and redundant internal descriptors.
edit('js/targets/architecture/arm64/effects/common.js', [
    ("""export function instructionBits(op, fallback = 64) {
  const bits = Number(op?.bits ?? fallback);
  return bits === 32 || bits === 64 ? bits : fallback;
}""",
     """export function instructionBits(op, fallback = 64) {
  const bits = op?.bits;
  if (bits == null) return fallback === 32 || fallback === 64 ? fallback : 0;
  return typeof bits === 'number' && Number.isInteger(bits) && (bits === 32 || bits === 64) ? bits : 0;
}""", 'instructionBits'),
    ("""function registerDescriptor(op) {
  if (!op || op.k !== 'reg') return null;
  const bits = instructionBits(op);
  const register31 = op.num == null || (Number.isInteger(op.num) && op.num === 31);""",
     """function registerDescriptor(op) {
  if (!op || op.k !== 'reg') return null;
  const bits = instructionBits(op);
  if (bits !== 32 && bits !== 64) return null;
  const register31 = op.num == null || (Number.isInteger(op.num) && op.num === 31);""", 'common register descriptor width'),
])

edit('js/targets/architecture/arm64/effects/control.js', [
    ("""    && Number(operand.bits) === 64
    && operand.shift == null""",
     """    && typeof operand.bits === 'number'
    && Number.isInteger(operand.bits)
    && operand.bits === 64
    && operand.shift == null""", 'indirect control width'),
    ("""    && (Number(operand.bits) === 32 || Number(operand.bits) === 64)
    && operand.shift == null""",
     """    && typeof operand.bits === 'number'
    && Number.isInteger(operand.bits)
    && (operand.bits === 32 || operand.bits === 64)
    && operand.shift == null""", 'branch test width'),
])

edit('js/targets/architecture/arm64/effects/flags.js', [
    ("""function validRegisterLhs(mnemonic, op) {
  if (op?.k !== 'reg') return false;
  const cls = String(op.cls || '').toLowerCase();""",
     """function registerClass(op) {
  return op?.k === 'reg' && typeof op.cls === 'string' ? op.cls.toLowerCase() : '';
}

function registerWidth(op) {
  const bits = op?.bits;
  return typeof bits === 'number' && Number.isInteger(bits) && (bits === 32 || bits === 64) ? bits : 0;
}

function validRegisterLhs(mnemonic, op) {
  const cls = registerClass(op);""", 'flags register helpers'),
    ("""  const lhsBits = Number(lhs?.bits || 0);
  const rhsBits = Number(rhs?.bits || 0);
  if (![32,64].includes(lhsBits) || !['gp','zr'].includes(String(rhs.cls || '').toLowerCase())) return false;""",
     """  const lhsBits = registerWidth(lhs);
  const rhsBits = registerWidth(rhs);
  if (![32,64].includes(lhsBits) || !['gp','zr'].includes(registerClass(rhs))) return false;""", 'flags rhs widths'),
    ("""  const lhsClass = String(lhs?.cls || '').toLowerCase();""",
     """  const lhsClass = registerClass(lhs);""", 'flags lhs class'),
    ("""  return !ops.some((op) => op?.k === 'reg' && String(op.cls || '').toLowerCase() === 'sp');""",
     """  return !ops.some((op) => op?.k === 'reg' && registerClass(op) === 'sp');""", 'flags TST class'),
])

edit('js/targets/architecture/arm64/effects/fp-core.js', [
    ("""function scalarWidth(op) {
  const bits = Number(op?.bits || 0);
  return Number.isSafeInteger(bits) && bits > 0 ? bits : null;
}""",
     """function scalarWidth(op) {
  const bits = op?.bits;
  return typeof bits === 'number' && Number.isSafeInteger(bits) && bits > 0 ? bits : null;
}""", 'FP scalar width'),
])

edit('js/targets/architecture/arm64/effects/integer.js', [
    ("""function regClass(op) { return op?.k === 'reg' ? String(op.cls || '').toLowerCase() : ''; }
function regBits(op) { return Number(op?.bits || 0); }""",
     """function regClass(op) { return op?.k === 'reg' && typeof op.cls === 'string' ? op.cls.toLowerCase() : ''; }
function regBits(op) {
  const bits = op?.bits;
  return typeof bits === 'number' && Number.isInteger(bits) && (bits === 32 || bits === 64) ? bits : 0;
}""", 'integer register class/width'),
])

edit('js/targets/architecture/arm64/effects/index.js', [
    ("""function isGpOrZrRegister(operand) {
  return operand?.k === 'reg' && ['gp','zr'].includes(String(operand.cls || '').toLowerCase());
}

function isPlainGpSource(operand) {
  return isGpOrZrRegister(operand) && operand.shift == null && operand.extend == null;
}

function isPlainGpSourceOfWidth(operand, widthBits) {
  return isPlainGpSource(operand) && Number(operand.bits) === widthBits;
}

function isGpSourceOfWidth(operand, widthBits) {
  return isGpOrZrRegister(operand) && Number(operand.bits) === widthBits;
}""",
     """function isGpOrZrRegister(operand) {
  return operand?.k === 'reg' && typeof operand.cls === 'string' && ['gp','zr'].includes(operand.cls.toLowerCase());
}

function isPlainGpSource(operand) {
  return isGpOrZrRegister(operand) && operand.shift == null && operand.extend == null;
}

function structuredRegisterWidth(operand) {
  const bits = operand?.bits;
  return typeof bits === 'number' && Number.isInteger(bits) && (bits === 32 || bits === 64) ? bits : 0;
}

function isPlainGpSourceOfWidth(operand, widthBits) {
  return isPlainGpSource(operand) && structuredRegisterWidth(operand) === widthBits;
}

function isGpSourceOfWidth(operand, widthBits) {
  return isGpOrZrRegister(operand) && structuredRegisterWidth(operand) === widthBits;
}""", 'outer structured width helper'),
    ("""  if (!isGpOrZrRegister(operand) || Number(operand.bits) !== widthBits || operand.extend != null) return false;""",
     """  if (!isGpOrZrRegister(operand) || structuredRegisterWidth(operand) !== widthBits || operand.extend != null) return false;""", 'logical source width'),
    ("""  const widthBits = Number(ops[0]?.bits || 0);""",
     """  const widthBits = structuredRegisterWidth(ops[0]);""", 'addsub outer width'),
    ("""  const widthBits = Number(ops[0]?.bits || 0);""",
     """  const widthBits = structuredRegisterWidth(ops[0]);""", 'logical outer width'),
    ("""  const destinationBits = Number(ops[0]?.bits || 0);""",
     """  const destinationBits = structuredRegisterWidth(ops[0]);""", 'multiply outer width'),
    ("""  const widthBits = Number(ops[0]?.bits || 0);""",
     """  const widthBits = structuredRegisterWidth(ops[0]);""", 'register-only outer width'),
    ("""  const widthBits = Number(ops[0]?.bits || 0);""",
     """  const widthBits = structuredRegisterWidth(ops[0]);""", 'move outer width'),
])

edit('js/targets/architecture/arm64/effects/system.js', [
    ("""    && Number(op.bits) === 64
    && op.shift == null""",
     """    && typeof op.bits === 'number'
    && Number.isInteger(op.bits)
    && op.bits === 64
    && op.shift == null""", 'system Xt width'),
    ("""function gpRead(operations, op, id) {
  if (op?.k === 'reg' && op.cls === 'zr') return createBitVectorValue(Number(op.bits || 64), 0n);
  const regId = gpId(op);
  if (!regId) return null;
  const width = Number(op.bits || 64);""",
     """function gpRead(operations, op, id) {
  const width = op?.bits;
  if (typeof width !== 'number' || !Number.isInteger(width) || width !== 64) return null;
  if (op?.k === 'reg' && op.cls === 'zr') return createBitVectorValue(width, 0n);
  const regId = gpId(op);
  if (!regId) return null;""", 'system gpRead width'),
    ("""function gpWrite(operations, op, value) {
  if (op?.k === 'reg' && op.cls === 'zr') return true;
  const regId = gpId(op);
  if (!regId) return false;
  const width = Number(op.bits || 64);""",
     """function gpWrite(operations, op, value) {
  const width = op?.bits;
  if (typeof width !== 'number' || !Number.isInteger(width) || width !== 64) return false;
  if (op?.k === 'reg' && op.cls === 'zr') return true;
  const regId = gpId(op);
  if (!regId) return false;""", 'system gpWrite width'),
])

edit('js/targets/architecture/arm64/effects/addressing.js', [
    ("""  if (typeof input.physicalId === 'string' && typeof input.kind === 'string') {
    const parsed = arm64RegisterOperand(input.view || input.physicalId);
    if (parsed) return { ...parsed, bits:Number(input.bits || parsed.bits), kind:input.kind, zero:!!input.zero };
  }

  if (typeof input.registerId === 'string') {
    const parsed = arm64RegisterOperand(input.view || input.registerId);
    if (parsed) return { ...parsed, bits: Number(input.widthBits || parsed.bits) };
  }""",
     """  if (typeof input.physicalId === 'string' && typeof input.kind === 'string') {
    const parsed = arm64RegisterOperand(input.view || input.physicalId);
    if (!parsed || parsed.physicalId !== input.physicalId || parsed.kind !== input.kind) return null;
    if (input.bits != null && (typeof input.bits !== 'number' || !Number.isInteger(input.bits) || input.bits !== parsed.bits)) return null;
    if (input.zero != null && (typeof input.zero !== 'boolean' || input.zero !== parsed.zero)) return null;
    return parsed;
  }

  if (typeof input.registerId === 'string') {
    const parsed = arm64RegisterOperand(input.view || input.registerId);
    if (!parsed || parsed.physicalId !== input.registerId) return null;
    if (input.widthBits != null && (typeof input.widthBits !== 'number' || !Number.isInteger(input.widthBits) || input.widthBits !== parsed.bits)) return null;
    return parsed;
  }""", 'redundant descriptor authority'),
])

Path('tests/machine-effects/arm64-structured-width-validation.test.mjs').write_text(r'''import assert from 'node:assert/strict';

import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { instructionBits } from '../../js/targets/architecture/arm64/effects/common.js';
import { arm64RegisterOperand } from '../../js/targets/architecture/arm64/effects/addressing.js';

let seq = 0;
const gp = (num, bits = 64) => ({ k:'reg', cls:'gp', num, bits, text:`${bits === 32 ? 'w' : 'x'}${num}` });
const fp = (num, bits = 64) => ({ k:'reg', cls:'fp', num, bits, text:`${bits === 32 ? 's' : 'd'}${num}` });
const sysreg = (text) => ({ k:'sysreg', text });
function lift(mnemonic, ops, extra = {}) {
  const instructionId = `arm64-structured-width:${++seq}`;
  return liftArm64MachineEffects({ instructionId, mnemonic, mode:'a64', ops, origin:{ instructionIds:[instructionId] }, ...extra });
}
function assertFailClosed(bundle, label) {
  assert.ok(bundle, `${label}: family remains explicitly owned`);
  assert.equal(bundle.completeness, 'partial', `${label}: malformed structured width must be partial`);
  assert.ok(bundle.operations.every((operation) => operation.kind === 'unknown'), `${label}: malformed width must emit no definite operation`);
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
assertFailClosed(lift('add', [{ ...gp(0), cls:{ toString(){ return 'gp'; } } }, gp(1), gp(2)]), 'ADD object register class');
assertFailClosed(lift('add', [gp(0), { ...gp(1), cls:['gp'] }, gp(2)]), 'ADD array register class');

const fadd = lift('fadd', [fp(0), fp(1), fp(2)]);
assert.ok(fadd && fadd.completeness !== 'partial' && fadd.operations.length > 0, 'numeric-width FADD remains semantic');
assertFailClosed(lift('fadd', [{ ...fp(0), bits:'64' }, fp(1), fp(2)]), 'FADD string width');

const mrs = lift('mrs', [gp(0), sysreg('fpcr')]);
assert.ok(mrs && mrs.completeness !== 'partial' && mrs.operations.length > 0, 'numeric-width MRS remains semantic');
assertFailClosed(lift('mrs', [{ ...gp(0), bits:'64' }, sysreg('fpcr')]), 'MRS string width');

const br = lift('br', [gp(3)]);
assert.ok(br && br.completeness !== 'partial' && br.operations.length > 0, 'numeric-width BR remains semantic');
const cbz = lift('cbz', [gp(0, 32), { k:'imm', value:0x1004n }], { address:0x1000n });
assert.ok(cbz && cbz.completeness !== 'partial' && cbz.operations.length > 0, 'numeric-width CBZ remains semantic');
const cmp = lift('cmp', [gp(0), gp(1)]);
assert.ok(cmp && cmp.completeness !== 'partial' && cmp.operations.length > 0, 'numeric-width CMP remains semantic');
for (const bits of ['64', true, {}, [], 64.5, NaN, Infinity]) {
  assertFailClosed(lift('br', [{ ...gp(3), bits }]), `BR malformed width ${String(bits)}`);
  assertFailClosed(lift('cbz', [{ ...gp(0, 32), bits }, { k:'imm', value:0x1004n }], { address:0x1000n }), `CBZ malformed width ${String(bits)}`);
  assertFailClosed(lift('cmp', [gp(0), { ...gp(1), bits }]), `CMP malformed width ${String(bits)}`);
}

// Internal normalized descriptors are authority too: redundant identity fields must agree.
assert.equal(arm64RegisterOperand({physicalId:'x0',kind:'gp',view:'x0',bits:'64',zero:false}), null);
assert.equal(arm64RegisterOperand({physicalId:'x0',kind:'gp',view:'x1',bits:64,zero:false}), null);
assert.equal(arm64RegisterOperand({physicalId:'x0',kind:'gp',view:'x0',bits:32,zero:false}), null);
assert.equal(arm64RegisterOperand({registerId:'x0',view:'x0',widthBits:'64'}), null);
assert.equal(arm64RegisterOperand({registerId:'x0',view:'x1',widthBits:64}), null);
assert.equal(arm64RegisterOperand({physicalId:'x0',kind:'gp',view:'x0',bits:64,zero:false})?.physicalId, 'x0');
assert.equal(arm64RegisterOperand({registerId:'x0',view:'x0',widthBits:64})?.physicalId, 'x0');

console.log('arm64-structured-width-validation: PASS');
''')
