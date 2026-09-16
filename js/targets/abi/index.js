import {
  ABIPlugin, registerABIPlugin, abiPlugin, abiPlugins, findABIPlugin,
  isRegisteredABIPlugin, abiPluginRegistryDigest, abiPluginRegistryGeneration,
} from './registry.js';
import { AAPCS64_ABI, AAPCS64_ILP32_ABI } from './aapcs64.js';
import { DARWIN_ARM64_ABI } from './darwin-arm64.js';
import { SYSV_AMD64_ABI, SYSV_AMD64_ILP32_ABI as BASE_SYSV_AMD64_ILP32_ABI } from './sysv-amd64.js';
import { MICROSOFT_X64_ABI } from './microsoft-x64.js';
import { MICROSOFT_VECTORCALL_ABI } from './microsoft-vectorcall.js';
import { RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI } from './riscv-lp64.js';

function normalizedType(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

function isX32LongLong(value) {
  return /^(?:(?:signed|unsigned) )?long long(?: int)?$/.test(normalizedType(value));
}

function x32ParameterWidth(parameter) {
  if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) return parameter;
  const declaredType = parameter.type ?? parameter.name;
  if (!isX32LongLong(declaredType) || parameter.bits != null || parameter.sizeBits != null) return parameter;
  return { ...parameter, bits:64 };
}

function x32PrototypeWidths(prototype) {
  if (!prototype || typeof prototype !== 'object' || Array.isArray(prototype)) return prototype;
  const patched = { ...prototype };
  for (const key of ['args', 'parameters', 'params', 'arguments']) {
    if (Array.isArray(prototype[key])) patched[key] = prototype[key].map(x32ParameterWidth);
  }
  const returnType = prototype.returnType ?? prototype.ret ?? prototype.result;
  if (isX32LongLong(returnType) && prototype.returnBits == null && prototype.bits == null) patched.returnBits = 64;
  return patched;
}

function x32Options(options = {}) {
  const patched = { ...options };
  if (options.functionPrototype && typeof options.functionPrototype === 'object') {
    patched.functionPrototype = x32PrototypeWidths(options.functionPrototype);
  }
  if (options.prototype && typeof options.prototype === 'object') {
    patched.prototype = x32PrototypeWidths(options.prototype);
  }
  const returnType = options.returnType ?? options.ret ?? options.result;
  if (isX32LongLong(returnType) && options.returnBits == null && options.bits == null) patched.returnBits = 64;
  return patched;
}

function x32Instruction(instruction) {
  if (!instruction || typeof instruction !== 'object' || !instruction.callPrototype) return instruction;
  return { ...instruction, callPrototype:x32PrototypeWidths(instruction.callPrototype) };
}

// x32 keeps C `long` and pointers at 32 bits, but `long long` remains 64 bits.
// Bind that data-model distinction at the already-existing ABI registry boundary
// rather than introducing another production module (which would fall outside
// the userscript wrapper closure). The physical AMD64 carrier stays unchanged.
const SYSV_AMD64_ILP32_ABI = new ABIPlugin({
  id:'sysv-amd64-ilp32',
  semanticVersion:BASE_SYSV_AMD64_ILP32_ABI.semanticVersion,
  architectureId:BASE_SYSV_AMD64_ILP32_ABI.architectureId,
  platformPredicate:(...args) => BASE_SYSV_AMD64_ILP32_ABI.platformPredicate(...args),
  callingConventions:(...args) => BASE_SYSV_AMD64_ILP32_ABI.callingConventions(...args),
  classifyArguments:(instruction, options = {}) => BASE_SYSV_AMD64_ILP32_ABI.classifyArguments(
    x32Instruction(instruction), x32Options(options)),
  classifyCallReturn:(instruction, options = {}) => BASE_SYSV_AMD64_ILP32_ABI.classifyCallReturn(
    x32Instruction(instruction), x32Options(options)),
  classifyFunctionReturn:(options = {}) => BASE_SYSV_AMD64_ILP32_ABI.classifyFunctionReturn(x32Options(options)),
  classifyEntryRegister:(...args) => BASE_SYSV_AMD64_ILP32_ABI.classifyEntryRegister(...args),
  callerSaved:(...args) => BASE_SYSV_AMD64_ILP32_ABI.callerSaved(...args),
  calleeSaved:(...args) => BASE_SYSV_AMD64_ILP32_ABI.calleeSaved(...args),
  stackRules:(...args) => BASE_SYSV_AMD64_ILP32_ABI.stackRules(...args),
  redZone:(...args) => BASE_SYSV_AMD64_ILP32_ABI.redZone(...args),
  unwindRules:(...args) => BASE_SYSV_AMD64_ILP32_ABI.unwindRules(...args),
  defaultUnknownCallEffects:(...args) => BASE_SYSV_AMD64_ILP32_ABI.defaultUnknownCallEffects(...args),
});

