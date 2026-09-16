// JVMS §2.6.3/§4.3.3/§6.5: the operand-stack signature of a JVM call site is a
// pure function of the resolved method descriptor plus the dispatch kind. This
// module owns that resolution so `lifter-core.js` never has to invent a stack
// effect from an opcode alone (#1138).
//
// Like `field-reference.js`, every failure to resolve losslessly returns null:
// the caller must then withhold stack authority instead of publishing an exact
// call. Reference values keep the project's 64-bit reference model and carry no
// canonical machine `type` here, because naming the managed-heap address type is
// #8836's owned scope.

import { parseJvmMethodDescriptor } from './descriptors.js';

function cpEntry(jvmClass, index) {
  const pool = jvmClass?.constantPool;
  if (!Array.isArray(pool) || !Number.isInteger(index) || index <= 0 || index >= pool.length) return null;
  return pool[index] ?? null;
}

function utf8Value(jvmClass, index) {
  const entry = cpEntry(jvmClass, index);
  return entry?.tag === 1 && typeof entry.value === 'string' ? entry.value : null;
}

function validUnqualifiedName(name) {
  return typeof name === 'string'
    && name.length > 0
    && !name.includes('.')
    && !name.includes(';')
    && !name.includes('[')
    && !name.includes('/');
}

function validInternalClassName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  return name.split('/').every(validUnqualifiedName);
}

const PRIMITIVE_VALUE_TYPES = Object.freeze(Object.assign(Object.create(null), {
  B: { bits: 32, category: 1, valueKind: 'int' },
  C: { bits: 32, category: 1, valueKind: 'int' },
  D: { bits: 64, category: 2, valueKind: 'double' },
  F: { bits: 32, category: 1, valueKind: 'float' },
  I: { bits: 32, category: 1, valueKind: 'int' },
  J: { bits: 64, category: 2, valueKind: 'long' },
  S: { bits: 32, category: 1, valueKind: 'int' },
  Z: { bits: 32, category: 1, valueKind: 'int' },
}));

function floatMachineType(kind) {
  return kind === 'float'
    ? { kind: 'float', widthBits: 32, format: 'binary32' }
    : { kind: 'float', widthBits: 64, format: 'binary64' };
}

// A parsed field type (as returned by `descriptors.js`) becomes an operand-stack
// value model: `bits`/`category` follow JVMS §2.11.1 (long/double are category
// 2, every other value including a reference is category 1). The IEEE-754 domain
// keeps its canonical machine type exactly as #8955 established for fields.
function valueModelForType(type, descriptor) {
  if (type?.kind === 'base') {
    const primitive = PRIMITIVE_VALUE_TYPES[type.tag];
    if (!primitive) return null;
    return Object.freeze({
      descriptor,
      bits: primitive.bits,
      category: primitive.category,
      slots: primitive.category,
      valueKind: primitive.valueKind,
      ...(primitive.valueKind === 'float' || primitive.valueKind === 'double'
        ? { type: floatMachineType(primitive.valueKind) }
        : {}),
    });
  }
  if (type?.kind === 'object' || type?.kind === 'array') {
    return Object.freeze({
      descriptor,
      bits: 64,
      category: 1,
      slots: 1,
      valueKind: 'reference',
    });
  }
  return null;
}

function descriptorTextForType(type) {
  if (type?.kind === 'base') return type.tag;
  if (type?.kind === 'object') return `L${type.className};`;
  if (type?.kind === 'array') {
    let text = type.component ? descriptorTextForType(type.component) : null;
    if (text == null) return null;
    for (let dimension = 0; dimension < type.dimensions; dimension += 1) text = `[${text}`;
    return text;
  }
  return null;
}

const DISPATCH_TAGS = Object.freeze({ virtual: 10, special: 10, static: 10, interface: 11 });

/**
 * Resolve the constant-pool method reference used by one JVM invoke opcode into
 * the exact operand-stack signature JVMS prescribes for it, or `null` when any
 * part of the reference is not losslessly resolvable.
 */
