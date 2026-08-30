import { ABIPlugin } from './registry.js';
import {
  AAPCS64_ABI as CORE_AAPCS64_ABI,
  classifyAAPCS64Arguments as classifyAAPCS64ArgumentsCore,
  classifyAAPCS64CallReturn,
  classifyAAPCS64FunctionReturn,
} from './aapcs64-core.js';

function parameterList(insn, opts) {
  let proto = insn?.callPrototype || null;
  if (!proto) {
    try { proto = opts?.callPrototypeFor?.(insn?.callTarget ?? null, insn) || null; } catch { proto = null; }
  }
  const list = proto && (proto.args || proto.parameters || proto.params || proto.arguments);
  return Array.isArray(list) ? list : null;
}

function stackAlignment(param, argument) {
  const explicit = Number(param?.alignment ?? param?.align ?? param?.alignmentBytes);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(16, Math.max(8, Math.floor(explicit)));
  if (argument?.abiClass === 'vector' && Number(argument?.bits) === 128) return 16;
  if (argument?.abiClass === 'wide-integer') return 16;
  return 8;
}

function normalizeAAPCS64StackLayout(result, params) {
  if (!result || !params) return result;
  const arguments_ = result.arguments.map((argument) => ({ ...argument }));
  const removedRegisters = new Set();

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument.location !== 'register-stack' || argument.abiClass !== 'aggregate') continue;
    for (const reg of argument.regs || []) removedRegisters.add(reg);
    arguments_[index] = {
      index: argument.index,
      location: 'stack',
      offset: argument.offset,
      bytes: argument.bytes,
      abiClass: 'aggregate',
      pointer: false,
      bits: argument.bits,
      alignment: argument.alignment,
      mayContainPointers: argument.mayContainPointers,
      // The wrapper deliberately spills the whole aggregate when the core
      // allocator reaches x7.  Preserve that canonical memory layout as one
      // explicit physical piece rather than making consumers reconstruct it
      // from total width and a stack offset.
      pieces: [{
        pieceIndex: 0,
        order: 0,
        stackOffset: argument.offset,
        bits: argument.bits,
        bytes: argument.bytes,
        byteOffset: 0,
        abiClass: 'aggregate',
      }],
      possible: false,
      mustUse: true,
    };
  }

  let cursor = 0;
  const stackArguments = [];
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument.location !== 'stack') continue;
    const alignment = stackAlignment(params[argument.index ?? index], argument);
    cursor = Math.ceil(cursor / alignment) * alignment;
    argument.offset = cursor;
    argument.alignment = alignment;
    if (argument.abiClass === 'aggregate' && Array.isArray(argument.pieces)) {
      argument.pieces = argument.pieces.map((piece) => ({
        ...piece,
        stackOffset: argument.offset + Number(piece.byteOffset || 0),
      }));
    }
    stackArguments.push(argument);
    cursor += Number(argument.bytes || 0);
  }

  const srcs = result.srcs.slice();
  for (const reg of removedRegisters) {
    const index = srcs.findLastIndex((source) => source.reg === reg);
    if (index >= 0) srcs.splice(index, 1);
  }
  return { ...result, srcs, arguments: arguments_, stackArguments };
}

export function classifyAAPCS64Arguments(insn, opts = {}) {
  return normalizeAAPCS64StackLayout(classifyAAPCS64ArgumentsCore(insn, opts), parameterList(insn, opts));
}

export { classifyAAPCS64CallReturn, classifyAAPCS64FunctionReturn };

export const AAPCS64_ABI = new ABIPlugin({
  id: CORE_AAPCS64_ABI.id,
  semanticVersion: CORE_AAPCS64_ABI.semanticVersion,
  semanticIdentity: CORE_AAPCS64_ABI.semanticIdentity,
  architectureId: CORE_AAPCS64_ABI.architectureId,
  platformPredicate: CORE_AAPCS64_ABI.platformPredicate,
  callingConventions: CORE_AAPCS64_ABI.callingConventions,
  classifyArguments: classifyAAPCS64Arguments,
  classifyCallReturn: classifyAAPCS64CallReturn,
  classifyFunctionReturn: classifyAAPCS64FunctionReturn,
  classifyEntryRegister: CORE_AAPCS64_ABI.classifyEntryRegister,
  callerSaved: CORE_AAPCS64_ABI.callerSaved,
  calleeSaved: CORE_AAPCS64_ABI.calleeSaved,
  stackRules: CORE_AAPCS64_ABI.stackRules,
  redZone: CORE_AAPCS64_ABI.redZone,
  syscallABI: CORE_AAPCS64_ABI.syscallABI,
  unwindRules: CORE_AAPCS64_ABI.unwindRules,
  defaultUnknownCallEffects: CORE_AAPCS64_ABI.defaultUnknownCallEffects,
  supported: CORE_AAPCS64_ABI.supported,
});
