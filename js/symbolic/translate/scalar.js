/** Canonical scalar lowering shared by static translation and execution.
 * This module maps declared IR operations to the existing Bool/BV factories.
 * It does not evaluate ISA instructions or implement a second expression engine.
 */
import { OP } from '../../ir-base.js';
import { createBv, createBool, createCast, createIte, createCompare, createBinary,
  createUnary, createUnknownSemantic, bvSort } from '../expr/index.js';
const undef = (bits, reason) => createUnknownSemantic(bvSort(bits), reason);
export function floatingSemantics(value) {
  return [value?.float, value?.floatConst, value?.extra?.float, value?.extra?.attributes?.float]
    .some(marker => marker != null && marker !== false)
    || [value?.constKind, value?.extra?.constKind].some(kind => kind != null && !['integer', 'int', 'bitvector'].includes(kind));
}
export function literalExpression(inst, bits, value = inst?.dst) {
  if (floatingSemantics(inst) || floatingSemantics(value)) return undef(bits, 'unsupported-floating-semantics');
  if (inst?.op === OP.CONST && (inst.args?.length ?? 0) !== 0) return undef(bits, 'scalar-operand-arity');
  const literals = [inst?.value, inst?.extra?.value, value?.const].filter(item => item != null);
  if (!literals.length) return undef(bits, 'missing-constant-value');
  let expression;
  for (const literal of literals) {
    // The IR producer supplies integer payloads, never a rounded Number or an
    // unbounded textual literal. Width truncation belongs to canonical Expr.
    if (typeof literal !== 'bigint' && !(typeof literal === 'number' && Number.isSafeInteger(literal))) {
      return undef(bits, 'unsafe-or-invalid-constant-literal');
    }
    const candidate = createBv(bits, literal);
    if (expression && expression.value !== candidate.value) return undef(bits, 'conflicting-constant-literal');
    expression = candidate;
  }
  return expression;
}

