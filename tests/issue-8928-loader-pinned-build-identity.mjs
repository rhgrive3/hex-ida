// Issue #8928 regression: the tiny loader's pinned EXPECTED_BUILD must bind the
// runtime bytes it actually executes. A bootstrap authority that echoes the
// pinned top-level buildId (with a correct ECDH key envelope but its own
// manifest identity) used to have an unrelated runtime imported and started as
// if it belonged to the pinned build: the loader checked only
// `bootstrap.buildId` up front and then verified the plaintext against a
// digest supplied by the same remote bootstrap. The loader now requires the
// manifest build identity/AAD/content-hash prefix to match the local pin
// before admission, and re-verifies the executed plaintext digest prefix
// before the runtime module can start.
//
// These scenarios run the real js/userscript/loader.js module (build-time
// placeholders substituted, relative imports rewritten to file URLs, written
// to the scratch directory outside the repository) against a protocol-faithful
// bootstrap authority double; the ECDH/HKDF/AES-GCM/gunzip pipeline is real.
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
const PIN = sha256Hex(utf8(VALID_RUNTIME_SOURCE)).slice(0, 24);

async function gcmEncrypt(key, iv, aad, plaintext) {
  const imported = typeof key === 'uint8array' || key instanceof Uint8Array
    ? await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt'])
    : key;
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, imported, plaintext));
}

/* ------------------------------------------------------------------------- *
 * Protocol-faithful bootstrap authority (mirrors worker-entry.js semantics):
 * the content key is wrapped under an ECDH+HKDF-derived key against the
 * loader-supplied client public key, and the runtime asset is AES-GCM(gzip())
 * keyed by the content key. `forge` lets a scenario perturb exactly the
 * manifest identity dimensions while the rest stays self-consistent.
 * ------------------------------------------------------------------------- */
