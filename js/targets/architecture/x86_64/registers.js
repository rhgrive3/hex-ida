import './registers-core.js';
import {
  X86_PRIVILEGED_PHYSICAL_REGISTERS,
  X86_PRIVILEGED_REGISTER_DESCRIPTORS,
  x86PrivilegedRegisterDescriptor,
} from './registers-privileged.js';

const api = globalThis.HexX86Registers;
if (!api) throw new Error('x86-physical-state-contract-unavailable');

export const X86_PHYSICAL_STATE_CONTRACT_VERSION = api.contractVersion;
export const X86_MODELED_FLAGS = api.modeledFlags;
export const X86_REGISTER_DESCRIPTORS = Object.freeze([
  ...api.descriptors,
  ...X86_PRIVILEGED_REGISTER_DESCRIPTORS,
]);
export const X86_PHYSICAL_REGISTERS = Object.freeze([
  ...api.physicalRegisters,
  ...X86_PRIVILEGED_PHYSICAL_REGISTERS,
]);
export const normalizeX86RegisterName = api.normalizeName;
export const x86RegisterDescriptor = (value) => api.registerDescriptor(value)
  ?? x86PrivilegedRegisterDescriptor(value);
export function x86RegisterFile() {
  return Object.freeze([
    ...api.registerFile(),
    ...X86_PRIVILEGED_PHYSICAL_REGISTERS,
  ]);
}