export function resolveJvmMethodSignature(jvmClass, cpIndex, { dispatchKind } = {}) {
  const expectedTag = DISPATCH_TAGS[dispatchKind];
  if (expectedTag == null) return null;
  const ref = cpEntry(jvmClass, cpIndex);
  if (!ref || ref.tag !== expectedTag) return null;

  const ownerClass = cpEntry(jvmClass, ref.classIndex);
  const nameAndType = cpEntry(jvmClass, ref.nameAndTypeIndex);
  if (ownerClass?.tag !== 7 || nameAndType?.tag !== 12) return null;

  const owner = utf8Value(jvmClass, ownerClass.nameIndex);
  const name = utf8Value(jvmClass, nameAndType.nameIndex);
  const descriptor = utf8Value(jvmClass, nameAndType.descriptorIndex);
  if (!validInternalClassName(owner) || !validUnqualifiedName(name)) return null;
  // JVMS §4.4.2: an interface method reference is never an initialization method.
  if (expectedTag === 10 && name === '<clinit>') return null;
  if (expectedTag === 11 && name === '<init>') return null;

  let parsed;
  try {
    parsed = parseJvmMethodDescriptor(descriptor);
  } catch {
    return null;
  }

  const parameters = [];
  for (const parameter of parsed.parameters) {
    const text = descriptorTextForType(parameter);
    const model = text == null ? null : valueModelForType(parameter, text);
    if (!model) return null;
    parameters.push(model);
  }
  let returnType = null;
  if (parsed.returnType) {
    const text = descriptorTextForType(parsed.returnType);
    returnType = text == null ? null : valueModelForType(parsed.returnType, text);
    if (!returnType) return null;
  }
  // JVMS §4.4.2/§6.5: `<init>` and `<clinit>` are the only methods that may be
  // named by a Methodref that `invokespecial` targets, and both are void-returning.
  if (dispatchKind === 'special' && name === '<init>' && parsed.returnType != null) return null;

  const receiverRequired = dispatchKind !== 'static';
  const receiver = Object.freeze({
    bits: 64,
    category: 1,
    slots: 1,
    valueKind: 'reference',
    descriptor: 'Ljava/lang/Object;',
  });

  // `consumedValues` is emitted in pop order (stack top first), the same
  // convention the field opcodes use: the last declared argument is the first
  // value the machine removes from the operand stack. `type` is carried only
  // where the descriptor already proves an IEEE-754 domain (#8955); reference
  // values keep the project's 64-bit model without inventing a machine type.
  const consumedValues = parameters.map((parameter, index) => ({
    id: `arg${index}`,
    bits: parameter.bits,
    category: parameter.category,
    valueKind: parameter.valueKind,
    descriptor: parameter.descriptor,
    ...(parameter.type ? { type: parameter.type } : {}),
    parameterIndex: index,
  })).reverse();
  if (receiverRequired) consumedValues.push({ id: 'objectref', ...receiver });

  const consumedSlots = parameters.reduce((total, parameter) => total + parameter.slots, receiverRequired ? 1 : 0);
  const producedSlots = returnType ? returnType.slots : 0;
  const producedValues = [];
  if (returnType) {
    producedValues.push({
      id: 'return',
      bits: returnType.bits,
      category: returnType.category,
      valueKind: returnType.valueKind,
      descriptor: returnType.descriptor,
      ...(returnType.type ? { type: returnType.type } : {}),
    });
  }
  // JVMS §6.5 invokespecial: an instance initialization method pops its
  // objectref and pushes that same objectref back after the call, so the
  // freshly initialized object stays where the verifier expects it.
  const initializesReceiver = dispatchKind === 'special' && name === '<init>';
  if (initializesReceiver) {
    producedValues.push({
      id: 'initializedObjectref',
      ...receiver,
      aliasConsumedReceiver: true,
    });
  }

  return Object.freeze({
    cpIndex,
    owner,
    name,
    descriptor,
    dispatchKind,
    receiverRequired,
    initializesReceiver,
    parameters: Object.freeze(parameters),
    returnType,
    consumedValues: Object.freeze(consumedValues),
    producedValues: Object.freeze(producedValues),
    consumedSlots,
    producedSlots,
  });
}
