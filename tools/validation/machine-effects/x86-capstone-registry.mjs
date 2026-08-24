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
const X86_CAPSTONE_REGISTRY_SCOPE = 'capstone-x86-all-modes-instruction-name-registry';
const X86_CAPSTONE_MISSING_AUTHORITY = Object.freeze([
  'instruction-id-to-valid-long-64-encoding-discriminators',
  'prefix-and-alias-mode-validity',
  'operand-and-implicit-state-variant-enumeration',
]);

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
      for (let probe = id + 1; probe <= MAX_REGISTRY_ID; probe++) {
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
    scope:X86_CAPSTONE_REGISTRY_SCOPE,
    firstInstructionId:rows[0].id,
    lastInstructionId:rows.at(-1).id,
    instructionCount:rows.length,
    registrySha256,
    rows:Object.freeze(rows),
    long64EncodingDenominator:false,
    missingAuthority:X86_CAPSTONE_MISSING_AUTHORITY,
  });
}

export function verifyX86CapstoneRegistryEvidence(evidence) {
  if (!evidence || evidence.schemaVersion !== X86_CAPSTONE_REGISTRY_SCHEMA) fail('x86-capstone-registry-schema-drift');
  if (evidence.registryId !== X86_CAPSTONE_REGISTRY_ID) fail('x86-capstone-registry-id-drift');
  if (evidence.scope !== X86_CAPSTONE_REGISTRY_SCOPE) fail('x86-capstone-registry-scope-drift');
  if (!Array.isArray(evidence.rows) || evidence.rows.length === 0) fail('x86-capstone-registry-rows-required');
  if (!Array.isArray(evidence.missingAuthority)
    || JSON.stringify(evidence.missingAuthority) !== JSON.stringify(X86_CAPSTONE_MISSING_AUTHORITY)) {
    fail('x86-capstone-registry-missing-authority-drift');
  }
  for (const [index, row] of evidence.rows.entries()) {
    const expectedId = index + 1;
    if (!row || row.id !== expectedId || typeof row.name !== 'string' || row.name.length === 0) {
      fail('x86-capstone-registry-row-invalid', `${expectedId}`);
    }
  }
  const recomputedSha256 = crypto.createHash('sha256')
    .update(evidence.rows.map(({ id, name }) => `${id}:${name}\n`).join(''))
    .digest('hex');
  if (evidence.registrySha256 !== recomputedSha256) fail('x86-capstone-registry-row-digest-mismatch');
  for (const field of ['firstInstructionId','lastInstructionId','instructionCount','registrySha256']) {
    if (evidence[field] !== X86_CAPSTONE_REGISTRY_EXPECTED[field]) {
      fail('x86-capstone-registry-identity-drift', `${field}:${evidence[field]}`);
    }
  }
  if (evidence.firstInstructionId !== evidence.rows[0].id
    || evidence.lastInstructionId !== evidence.rows.at(-1).id
    || evidence.instructionCount !== evidence.rows.length) {
    fail('x86-capstone-registry-row-count-drift');
  }
  if (evidence.long64EncodingDenominator !== false) fail('x86-capstone-registry-scope-promotion');
  return true;
}
