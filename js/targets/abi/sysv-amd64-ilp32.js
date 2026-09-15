import { ABIPlugin } from './registry.js';
import { SYSV_AMD64_ILP32_ABI as BASE_SYSV_AMD64_ILP32_ABI } from './sysv-amd64.js';

function normalizedType(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

function isLongLong(value) {
  return /^(?:(?:signed|unsigned) )?long long(?: int)?$/.test(normalizedType(value));
}

function withLongLongWidth(parameter) {
  if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) return parameter;
  const declaredType = parameter.type ?? parameter.name;
  if (!isLongLong(declaredType) || parameter.bits != null || parameter.sizeBits != null) return parameter;
  return { ...parameter, bits: 64 };
}

function patchPrototype(prototype) {
  if (!prototype || typeof prototype !== 'object' || Array.isArray(prototype)) return prototype;
  const patched = { ...prototype };
  for (const key of ['args', 'parameters', 'params', 'arguments']) {
    if (Array.isArray(prototype[key])) patched[key] = prototype[key].map(withLongLongWidth);
  }
  const returnType = prototype.returnType ?? prototype.ret ?? prototype.result;
  if (isLongLong(returnType) && prototype.returnBits == null && prototype.bits == null) {
    patched.returnBits = 64;
  }
  return patched;
}

function patchOptions(options = {}) {
  const patched = { ...options };
  if (options.functionPrototype && typeof options.functionPrototype === 'object') {
    patched.functionPrototype = patchPrototype(options.functionPrototype);
  }
  if (options.prototype && typeof options.prototype === 'object') {
    patched.prototype = patchPrototype(options.prototype);
  }
  const returnType = options.returnType ?? options.ret ?? options.result;
  if (isLongLong(returnType) && options.returnBits == null && options.bits == null) {
    patched.returnBits = 64;
  }
  return patched;
}

function patchInstruction(instruction) {
  if (!instruction || typeof instruction !== 'object' || !instruction.callPrototype) return instruction;
  return { ...instruction, callPrototype: patchPrototype(instruction.callPrototype) };
}

// #8885 follow-up: x32 changes C `long` and pointers to 32 bits, but C
// `long long` remains 64 bits. The base x32 classifier deliberately shares the
// AMD64 implementation; normalize only this ILP32 data-model distinction at
// the profile boundary so LP64 behavior and the physical register ABI remain
// byte-for-byte unchanged.
export const SYSV_AMD64_ILP32_ABI = new ABIPlugin({
  id: 'sysv-amd64-ilp32',
  semanticVersion: BASE_SYSV_AMD64_ILP32_ABI.semanticVersion,
  architectureId: BASE_SYSV_AMD64_ILP32_ABI.architectureId,
  platformPredicate: (...args) => BASE_SYSV_AMD64_ILP32_ABI.platformPredicate(...args),
  callingConventions: (...args) => BASE_SYSV_AMD64_ILP32_ABI.callingConventions(...args),
  classifyArguments: (instruction, options = {}) => BASE_SYSV_AMD64_ILP32_ABI.classifyArguments(
    patchInstruction(instruction), patchOptions(options)),
  classifyCallReturn: (instruction, options = {}) => BASE_SYSV_AMD64_ILP32_ABI.classifyCallReturn(
    patchInstruction(instruction), patchOptions(options)),
  classifyFunctionReturn: (options = {}) => BASE_SYSV_AMD64_ILP32_ABI.classifyFunctionReturn(patchOptions(options)),
  classifyEntryRegister: (...args) => BASE_SYSV_AMD64_ILP32_ABI.classifyEntryRegister(...args),
  callerSaved: (...args) => BASE_SYSV_AMD64_ILP32_ABI.callerSaved(...args),
  calleeSaved: (...args) => BASE_SYSV_AMD64_ILP32_ABI.calleeSaved(...args),
  stackRules: (...args) => BASE_SYSV_AMD64_ILP32_ABI.stackRules(...args),
  redZone: (...args) => BASE_SYSV_AMD64_ILP32_ABI.redZone(...args),
  unwindRules: (...args) => BASE_SYSV_AMD64_ILP32_ABI.unwindRules(...args),
  defaultUnknownCallEffects: (...args) => BASE_SYSV_AMD64_ILP32_ABI.defaultUnknownCallEffects(...args),
});
