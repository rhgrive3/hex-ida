// Issue #8928 regression: the tiny loader must locally pin the full runtime
// content digest and the deterministic execution-relevant release manifest.
// Remote bootstrap/ECDH/AES-GCM authority is transport authority, not release
// identity authority.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const LOADER_PATH = fileURLToPath(new URL('../js/userscript/loader.js', import.meta.url));
const LOADER_DIR = LOADER_PATH.slice(0, LOADER_PATH.lastIndexOf('/'));
const HEX_ORIGIN = 'https://hex.test';
const LOADER_VERSION = '2.0.2322242211';
const RUNTIME_VERSION = `2.${LOADER_VERSION}`;

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const utf8 = (value) => new TextEncoder().encode(value);
const b64url = (bytes) => Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
const fromB64url = (value) => new Uint8Array(Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64'));
const randomBytes = (size) => globalThis.crypto.getRandomValues(new Uint8Array(size));

const VALID_RUNTIME_SOURCE = [
  'export async function startProtectedRuntime(options) {',
  '  globalThis.__HEX_8928_STARTED__ = { buildId: options.buildId, runtimeContentHash: options.runtimeContentHash };',
  '  globalThis.__HEX_8928_SOURCE__ = new Uint8Array(options.runtimeSourceProvider());',
  '}',
].join('\n');
const FULL_PIN = sha256Hex(utf8(VALID_RUNTIME_SOURCE));
const PIN = FULL_PIN.slice(0, 24);
const RUNTIME_LOCATOR = `/_runtime/${PIN}`;
const EXPECTED_RUNTIME_BYTES = gzipSync(Buffer.from(VALID_RUNTIME_SOURCE)).byteLength + 16; // AES-GCM tag

function releaseManifestHash({
  buildId = PIN,
  runtimeVersion = RUNTIME_VERSION,
  contentHash = FULL_PIN,
  compression = 'gzip',
  runtimeLocator = RUNTIME_LOCATOR,
  byteLength = EXPECTED_RUNTIME_BYTES,
} = {}) {
  return sha256Hex(Buffer.from(JSON.stringify({ buildId, runtimeVersion, contentHash, compression, runtimeLocator, byteLength }), 'utf8'));
}

async function gcmEncrypt(key, iv, aad, plaintext) {
  const imported = key instanceof Uint8Array
    ? await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt'])
    : key;
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, imported, plaintext));
}

async function createAuthority({ expectedBuild = PIN, runtimeSource = VALID_RUNTIME_SOURCE, forgeManifest, forgeBootstrap, inflateBodyBytes = 0 } = {}) {
  const serverKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const serverPublicKey = await crypto.subtle.exportKey('jwk', serverKeyPair.publicKey);
  const sessionId = b64url(randomBytes(18));
  const salt = randomBytes(16);
  const envelopeIv = randomBytes(12);
  const contentKey = randomBytes(32);
  const contentIv = randomBytes(12);
  const runtimeVersion = RUNTIME_VERSION;
  const aad = `hex-runtime:${expectedBuild}:${runtimeVersion}`;
  const ciphertext = await gcmEncrypt(contentKey, contentIv, utf8(aad), new Uint8Array(gzipSync(Buffer.from(runtimeSource))));

  const manifest = {
    buildId: expectedBuild,
    runtimeVersion,
    ciphertextHash: sha256Hex(ciphertext),
    contentHash: sha256Hex(utf8(runtimeSource)),
    iv: b64url(contentIv),
    aad,
    compression: 'gzip',
    byteLength: ciphertext.byteLength,
  };
  forgeManifest?.(manifest);

  const bootstrap = {
    buildId: expectedBuild,
    expiry: new Date(Date.now() + 60_000).toISOString(),
    sourceCommit: 'f'.repeat(40),
    serverPublicKey,
    keyEnvelope: { salt: b64url(salt), iv: b64url(envelopeIv), ciphertext: '' },
    session: b64url(randomBytes(18)),
    sessionId,
    runtimeLocator: `/_runtime/${expectedBuild}`,
    manifest,
  };
  forgeBootstrap?.(bootstrap);

  let runtimeBytesServed = 0;
  return {
    bootstrap,
    ciphertext,
    stats: { get runtimeBytesServed() { return runtimeBytesServed; } },
    async respond(url, init = {}) {
      const target = String(url);
      if (target.includes('/runtime/bootstrap')) {
        const clientPublicKey = await crypto.subtle.importKey('jwk', JSON.parse(init.body).clientPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
        const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPublicKey }, serverKeyPair.privateKey, 256);
        const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
        const wrappingKey = await crypto.subtle.deriveKey(
          { name: 'HKDF', hash: 'SHA-256', salt, info: utf8(`hex-runtime-wrap:${bootstrap.buildId}`) },
          hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
        );
        bootstrap.keyEnvelope.ciphertext = b64url(await gcmEncrypt(
          wrappingKey, envelopeIv, utf8(`${bootstrap.buildId}:${sessionId}`), contentKey,
        ));
        const json = utf8(JSON.stringify(bootstrap));
        return boundedResponse(200, json, { 'content-length': String(json.byteLength), 'content-type': 'application/json' });
      }
      if (target.includes('/_runtime/')) {
        runtimeBytesServed += ciphertext.byteLength + inflateBodyBytes;
        const served = inflateBodyBytes > 0
          ? new Uint8Array([...ciphertext, ...new Uint8Array(inflateBodyBytes)])
          : ciphertext;
        return boundedResponse(200, served, { 'content-length': String(ciphertext.byteLength) });
      }
      throw new Error(`unexpected fetch ${target}`);
    },
  };
}

