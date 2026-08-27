const CONTROL_VALID = new Set([0,2,3,4,8]);
const DEBUG_ARCHITECTURAL = new Set([0,1,2,3,6,7]);

function descriptor(kind, index) {
  const prefix = kind === 'control-register' ? 'cr' : 'dr';
  const id = `${prefix}${index}`;
  return Object.freeze({
    id,
    physicalId:id,
    physicalBits:64,
    viewBits:64,
    lsb:0,
    writePolicy:'replace',
    kind,
    architecturalKind:kind,
    modeled:true,
    privileged:true,
    architecturallyDefined:kind === 'control-register' ? CONTROL_VALID.has(index) : DEBUG_ARCHITECTURAL.has(index),
  });
}

const descriptors = [];
const physical = [];
for (const kind of ['control-register','debug-register']) {
  for (let index = 0; index < 16; index++) {
    const item = descriptor(kind, index);
    descriptors.push(item);
    physical.push(Object.freeze({
      id:item.physicalId,
      bits:item.physicalBits,
      kind:item.kind,
      views:Object.freeze([item.id]),
      privileged:true,
      architecturallyDefined:item.architecturallyDefined,
    }));
  }
}

const byId = new Map(descriptors.map((item) => [item.id,item]));

export const X86_PRIVILEGED_REGISTER_DESCRIPTORS = Object.freeze(descriptors);
export const X86_PRIVILEGED_PHYSICAL_REGISTERS = Object.freeze(physical);

export function x86PrivilegedRegisterDescriptor(value) {
  const name = String(typeof value === 'object'
    ? (value?.registerId ?? value?.id ?? value?.name ?? value?.text ?? '')
    : value ?? '').trim().toLowerCase().replace(/^%/, '');
  return byId.get(name) || null;
}
