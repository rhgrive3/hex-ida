import assert from 'node:assert/strict';
import {
  defaultRootEntityId,
  deriveCanonicalAddressProof,
  normalizeRootIdentity,
} from '../js/analysis/alias/canonical-address-v2-core.js';

const validVariable = { key: 'x0', kind: 'register', scope: 'function' };
const validIdentity = normalizeRootIdentity(validVariable, 'fn-main');
assert.deepEqual(validIdentity, {
  kind: 'semantic-state-root',
  functionId: 'fn-main',
  variable: { key: 'x0', kind: 'register', scope: 'function' },
});
assert.equal(
  defaultRootEntityId(validIdentity),
  'entity_memory_root_b4501fb3ae21ca8a8070996881ef22e5',
  'valid string identity digest must remain stable',
);

assert.equal(normalizeRootIdentity(validVariable, { source: 'A' }), null);
assert.equal(normalizeRootIdentity(validVariable, { source: 'B' }), null);
assert.equal(normalizeRootIdentity({ ...validVariable, key: { register: 'x0' } }, 'fn-main'), null);
assert.equal(defaultRootEntityId(null), null, 'malformed roots must not mint entity ids');

function entryIr(overrides = {}) {
  return {
    functionId: 'fn-main',
    values: [{
      id: 'v-entry',
      kind: 'entry',
      variableKey: 'x0',
      machineType: { widthBits: 64 },
    }],
    nodes: [],
    blocks: [],
    ...overrides,
  };
}

const validProof = deriveCanonicalAddressProof(entryIr(), 'v-entry');
assert.equal(validProof.kind, 'rooted');
assert.equal(validProof.rootEntityId, 'entity_memory_root_82cc8350d9618ade78977a06a02c90ab');

for (const badFunctionId of [{ source: 'A' }, ['fn-main'], 7, true]) {
  const proof = deriveCanonicalAddressProof(entryIr({ functionId: badFunctionId }), 'v-entry');
  assert.equal(proof.kind, 'unknown');
  assert.match(proof.reason, /identity-invalid/);
}

{
  const proof = deriveCanonicalAddressProof({
    ...entryIr(),
    values: [{ id: { source: 'object-id' }, kind: 'entry', variableKey: 'x0', machineType: { widthBits: 64 } }],
  }, 'v-entry');
  assert.equal(proof.kind, 'unknown');
  assert.equal(proof.reason, 'canonical-address-identity-invalid');
}

{
  const proof = deriveCanonicalAddressProof(entryIr(), { value: 'v-entry' });
  assert.equal(proof.kind, 'unknown');
  assert.equal(proof.reason, 'canonical-address-identity-invalid');
}

function descriptorIr(canonicalRoot) {
  return {
    functionId: 'fn-main',
    values: [{
      id: 'v-root',
      kind: 'computed',
      machineType: { widthBits: 64 },
      definitionNodeId: 'n-root',
      metadata: { canonicalRoot },
    }],
    nodes: [{ id: 'n-root', kind: 'copy', inputs: [] }],
    blocks: [],
  };
}

{
  const proof = deriveCanonicalAddressProof(descriptorIr({
    kind: 'rooted-object',
    rootEntityId: ' entity_root_valid ',
    rootIdentity: { kind: 'fixture-root', id: 'root' },
    baseOffset: 8,
    addressSpace: 'memory',
    linearOffsets: true,
  }), 'v-root');
  assert.equal(proof.kind, 'rooted');
  assert.equal(proof.rootEntityId, 'entity_root_valid ');
  assert.equal(proof.offset, 8n);
}

for (const rootEntityId of [{
 id: 'A' }, ['entity'], 1, false]) {
  const proof = deriveCanonicalAddressProof(descriptorIr(kind: 'rooted-object', rootEntityId, baseOffset: 0, addressSpace: 'memory' }), 'v-root');
  assert.equal(proof.kind, 'unknown');
  assert.equal(proof.reason, 'canonical-root-descriptor-invalid');
}

{
  let request = null;
  const proof = deriveCanonicalAddressProof(entryIr(), 'v-entry', { rootDescriptorProvider(value) { request = value; return { kind: 'rooted-object', rootEntityId: { id: 'bad' }, baseOffset: 0 }; } });
  assert.equal(request.functionId, 'fn-main');
  assert.equal(request.valueId, 'v-entry');
  assert.equal(proof.kind, 'unknown');
  assert.equal(proof.reason, 'canonical-root-descriptor-invalid');
}

console.log('canonical-address-v2 root identity validation: PASS');