function boundedResponse(status, bytes, headers) {
  let sent = false;
  return {
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    body: new ReadableStream({ pull(controller) { if (sent) { controller.close(); return; } sent = true; controller.enqueue(bytes); } }),
    async arrayBuffer() { throw new Error('arrayBuffer() must not be used by the bounded reader'); },
  };
}

const scratch = await mkdtemp(join(tmpdir(), 'issue-8928-'));

async function runLoader({
  expectedBuild = PIN,
  pinnedBuild = PIN,
  pinnedContentHash = FULL_PIN,
  pinnedRuntimeVersion = RUNTIME_VERSION,
  pinnedRuntimeBytes = EXPECTED_RUNTIME_BYTES,
  pinnedRuntimeLocator = RUNTIME_LOCATOR,
  pinnedReleaseManifestHash = releaseManifestHash(),
  runtimeSource,
  forgeManifest,
  forgeBootstrap,
  inflateBodyBytes = 0,
} = {}) {
  delete globalThis.__HEX_8928_STARTED__;
  delete globalThis.__HEX_8928_SOURCE__;
  const authority = await createAuthority({ expectedBuild, runtimeSource, forgeManifest, forgeBootstrap, inflateBodyBytes });
  const created = [];
  const saved = {
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
    fetch: globalThis.fetch,
    self: globalThis.self,
    top: globalThis.top,
    Blob: globalThis.Blob,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };
  globalThis.document = {
    readyState: 'complete',
    documentElement: { append: (node) => created.push(node) },
    addEventListener() {},
    createElement: () => ({ id: '', style: {}, dataset: {}, textContent: '', title: '', remove() {} }),
    getElementById: (id) => created.find((node) => node.id === id) ?? null,
    querySelectorAll: () => [],
  };
  globalThis.MutationObserver = function MutationObserverStub() { this.observe = () => {}; this.disconnect = () => {}; };
  const blobBytes = new WeakMap();
  globalThis.Blob = class BlobDouble { constructor(parts) { blobBytes.set(this, parts[0]); } };
  URL.createObjectURL = (blob) => `data:text/javascript;base64,${Buffer.from(blobBytes.get(blob)).toString('base64')}`;
  URL.revokeObjectURL = () => {};
  globalThis.fetch = authority.respond;
  globalThis.self = globalThis.top = globalThis;
  try {
    const source = readFileSync(LOADER_PATH, 'utf8')
      .replaceAll("'__HEX_ORIGIN__'", `'${HEX_ORIGIN}'`)
      .replaceAll("'__HEX_LOADER_VERSION__'", `'${LOADER_VERSION}'`)
      .replaceAll("'__HEX_BUILD_ID__'", `'${pinnedBuild}'`)
      .replaceAll("'__HEX_CONTENT_HASH__'", `'${pinnedContentHash}'`)
      .replaceAll("'__HEX_RUNTIME_VERSION__'", `'${pinnedRuntimeVersion}'`)
      .replaceAll("'__HEX_RUNTIME_BYTE_LENGTH__'", `'${pinnedRuntimeBytes}'`)
      .replaceAll("'__HEX_RUNTIME_LOCATOR__'", `'${pinnedRuntimeLocator}'`)
      .replaceAll("'__HEX_RELEASE_MANIFEST_HASH__'", `'${pinnedReleaseManifestHash}'`)
      .replace(/from '\.\/([a-z0-9-]+\.js)'/g, (_all, file) => `from '${pathToFileURL(join(LOADER_DIR, file)).href}'`);
    const entry = join(scratch, `loader-${Math.random().toString(36).slice(2)}.mjs`);
    await writeFile(entry, source);
    await import(pathToFileURL(entry).href);
    await waitFor(() => globalThis.__HEX_8928_STARTED__ || created.some((node) => node.title), 20_000);
    return {
      started: globalThis.__HEX_8928_STARTED__ ?? null,
      sourceBytes: globalThis.__HEX_8928_SOURCE__ ?? null,
      failure: created.map((node) => node.title || '').filter(Boolean).join('\n'),
      authority,
    };
  } finally {
    Object.assign(globalThis, {
      document: saved.document,
      MutationObserver: saved.MutationObserver,
      fetch: saved.fetch,
      self: saved.self,
      top: saved.top,
      Blob: saved.Blob,
    });
    URL.createObjectURL = saved.createObjectURL;
    URL.revokeObjectURL = saved.revokeObjectURL;
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

// 1. Happy path: the locally pinned FULL digest is what reaches the runtime.
{
  const run = await runLoader({});
  assert.ok(run.started, `valid pinned runtime must boot (failure: ${run.failure})`);
  assert.equal(run.started.buildId, PIN);
  assert.equal(run.started.runtimeContentHash, FULL_PIN);
  assert.equal(run.sourceBytes.byteLength, utf8(VALID_RUNTIME_SOURCE).byteLength);
}

// 2. Outer/inner build identity mismatch is rejected before runtime fetch.
{
  const run = await runLoader({ forgeManifest: (manifest) => { manifest.buildId = 'attacker-controlled-build-id'; } });
  assert.equal(run.started, null);
  assert.match(run.failure, /manifest build identity does not match/i);
  assert.equal(run.authority.stats.runtimeBytesServed, 0);
}

// 3. A self-consistent remote digest for different executable code is rejected
// against the loader's FULL local SHA, not merely the 96-bit build prefix.
{
  const attackerSource = VALID_RUNTIME_SOURCE.replace('runtimeContentHash', 'runtimeContentHasx'); // one byte, same length
  const run = await runLoader({ runtimeSource: attackerSource });
  assert.equal(run.started, null);
  assert.match(run.failure, /full local runtime pin/i);
  assert.equal(run.authority.stats.runtimeBytesServed, 0, 'remote code identity must be rejected before runtime fetch');
}

// 4. Even if a hostile manifest LIES with the genuine pinned content hash and
// all other pinned release fields, different plaintext dies on the post-decrypt
// exact full digest before Blob creation/import.
{
  const attackerSource = VALID_RUNTIME_SOURCE.replace('runtimeContentHash', 'runtimeContentHasx');
  const attackerBytes = gzipSync(Buffer.from(attackerSource)).byteLength + 16;
  const pinnedHash = releaseManifestHash({ byteLength: attackerBytes });
  const run = await runLoader({
    runtimeSource: attackerSource,
    pinnedRuntimeBytes: attackerBytes,
    pinnedReleaseManifestHash: pinnedHash,
    forgeManifest: (manifest) => {
      manifest.contentHash = FULL_PIN;
      manifest.byteLength = attackerBytes;
    },
  });
  assert.equal(run.started, null);
  assert.match(run.failure, /integrity verification failed/i);
}

// 5. Non-canonical full content hashes fail before transport.
{
  const run = await runLoader({ forgeManifest: (manifest) => { manifest.contentHash = FULL_PIN.toUpperCase(); } });
  assert.equal(run.started, null);
  assert.match(run.failure, /full local runtime pin/i);
  assert.equal(run.authority.stats.runtimeBytesServed, 0);
}

// 6. runtimeVersion is part of the pinned release identity.
{
  const run = await runLoader({ forgeManifest: (manifest) => { manifest.runtimeVersion = '2.0.1'; } });
  assert.equal(run.started, null);
  assert.match(run.failure, /version does not match the pinned runtime version/i);
  assert.equal(run.authority.stats.runtimeBytesServed, 0);
}

// 7. compression is locally pinned, not remote policy.
{
  const run = await runLoader({ forgeManifest: (manifest) => { manifest.compression = 'br'; } });
  assert.equal(run.started, null);
  assert.match(run.failure, /compression format does not match the pinned release identity/i);
  assert.equal(run.authority.stats.runtimeBytesServed, 0);
}

// 8. expected ciphertext length is part of the deterministic release identity.
{
  const run = await runLoader({ forgeManifest: (manifest) => { manifest.byteLength += 1; } });
  assert.equal(run.started, null);
  assert.match(run.failure, /byte length does not match the pinned release identity/i);
  assert.equal(run.authority.stats.runtimeBytesServed, 0);
}

// 9. Runtime locator/build route cannot be rebound by the bootstrap authority.
{
  const run = await runLoader({ forgeBootstrap: (bootstrap) => { bootstrap.runtimeLocator = '/_runtime/attacker'; } });
  assert.equal(run.started, null);
  assert.match(run.failure, /locator does not match the pinned release identity/i);
  assert.equal(run.authority.stats.runtimeBytesServed, 0);
}

// 10. AAD must bind the exact pinned build + runtime version.
{
  const run = await runLoader({ forgeManifest: (manifest) => { manifest.aad = `hex-runtime:${PIN}:2.0.attacker`; } });
  assert.equal(run.started, null);
  assert.match(run.failure, /AAD is not canonical/i);
  assert.equal(run.authority.stats.runtimeBytesServed, 0);
}

// 11. The release-manifest digest itself is a local immutable pin.
{
  const run = await runLoader({ pinnedReleaseManifestHash: '0'.repeat(64) });
  assert.equal(run.started, null);
  assert.match(run.failure, /release manifest does not match the installed loader pin/i);
  assert.equal(run.authority.stats.runtimeBytesServed, 0);
}

// 12. #8927 integration remains: bytes beyond exact manifest length fail closed.
{
  const run = await runLoader({ inflateBodyBytes: 4096 });
  assert.equal(run.started, null);
  assert.match(run.failure, /length did not match the bootstrap manifest/i);
}

console.log('issue-8928 full pinned release identity regression: ok');