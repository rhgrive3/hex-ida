import crypto from 'node:crypto';

export const X86_CAPSTONE_REGISTRY_SCHEMA = 'x86-capstone-instruction-name-registry/v1';
export const X86_CAPSTONE_REGISTRY_ID = 'deployed-capstone-5:x86:instruction-name-registry:v1';
export const X86_CAPSTONE_REGISTRY_EXPECTED = Object.freeze({
  firstInstructionId: 1,
  lastInstructionId: 1523,
  instructionCount: 1523,
  // SHA-256 over one UTF-8 `id:name\n` record per contiguous instruction ID.
  registrySha256: '439bf1931af7dc6f1cfc1b81788e10513f5a58ebc67a89add9c16f28355c5bce',
});

const MAX_REGISTRY_ID = 4096;

function fail(reason, detail = '') {
  throw new TypeError(detail ? `${reason}:${detail}` : reason);
}

/**
 * Freeze the finite instruction-name registry exported by the deployed
 * Capstone build. This is deliberately not an encoding denominator: Capstone
 * exposes one registry for all x86 modes, and cs_insn_name does not enumerate
 * the byte encodings, prefix combinations, operand shapes, or mode validity
 * represented by an instruction ID.
 */
export function buildX86CapstoneRegistryEvidence(instructionName) {
  if (typeof instructionName !== 'function') fail('x86-capstone-registry-name-lookup-required');
  const rows = [];
  let seenTerminator = false;
  for (let id = 1; id <= MAX_REGISTRY_ID; id++) {
    const name = instructionName(id);
    if (name == null || name === '') {
      seenTerminator = true;
      // Reject a hole followed by another name. A contiguous interval is part
      // of this deployed registry's identity, not an assumption about future
      // Capstone versions.
      for (let probe = id + 1; probe <= Math.min(MAX_REGISTRY_ID, id + 32); probe++) {
        if (instructionName(probe)) fail('x86-capstone-registry-noncontiguous', `${id}->${probe}`);
      }
      break;
    }
    rows.push(Object.freeze({ id, name:String(name) }));
  }
  if (!seenTerminator) fail('x86-capstone-registry-unbounded', MAX_REGISTRY_ID);
  if (rows.length === 0) fail('x86-capstone-registry-empty');

  const registrySha256 = crypto.createHash('sha256')
    .update(rows.map(({ id, name }) => `${id}:${name}\n`).join(''))
    .digest('hex');
  return Object.freeze({
    schemaVersion:X86_CAPSTONE_REGISTRY_SCHEMA,
    registryId:X86_CAPSTONE_REGISTRY_ID,
    scope:'capstone-x86-all-modes-instruction-name-registry',
    firstInstructionId:rows[0].id,
    lastInstructionId:rows.at(-1).id,
    instructionCount:rows.length,
    registrySha256,
    rows:Object.freeze(rows),
    long64EncodingDenominator:false,
    missingAuthority:Object.freeze([
      'instruction-id-to-valid-long-64-encoding-discriminators',
      'prefix-and-alias-mode-validity',
      'operand-and-implicit-state-variant-enumeration',
    ]),
  });
}

export function verifyX86CapstoneRegistryEvidence(evidence) {
  if (!evidence || evidence.schemaVersion !== X86_CAPSTONE_REGISTRY_SCHEMA) fail('x86-capstone-registry-schema-drift');
  for (const field of ['firstInstructionId','lastInstructionId','instructionCount','registrySha256']) {
    if (evidence[field] !== X86_CAPSTONE_REGISTRY_EXPECTED[field]) {
      fail('x86-capstone-registry-identity-drift', `${field}:${evidence[field]}`);
    }
  }
  if (evidence.long64EncodingDenominator !== false) fail('x86-capstone-registry-scope-promotion');
  return true;
}