async function createAuthority({ expectedBuild = PIN, runtimeSource = VALID_RUNTIME_SOURCE, forge, inflateBodyBytes = 0 } = {}) {
  const serverKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const serverPublicKey = await crypto.subtle.exportKey('jwk', serverKeyPair.publicKey);
  const runtimeVersion = '2.0.2322242211';
  const sessionId = b64url(randomBytes(18));
  const salt = randomBytes(16);
  const envelopeIv = randomBytes(12);
  const contentKey = randomBytes(32);
  const contentIv = randomBytes(12);

  const manifest = {
    buildId: expectedBuild,
    runtimeVersion,
    ciphertextHash: '',
    contentHash: sha256Hex(utf8(runtimeSource)),
    iv: b64url(contentIv),
    aad: `hex-runtime:${expectedBuild}:${runtimeVersion}`,
    compression: 'gzip',
    byteLength: 0,
  };
  forge?.(manifest);

  const ciphertext = await gcmEncrypt(contentKey, fromB64url(manifest.iv), utf8(manifest.aad), new Uint8Array(gzipSync(Buffer.from(runtimeSource))));
  manifest.byteLength = ciphertext.byteLength;
  manifest.ciphertextHash = sha256Hex(ciphertext);

  const bootstrap = {
    buildId: expectedBuild,
    expiry: new Date(Date.now() + 60_000).toISOString(),
    sourceCommit: 'f'.repeat(40),
    serverPublicKey,
    keyEnvelope: { salt: b64url(salt), iv: b64url(envelopeIv), ciphertext: '' },
    session: b64url(randomBytes(18)),
    sessionId,
    runtimeLocator: `/_runtime/${expectedBuild}`,
    manifest: { ...manifest },
  };

  let runtimeBytesServed = 0;
  return {
    bootstrap,
    stats: {
      get runtimeBytesServed() { return runtimeBytesServed; },
    },
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

async function runLoader({ expectedBuild = PIN, pinnedBuild = expectedBuild, runtimeSource, forge, inflateBodyBytes = 0 } = {}) {
  delete globalThis.__HEX_8928_STARTED__;
  delete globalThis.__HEX_8928_SOURCE__;
  const authority = await createAuthority({ expectedBuild, runtimeSource, forge, inflateBodyBytes });
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
  globalThis.MutationObserver = function MutationObserverStub() {
    this.observe = () => {};
    this.disconnect = () => {};
  };
  const blobBytes = new WeakMap();
  globalThis.Blob = class BlobDouble {
    constructor(parts) { blobBytes.set(this, parts[0]); }
  };
  URL.createObjectURL = (blob) => `data:text/javascript;base64,${Buffer.from(blobBytes.get(blob)).toString('base64')}`;
  URL.revokeObjectURL = () => {};
  globalThis.fetch = authority.respond;
  globalThis.self = globalThis.top = globalThis;
  try {
    const source = readFileSync(LOADER_PATH, 'utf8')
      .replaceAll("'__HEX_ORIGIN__'", `'${HEX_ORIGIN}'`)
      .replaceAll("'__HEX_LOADER_VERSION__'", "'test-8928'")
      .replaceAll("'__HEX_BUILD_ID__'", `'${pinnedBuild}'`)
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

// 1. Happy path: a pinned loader executes the runtime bound to that pin and
//    forwards the locally proven content digest.
{
  const run = await runLoader({});
  assert.ok(run.started, `valid pinned runtime must boot (failure: ${run.failure})`);
  assert.equal(run.started.buildId, PIN);
  assert.equal(run.started.runtimeContentHash, sha256Hex(utf8(VALID_RUNTIME_SOURCE)));
  assert.equal(run.started.runtimeContentHash.slice(0, 24), PIN);
  assert.equal(run.sourceBytes.byteLength, utf8(VALID_RUNTIME_SOURCE).byteLength, 'the source provider must hand out the real runtime bytes');
}

// 2. #8928 attack: the top-level bootstrap echoes the pin and the key envelope
//    is valid, but the manifest names a different build identity. Rejected
//    before the runtime asset is fetched at all.
{
  const run = await runLoader({ forge: (manifest) => { manifest.buildId = 'attacker-controlled-build-id'; } });
  assert.equal(run.started, null, 'an unbound manifest build identity must never start');
  assert.match(run.failure, /manifest build identity does not match the pinned loader build/i);
  assert.equal(run.authority.stats.runtimeBytesServed, 0, 'rejection must happen before any runtime fetch');
}

// 3. Attack variant: manifest buildId echoes the pin, but the content hash is
//    an unrelated real digest. Rejected on the content-hash pin pre-fetch.
{
  const run = await runLoader({
    forge: (manifest) => { manifest.contentHash = sha256Hex(utf8('export async function startProtectedRuntime(){globalThis.__ATTACKER__=1}')); },
  });
  assert.equal(run.started, null, 'an unrelated manifest content hash must never start');
  assert.match(run.failure, /content hash is not bound to the pinned loader build/i);
  assert.equal(run.authority.stats.runtimeBytesServed, 0);
}

// 4. Attack variant: manifest reports the pinned prefix for both identity and
//    content hash, but ships different runtime bytes. The plaintext digest
//    re-verification must stop it before the module is imported.
{
  const attackerSource = 'export async function startProtectedRuntime(){ globalThis.__HEX_8928_STARTED__ = { attacker: true }; }\n';
  const run = await runLoader({
    runtimeSource: attackerSource,
    forge: (manifest) => { manifest.contentHash = sha256Hex(utf8(attackerSource)); manifest.aad = `hex-runtime:${PIN}:2.0.2322242211`; },
  });
  assert.equal(run.started?.attacker, undefined, 'runtime bytes that hash away from the pin must never start');
  assert.ok(!run.started || run.started.attacker !== true);
  assert.match(run.failure, /content hash is not bound to the pinned loader build|not bound to the pinned/i);
}

// 5. #8927 loader-level integration: a runtime body inflated beyond the exact
//    manifest length is rejected before hashing/decryption and never boots.
{
  const run = await runLoader({ inflateBodyBytes: 4096 });
  assert.equal(run.started, null, 'an oversized runtime body must never boot');
  assert.match(run.failure, /length did not match the bootstrap manifest/i);
}

console.log('issue-8928 pinned build identity regression: ok');
