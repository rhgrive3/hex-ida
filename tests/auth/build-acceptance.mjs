import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { assertStandardGraph, assertPrivilegedGraph, privilegedIdentity, releaseIdentityFor } from '../../scripts/auth-build-policy.mjs';
const root = new URL('../../', import.meta.url);
const meta = async (name) => JSON.parse(await readFile(new URL(`.runtime-build/${name}.metafile.json`, root), 'utf8'));
for (const name of ['standard-runtime', 'standard-parent', 'standard-loader']) {
  const value = await meta(name); assertStandardGraph(value, name);
  console.log(`${name}: ${Object.keys(value.inputs).length} esbuild inputs; no privileged implementation`);
}
const classic = JSON.parse(await readFile(new URL('.runtime-build/classic-source-inventory.json', root), 'utf8'));
assert.equal(classic.kind, 'classic-importScripts-source-inventory');
assertStandardGraph(classic, 'embedded classic sources');
const embedded = (await readdir(new URL('.runtime-build/', root))).filter((name) => /^embedded-worker-.*\.metafile\.json$/.test(name));
assert.ok(embedded.length >= 2, 'both module worker entry graphs must be inspected');
for (const name of embedded) assertStandardGraph(JSON.parse(await readFile(new URL(`.runtime-build/${name}`, root), 'utf8')), name);
console.log(`Embedded assets: ${Object.keys(classic.inputs).length} collected classic inputs, ${embedded.length} esbuild worker graphs`);
for (const kind of ['parent', 'child']) assertPrivilegedGraph(await meta(`privileged-${kind}`), kind);
const { RUNTIME_BUILD } = await import('../../.runtime-build/runtime-secrets.js');
const { PRIVILEGED_BUILD } = await import('../../.runtime-build/privileged-assets.js');
const manifest = privilegedIdentity(RUNTIME_BUILD.manifest.buildId, PRIVILEGED_BUILD.parentSource, PRIVILEGED_BUILD.childSource, PRIVILEGED_BUILD.adminSource);
assert.deepEqual(RUNTIME_BUILD.manifest.privileged, manifest);
assert.equal(PRIVILEGED_BUILD.buildId, manifest.buildId);
assert.equal(PRIVILEGED_BUILD.parentHash, manifest.parentHash);
assert.equal(PRIVILEGED_BUILD.childHash, manifest.childHash);
assert.equal(PRIVILEGED_BUILD.adminHash, manifest.adminHash);
for (const entry of await readdir(new URL('dist/', root), { recursive: true })) {
  assert.doesNotMatch(entry, /(?:privileged|admin|\.map$)/, 'private plaintext must never be a public backing asset');
}
const privatePayloads = [PRIVILEGED_BUILD.parentSource, PRIVILEGED_BUILD.childSource, PRIVILEGED_BUILD.adminSource].map((value) => Buffer.from(value));
for (const file of await publicFiles(fileURLToPath(new URL('dist/', root)))) {
  const bytes = await readFile(file);
  for (const payload of privatePayloads) assert.equal(bytes.includes(payload), false, `private bundle bytes leaked into public asset: ${file}`);
}
const template = await readFile(new URL('userscript/hex.user.template.js', root), 'utf8');
for (const grant of ['getValue', 'setValue', 'deleteValue', 'xmlHttpRequest']) assert.ok(template.includes(`GM.${grant}`));
const digest = (text) => createHash('sha256').update(text).digest('hex');
assert.equal(digest(PRIVILEGED_BUILD.childSource), manifest.childHash);
assert.equal(digest(PRIVILEGED_BUILD.adminSource), manifest.adminHash);
console.log('Privileged source hashes, private backing exclusion, and GM grants: PASS');

// Check the ACTUAL generated release, not just the identity helper's fixtures.
const ciphertext = await readFile(new URL(`dist${RUNTIME_BUILD.manifest.assetPath}`, root));
const key = await webcrypto.subtle.importKey('raw', Buffer.from(RUNTIME_BUILD.contentKey, 'base64url'), 'AES-GCM', false, ['decrypt']);
const compressed = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(RUNTIME_BUILD.manifest.iv, 'base64url'), additionalData: Buffer.from(RUNTIME_BUILD.manifest.aad), tagLength: 128 }, key, ciphertext);
const runtime = gunzipSync(new Uint8Array(compressed));
assert.equal(digest(runtime), RUNTIME_BUILD.manifest.contentHash);
const inputs = [runtime, await readFile(new URL('.runtime-build/loader-input.js', root)), PRIVILEGED_BUILD.parentSource, PRIVILEGED_BUILD.childSource, PRIVILEGED_BUILD.adminSource,
  await readFile(new URL('scripts/auth-build-policy.mjs', root)), await readFile(new URL('scripts/build-userscript.mjs', root)), await readFile(new URL('scripts/userscript-publication.mjs', root))];
const proof = JSON.parse(await readFile(new URL('.runtime-build/release-inputs.json', root), 'utf8'));
const release = JSON.parse(await readFile(new URL('userscript/release-version.json', root), 'utf8'));
assert.deepEqual(proof.digests, inputs.map(digest));
assert.equal(releaseIdentityFor(inputs), release.releaseIdentity);
assert.equal(proof.releaseIdentity, release.releaseIdentity);
for (const index of [2, 3, 4]) {
  const changed = [...inputs]; changed[index] += '\n/* acceptance-only changed private source */';
  assert.notEqual(releaseIdentityFor(changed), release.releaseIdentity);
}
assert.equal(releaseIdentityFor(inputs), releaseIdentityFor(inputs), 'identical emitted inputs have identical release identity');
console.log('Actual encrypted runtime / private bytes / committed release binding and private-only change sensitivity: PASS');

async function publicFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await publicFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
