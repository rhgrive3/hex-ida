export * from './extended-state-helpers-core.js';
import * as core from './extended-state-helpers-core.js';

const familyOf = (instruction, family) => String(
  family || instruction?.instructionFamily || instruction?.opcodeName || instruction?.mnemonic || '',
).toLowerCase();

// Capstone 5 currently spells the popping compare mnemonics fcompi/fucompi,
// while Intel/canonical spellings are fcomip/fucomip. Accept both identities
// so decoder spelling cannot change the architectural flag domain.
export const X87_FAMILIES = new Set([
  ...core.X87_FAMILIES,
  'fcompi', 'fucompi',
]);
export const X87_RFLAGS_FAMILIES = new Set([
  ...core.X87_RFLAGS_FAMILIES,
  'fcompi', 'fucompi',
]);

export function isX87RflagsInstruction(instruction, family = null) {
  const fam = familyOf(instruction, family);
  return X87_RFLAGS_FAMILIES.has(fam) || fam.startsWith('fcmov');
}

export function isX87Instruction(instruction, family = null) {
  if (instruction?.detail?.flagsKind === 'fpu-flags') return true;
  const fam = familyOf(instruction, family);
  if (X87_FAMILIES.has(fam)) return true;
  const groups = instruction?.detail?.groups;
  return Array.isArray(groups)
    && groups.some((group) => String(group?.name || '').toLowerCase() === 'fpu');
}
