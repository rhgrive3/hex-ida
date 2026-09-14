import { arm64MemoryAccessQualifiers } from '../targets/architecture/arm64/memory-access-qualifiers.js';

// Composition boundary for built-in target adapters. The list is private and
// immutable: architecture-plugin registration and caller callbacks cannot add
// proof authority. Each adapter returns descriptor facts, never a sealed proof.
const PROVIDERS = Object.freeze([arm64MemoryAccessQualifiers]);

export function canonicalMemoryAccessQualifiers(descriptor) {
  for (const provider of PROVIDERS) {
    const qualifiers = provider(descriptor);
    if (qualifiers) return qualifiers;
  }
  return null;
}
