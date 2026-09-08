import assert from 'node:assert/strict';
import { deriveCanonicalAddressProof } from '../../js/analysis/alias/canonical-address-v2-core.js';

// Issue #5727: proof-grade constants read from multiple metadata sources must
// agree. The old first-success policy adopted whichever source parsed first,
// so source storage priority alone decided the exact absolute address for
// contradictory metadata.

function irWith(valueConstant, nodeConstant) {
  return {
    functionId: 'f',
    values: [
      {
        id: 'addr',
        definitionNodeId: 'c0',
        ...(valueConstant == null ? {} : { metadata: { constant: valueConstant } }),
        machineType: { widthBits: 64 },
      },
    ],
    nodes: [
      {
        id: 'c0',
        kind: 'const',
        outputs: ['addr'],
        ...(nodeConstant == null ? {} : { attributes: { constant: nodeConstant } }),
      },
    ],
    blocks: [],
  };
}

// Contradiction: unknown, never an exact absolute proof.
{
  const proof = deriveCanonicalAddressProof(irWith(0, 4096), 'addr');
  assert.equal(proof.kind, 'unknown');
  assert.equal(proof.reason, 'canonical-address-constant-conflict');
}
{
  const proof = deriveCanonicalAddressProof(irWith(4096, 0), 'addr');
  assert.equal(proof.kind, 'unknown', 'source priority must not decide the exact address');
}

// Agreement still proves the exact constant.
{
  const proof = deriveCanonicalAddressProof(irWith(4096, 4096), 'addr');
  assert.equal(proof.kind, 'absolute');
  assert.equal(proof.address, 4096n);
}

// Single source still proves.
{
  const proof = deriveCanonicalAddressProof(irWith(null, 8), 'addr');
  assert.equal(proof.kind, 'absolute');
  assert.equal(proof.address, 8n);
}
{
  const proof = deriveCanonicalAddressProof(irWith(8, null), 'addr');
  assert.equal(proof.kind, 'absolute');
  assert.equal(proof.address, 8n);
}

// No constant sources: unknown without a conflict reason.
{
  const proof = deriveCanonicalAddressProof(irWith(null, null), 'addr');
  assert.equal(proof.kind, 'unknown');
  assert.notEqual(proof.reason, 'canonical-address-constant-conflict');
}

console.log('issue-5727 conflicting constant sources fail closed: ok');