const ALIASES = Object.freeze({ orr: 'or', eor: 'xor' });
const BINARY = new Set(['add','sub','mul','and','or','xor','shl','lshr','ashr','udiv','sdiv','urem','srem']);
const UNARY = new Set(['not','neg']);
const CASTS = new Set(['trunc','zext','sext']);
/** Both spellings are public producer contracts; neither may silently override the other. */
export function scalarOperation(inst) {
  const declarations = [inst?.subOp, inst?.sub, inst?.name].filter(x => x != null);
  let operation = null;
  for (const value of declarations) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const token = value.trim().toLowerCase();
    const normalized = Object.hasOwn(ALIASES, token) ? ALIASES[token] : token;
    if (operation != null && operation !== normalized) return null;
    operation = normalized;
  }
  return operation;
}
export function scalarOperationSupported(inst) {
  const operation = scalarOperation(inst);
  if (inst?.op === OP.BIN) return BINARY.has(operation);
  if (inst?.op === OP.UN) return UNARY.has(operation) || CASTS.has(operation);
  return true;
}
export function lowerScalarInstruction(inst, args, bits, condition = null) {
  if (!Number.isSafeInteger(bits) || bits < 1 || bits > 65536) throw new TypeError('scalar-width');
  if (floatingSemantics(inst) || floatingSemantics(inst.dst)) return undef(bits, 'unsupported-floating-semantics');
  if (inst.op === OP.CONST || inst.op === OP.ADDR && (inst.value != null || inst.extra?.value != null || inst.dst?.const != null)) {
    return args.length ? undef(bits, 'scalar-operand-arity') : literalExpression(inst, bits);
  }
  const arity = inst.op === OP.BIN || inst.op === OP.CMP || inst.op === OP.SEL ? 2 : inst.op === OP.UN ? 1 : null;
  if (arity != null && args.length !== arity) return undef(bits, 'scalar-operand-arity');
  const operation = scalarOperation(inst);
  if ([OP.BIN, OP.UN].includes(inst.op) && !operation) return undef(bits, 'missing-or-invalid-scalar-operation');
  if (inst.op === OP.MOV && inst.extra?.addressSemantic === true) {
    const descriptor = inst.extra.attributes?.machineAddressExpression;
    if (!descriptor || !['add','sub'].includes(descriptor.kind) || descriptor.widthBits !== bits
        || inst.extra.completeness !== 'complete' || args.length !== 2) return undef(bits, 'unsupported-address-expression');
    return lowerScalarInstruction({ op: OP.BIN, subOp: descriptor.kind }, args, bits);
  }
  if ([OP.MOV, OP.UN].includes(inst.op) && CASTS.has(operation)) {
    if (args.length !== 1 || args[0]?.sort?.kind !== 'bv') return undef(bits, 'cast-input-contract');
    if (inst.extra?.sourceBits != null && inst.extra.sourceBits !== args[0].sort.width
        || inst.extra?.targetBits != null && inst.extra.targetBits !== bits) return undef(bits, 'cast-width-contract');
    try { return createCast(operation, args[0], bits); }
    catch (error) { if (!(error instanceof TypeError || error instanceof RangeError)) throw error; return undef(bits, 'cast-width-contract'); }
  }
  if (inst.op === OP.CMP) {
    const signedDeclarations = [inst.signed, inst.extra?.signed].filter(x => x != null);
    if (signedDeclarations.some(x => typeof x !== 'boolean')) return undef(bits, 'invalid-comparison-signedness');
    if (signedDeclarations.some(x => x !== signedDeclarations[0])) return undef(bits, 'conflicting-comparison-signedness');
    if (args.some(x => x?.sort?.kind !== 'bv') || args[0].sort.width !== args[1].sort.width) return undef(bits, 'scalar-input-width-mismatch');
    const conditionToken = inst.cond ?? operation;
    const signed = signedDeclarations[0] === true;
    const comparisons = { '==':'eq', eq:'eq', '!=':'ne', ne:'ne',
      '<':signed?'slt':'ult', lt:signed?'slt':'ult', '<=':signed?'sle':'ule', le:signed?'sle':'ule',
      '>':signed?'sgt':'ugt', gt:signed?'sgt':'ugt', '>=':signed?'sge':'uge', ge:signed?'sge':'uge',
      ult:'ult', ule:'ule', ugt:'ugt', uge:'uge', slt:'slt', sle:'sle', sgt:'sgt', sge:'sge' };
    if (typeof conditionToken !== 'string' || !Object.hasOwn(comparisons, conditionToken)) return undef(bits, 'unsupported-cmp-op');
    return createCompare(comparisons[conditionToken], args[0], args[1]);
  }
  if (inst.op === OP.SEL) {
    if (condition?.sort?.kind !== 'bool') return undef(bits, 'memory-select-needs-canonical-condition');
    if (args.some(x => x?.sort?.kind !== 'bv' || x.sort.width !== bits)) return undef(bits, 'select-sort-contract');
    return createIte(condition, args[0], args[1]);
  }
  if (args.some(x => x?.sort?.kind !== 'bv' || x.sort.width !== bits)) return undef(bits, 'scalar-input-width-mismatch');
  if ([OP.MOV, OP.ADDR].includes(inst.op)) {
    if (args.length !== 1) return undef(bits, 'ambiguous-move-operands');
    if (operation != null && !['mov', 'address'].includes(operation)) return undef(bits, 'unsupported-move-operation');
    return args[0];
  }
  if (inst.op === OP.UN) return UNARY.has(operation) ? createUnary(operation, args[0]) : undef(bits, 'unsupported-unary-subop');
  if (inst.op !== OP.BIN || !BINARY.has(operation)) return undef(bits, 'unsupported-scalar-operation');
  const machine = inst.extra?.attributes?.machineEffects;
  const policy = machine?.operationMetadata;
  const division = ['udiv','sdiv'].includes(operation);
  if (division && machine) {
    if (machine.bundleCompleteness !== 'exact' || inst.extra.completeness !== 'complete'
        || policy?.divisionByZero !== 'returns-zero' || policy?.widthBits !== bits
        || policy.signedOverflow !== (operation === 'sdiv' ? 'wraps-min-div-minus-one' : 'not-applicable')) {
      return undef(bits, 'unsupported-machine-division-policy');
    }
  } else if (policy?.divisionByZero != null || policy?.signedOverflow != null) return undef(bits, 'unsupported-machine-arithmetic-policy');
  const expression = createBinary(operation, args[0], args[1]);
  if (!division || !machine) return expression;
  const zero = createBv(bits, 0n);
  return createIte(createCompare('eq', args[1], zero), zero, expression);
}
