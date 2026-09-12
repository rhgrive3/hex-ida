// Canonical Mach-O instruction-start width authority for metadata that can
// mint exact function starts. Unknown/unsupported CPUs stay fail-closed.
export function machoInstructionUnit(arch) {
  if (arch === 'arm64' || arch === 'arm64e' || arch === 'arm64_32' || arch === 'ppc') return 4n;
  if (arch === 'arm') return 2n;
  if (arch === 'x86' || arch === 'x86_64') return 1n;
  return null;
}