const UNKNOWN_ABI = new ABIPlugin({
  id:'unknown', semanticVersion:'1', architectureId:'unknown', supported:false,
  platformPredicate:()=>true,
  classifyArguments:()=>({ srcs:[], arguments:[], stackArguments:[], stackArgsUnknown:true, stackArgsMayContainPointers:true, evidence:'unsupported-abi', unsupported:true }),
  classifyCallReturn:()=>null,
  classifyFunctionReturn:()=>null,
  classifyEntryRegister:(reg)=>({ kind:'incoming-register-state', reg:String(reg || '') }),
  callerSaved:()=>Object.freeze([]),
  calleeSaved:()=>Object.freeze([]),
  stackRules:()=>Object.freeze({ unknown:true }),
  redZone:()=>null,
  unwindRules:()=>Object.freeze({ unknown:true }),
  defaultUnknownCallEffects:()=>Object.freeze({ registerEffects:'unknown', memoryEffects:'unknown', mayThrow:true }),
});

registerABIPlugin(DARWIN_ARM64_ABI);
registerABIPlugin(AAPCS64_ABI);
registerABIPlugin(AAPCS64_ILP32_ABI);
registerABIPlugin(SYSV_AMD64_ABI);
registerABIPlugin(SYSV_AMD64_ILP32_ABI);
registerABIPlugin(MICROSOFT_X64_ABI);
registerABIPlugin(MICROSOFT_VECTORCALL_ABI);
registerABIPlugin(RISCV_LP64_ABI);
registerABIPlugin(RISCV_LP64F_ABI);
registerABIPlugin(RISCV_LP64D_ABI);
registerABIPlugin(UNKNOWN_ABI);

export {
  ABIPlugin, registerABIPlugin, abiPlugin, abiPlugins, findABIPlugin,
  isRegisteredABIPlugin, abiPluginRegistryDigest, abiPluginRegistryGeneration,
  AAPCS64_ABI, AAPCS64_ILP32_ABI, DARWIN_ARM64_ABI,
  SYSV_AMD64_ABI, MICROSOFT_X64_ABI, MICROSOFT_VECTORCALL_ABI, UNKNOWN_ABI,
  RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI,
};

function requestedCallingConvention(target = {}) {
  const prototype = target?.callPrototype || target?.functionPrototype || target?.prototype || null;
  return target?.callingConvention || target?.convention || target?.cc
    || prototype?.callingConvention || prototype?.convention || prototype?.cc || null;
}

export function resolveABIPlugin(target = {}, { legacyDefault = false } = {}) {
  if (target?.abiPlugin && typeof target.abiPlugin === 'object') {
    return isRegisteredABIPlugin(target.abiPlugin) ? target.abiPlugin : UNKNOWN_ABI;
  }
  if (target?.abi && typeof target.abi === 'object') {
    return isRegisteredABIPlugin(target.abi) ? target.abi : UNKNOWN_ABI;
  }
  const callingConvention = requestedCallingConvention(target);
  const explicit = target?.abiId || (typeof target?.abi === 'string' ? target.abi : null);
  const arch = String(target?.architectureId || target?.architecture || target?.arch || '').trim().toLowerCase();
  const bits = Number(target?.bits || target?.pointerBits || 0);
  const isIlp32 = bits === 32 || target?.dataModel === 'ilp32';
  if (explicit) {
    if (explicit === 'aapcs64' && isIlp32 && arch === 'arm64') {
      return findABIPlugin({
        id: 'aapcs64-ilp32',
        callingConvention,
        architecture: arch,
        platform: target?.platformId || target?.platform || target?.os,
      }) || UNKNOWN_ABI;
    }
    return findABIPlugin({
      id: explicit,
      callingConvention,
      architecture: target?.architectureId || target?.architecture || target?.arch,
      platform: target?.platformId || target?.platform || target?.os,
    }) || UNKNOWN_ABI;
  }
  if (arch === 'arm64' && isIlp32) {
    return findABIPlugin({
      id: 'aapcs64-ilp32',
      callingConvention,
      architecture: arch,
      platform: target?.platformId || target?.platform || target?.os,
    }) || UNKNOWN_ABI;
  }
  // x86-64 ILP32 ("x32"): the loader already proved ELFCLASS32 + EM_X86_64 with
  // pointerBits=32/dataModel=ilp32, so selecting the LP64 sysv-amd64 plugin would
  // publish 64-bit pointer/long ABI facts against a 32-bit data model (#8885).
  // Bind the ILP32 profile while keeping the AMD64 physical carrier. An explicit
  // abiId:'sysv-amd64' above still resolves to LP64 exactly.
  if (arch === 'x86_64' && isIlp32) {
    return findABIPlugin({
      id: 'sysv-amd64-ilp32',
      callingConvention,
      architecture: arch,
      platform: target?.platformId || target?.platform || target?.os,
    }) || UNKNOWN_ABI;
  }
  const found = findABIPlugin({
    architecture:target?.architectureId || target?.architecture || target?.arch,
    platform:target?.platformId || target?.platform || target?.os,
    callingConvention,
  });
  if (found?.supported) return found;
  if (legacyDefault && (!arch || arch === 'arm64') && !target?.platformId && !target?.platform && !target?.os && !callingConvention) return AAPCS64_ABI;
  return UNKNOWN_ABI;
}
