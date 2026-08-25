import './registers-core.js';

const api = globalThis.HexX86Registers;
if (!api) throw new Error('x86-physical-state-contract-unavailable');

function extendedVectorDescriptor(value) {
  const name = api.normalizeName(typeof value === 'object' ? (value?.registerId ?? value?.id ?? value?.name ?? value?.text) : value);
  const match = /^(xmm|ymm)(1[6-9]|2[0-9]|3[01])$/.exec(name);
  if (!match) return null;
  const index = Number(match[2]);
  return Object.freeze({
    id:name, physicalId:`ymm${index}`, physicalBits:256, viewBits:match[1] === 'xmm' ? 128 : 256, lsb:0,
    writePolicy:match[1] === 'xmm' ? 'encoding-dependent-upper-lanes' : 'replace', kind:'vector',
    evexOnly:true, modeled:true,
  });
}

export const X86_PHYSICAL_STATE_CONTRACT_VERSION = api.contractVersion;
export const X86_MODELED_FLAGS = api.modeledFlags;
export const X86_REGISTER_DESCRIPTORS = api.descriptors;
export const X86_PHYSICAL_REGISTERS = api.physicalRegisters;
export const normalizeX86RegisterName = api.normalizeName;
export const x86RegisterDescriptor = (value) => api.registerDescriptor(value) ?? extendedVectorDescriptor(value);
export const x86RegisterFile = api.registerFile;
