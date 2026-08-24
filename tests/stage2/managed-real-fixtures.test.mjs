import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeObservation } from '../../js/runtime/authority.js';
import { validateManagedRuntimeObservation } from '../../js/managed/runtime-binding.js';
import { createManagedRuntimeBinding } from '../../js/managed/runtime-binding.js';
import { CilFrontend } from '../../js/managed/cil/frontend.js';
import { DexFrontend } from '../../js/managed/dex/frontend.js';
import { JvmFrontend } from '../../js/managed/jvm/frontend.js';
import { WasmFrontend } from '../../js/managed/wasm/frontend.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(root, 'fixtures', 'managed-real');
const manifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'manifest.json'), 'utf8'));
const frontends = Object.freeze({
  wasm: WasmFrontend,
  dex: DexFrontend,
  cil: CilFrontend,
  jvm: JvmFrontend,
});

assert.equal(manifest.schemaVersion, 'hex-stage2-managed-real-fixtures/v1');
assert.deepEqual(manifest.fixtures.map((fixture) => fixture.frontendId), ['wasm', 'dex', 'cil', 'jvm']);

for (const fixture of manifest.fixtures) {
  const Frontend = frontends[fixture.frontendId];
  assert.ok(Frontend, `fixture frontend is locally implemented: ${fixture.frontendId}`);
  assert.ok(fs.statSync(path.join(fixtureRoot, fixture.source)).isFile(), `${fixture.id}: pinned compiler source exists`);
  if (fixture.project) {
    assert.ok(fs.statSync(path.join(fixtureRoot, fixture.project)).isFile(), `${fixture.id}: pinned compiler project exists`);
  }
  const filePath = path.join(fixtureRoot, fixture.path);
  const bytes = new Uint8Array(fs.readFileSync(filePath));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(bytes.length, fixture.size, `${fixture.id}: byte size is pinned`);
  assert.equal(sha256, fixture.sha256, `${fixture.id}: SHA-256 identity is pinned`);

  const frontend = new Frontend();
  const probe = await frontend.probe(bytes);
  assert.equal(probe.supported, true, `${fixture.id}: parser probe`);
  const image = await frontend.open(bytes, { binaryId: `sha256:${fixture.sha256}` });
  assert.equal(image.imageId, `managed-image:sha256:${fixture.sha256}`, `${fixture.id}: parser identity uses fixture digest`);
  assert.equal(image.rawBytes.length, fixture.size, `${fixture.id}: parser retained exact bytes`);

  const modules = [];
  for await (const module of frontend.enumerateModules(image)) modules.push(module);
  assert.equal(modules.length, 1, `${fixture.id}: one module`);
  assert.equal(modules[0].id, image.moduleId, `${fixture.id}: module identity is parser-owned`);

  const types = [];
  for await (const type of frontend.enumerateTypes(image)) types.push(type);
  assert.ok(types.length >= 1, `${fixture.id}: compiled type is enumerable`);
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  assert.ok(methods.length >= 1, `${fixture.id}: compiled method is enumerable`);

  const selectedMethod = fixture.frontendId === 'jvm' || fixture.frontendId === 'dex'
    ? methods.find((method) => method.name === 'add')
    : methods[0];
  assert.ok(selectedMethod, `${fixture.id}: deterministic decodable method selection`);
  const decoded = await frontend.decodeMethod(selectedMethod, { image });
  assert.ok(decoded.bundles.length > 0, `${fixture.id}: compiled method decodes`);
  const validation = await frontend.validateMethod(decoded, { image });
  assert.equal(validation.status, 'valid', `${fixture.id}: compiled method validates`);

  // The runtime binding is deliberately local and fixture-scoped: it proves
  // that a provider cannot detach runtime observations from this exact parser
  // module and SHA-256 identity. It is not a claim of external debugger proof.
  const binding = createManagedRuntimeBinding({
    frontendId: fixture.frontendId,
    runtimeImplementation: `local-managed-fixture-provider:${fixture.frontendId}`,
    runtimeVersion: fixture.compiler,
    staticModuleIdentity: image.moduleId,
    runtimeModuleIdentity: image.moduleId,
    providerIdentity: `local-managed-fixture-provider:${fixture.id}`,
    runtimeInstanceIdentity: `fixture-runtime:${fixture.sha256}`,
    targetIdentity: `fixture-target:${fixture.sha256}`,
    binaryIdentity: `sha256:${fixture.sha256}`,
    buildIdentity: `managed-fixture-build:sha256:${fixture.sha256}`,
    loadMappingIdentity: `fixture-mapping:${fixture.sha256}`,
    sessionIdentity: `fixture-session:${fixture.sha256}`,
    capabilityVersion: 'managed-fixture-provider/v1',
    maxThreads: 2,
    maxFramesPerThread: 2,
    maxLocalsPerFrame: 8,
    maxOperandStack: 8,
  });
  const observation = createRuntimeObservation({
    binding: binding.runtime,
    sequence: 0,
    observedAt: '2026-08-23T00:00:00Z',
    kind: 'managed-fixture-method',
    payload: { moduleIdentity: image.moduleId, methodId: selectedMethod.id, binarySha256: fixture.sha256 },
  });
  assert.equal(validateManagedRuntimeObservation(binding, observation).ok, true, `${fixture.id}: provider observation binds to parser module`);

  const wrongProvider = { ...observation, providerIdentity: 'local-managed-fixture-provider:wrong' };
  assert.equal(validateManagedRuntimeObservation(binding, wrongProvider).reason, 'runtime-observation-providerIdentity-mismatch', `${fixture.id}: provider identity negative`);
  const wrongModuleObservation = createRuntimeObservation({
    binding: binding.runtime,
    sequence: 1,
    observedAt: '2026-08-23T00:00:01Z',
    kind: 'managed-fixture-method',
    payload: { moduleIdentity: 'managed-mod:wrong', methodId: selectedMethod.id, binarySha256: fixture.sha256 },
  });
  assert.equal(validateManagedRuntimeObservation(binding, wrongModuleObservation).reason, 'managed-runtime-observation-module-mismatch', `${fixture.id}: module identity negative`);

  const wrongDigest = new Uint8Array(bytes);
  wrongDigest[wrongDigest.length - 1] ^= 0x01;
  assert.notEqual(createHash('sha256').update(wrongDigest).digest('hex'), fixture.sha256, `${fixture.id}: byte mutation changes identity`);
  const invalid = new Uint8Array(64);
  assert.equal((await frontend.probe(invalid)).supported, false, `${fixture.id}: invalid fixture is rejected by probe`);
  await assert.rejects(() => frontend.open(invalid), `${fixture.id}: invalid fixture is rejected by parser`);
}

console.log('[stage2] deterministic real managed fixtures passed for wasm/dex/cil/jvm');
