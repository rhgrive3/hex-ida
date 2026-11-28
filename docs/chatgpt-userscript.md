# Hex on ChatGPT Web

Hex runs on `https://chatgpt.com/*` as a thin userscript loader
(`userscript/hex.user.template.js`). The loader does not contain the Hex
application, analysis engines, agent tools, workers, or CSS. It bootstraps a
protected, versioned runtime and keeps all binary-analysis hot paths in browser
memory.

## Runtime architecture

```text
chatgpt.com
  └─ thin userscript loader (userscript/hex.user.template.js)
      └─ POST /runtime/bootstrap (nonce + build + ECDH public key)
          └─ signed, short-lived, one-use runtime session + wrapped key
              └─ encrypted/minified runtime → WebCrypto verify/decrypt → Blob URL
                  └─ canonical Hex UI / AIRuntime / local workers
                      ├─ ChatGPT Web → visible DOM adapter
                      ├─ Worker-backed provider → server-held API credentials
                      └─ Admin-only privileged bundles → fetched only after D1 Admin check
```

The build (`npm run userscript:build`, powered by
`scripts/build-userscript.mjs`) resolves the canonical CSS import graph,
bundles and minifies the application with identifier mangling, embeds the local
Worker/WASM graph, gzip-compresses it, and encrypts it with AES-256-GCM. Source
maps are disabled. The content key and signing key are generated into
`.runtime-build/runtime-secrets.js`, outside `dist/`, and bundled into the
Cloudflare Worker rather than the public loader or static assets.

Client-side decryption cannot make source cryptographically secret from the
person running the client. The protection goal is narrower: raw source is not
deployed, casual/direct inspection is prevented, bulk scraping costs more, and
accidental repository exposure is blocked. Admin-only Dev Agent parent/child
bundles (`js/auth/privileged/parent-entry.js`, `child-entry.js`) and the Admin
site (`js/auth/admin-app.js`) are excluded from Standard graphs and served only
after server-side D1 Admin verification.

## Release metadata and userscript grants

The committed release metadata lives in `userscript/release-version.json`
(`serial`, `releaseIdentity`, `buildId`) and is baked into
`userscript/hex.user.template.js` on every canonical build:

- `@match https://chatgpt.com/*`
- `@run-at document-start`
- `@inject-into content`
- `@grant GM.xmlHttpRequest`, `GM.getValue`, `GM.setValue`, `GM.deleteValue`
- `@connect ida.rhgrive.workers.dev`, `api.openjev.sh`
- `@updateURL __HEX_ORIGIN__/hex.meta.js`
- `@downloadURL __HEX_ORIGIN__/hex.user.js`

Install from `https://ida.rhgrive.workers.dev/hex.user.js`.

## Deployment boundary

`wrangler.jsonc` publishes only `dist/`; the repository root is never a Static
Assets directory. `assets.run_worker_first` is `true` for every route. Raw
`/js/*`, `/css/*`, `/scripts/*`, `/tests/*`, configuration files, the userscript
template, legacy `/userscript-assets/*`, and private ciphertext/privileged
paths return 404 unless reached through the authenticated runtime/auth handler.

```sh
npm ci
npm run userscript:test
npm run deploy:production
```

`npm run deploy:production` (`scripts/deploy-production.mjs`) runs
`scripts/validate-auth-config.mjs` against the repository's `wrangler.jsonc`
before invoking the pinned Wrangler binary directly, failing closed if the
`AUTH_DB` D1 UUID, `assets.run_worker_first`, `./dist`, or `./worker-entry.js`
checks fail. Do not bypass `npm run deploy:production` with ad-hoc deploy
commands.

Wrangler's `build.command` runs:

```sh
npm run userscript:build && node scripts/write-deployment-identity.mjs
```

The build produces:

- `dist/index.html` and the standalone bootstrap loader;
- `dist/userscript/hex.user.template.js`, served as `/hex.user.js` or metadata-only `/hex.meta.js`;
- `dist/.runtime/runtime.<buildId>.bin`, reachable only through a valid one-use session;
- `.runtime-build/runtime-secrets.js`, a server bundle input that is never deployed as a static asset;
- `userscript/hex.user.template.js` and `userscript/release-version.json` (committed release identity).

## Bootstrap and integrity

The loader creates an ephemeral P-256 ECDH key pair and submits a nonce, loader
version, expected `buildId`, request ID, session identity, and public JWK to
`POST /runtime/bootstrap`. The `RuntimeBootstrap` Durable Object rejects reused
nonces. The Worker returns a short-lived HMAC-signed session, immutable
manifest, protected locator (`/_runtime/<buildId>`), ephemeral server public
key, and an ECDH/HKDF-derived AES-GCM key envelope. The ciphertext route
verifies signature, expiry, build, and request identity, and consumes the
session once.

The loader validates the pinned `buildId`, full 64-hex content hash, runtime
version, compression format (`gzip`), canonical AAD, byte length, and manifest
digest before decrypting. It verifies ciphertext SHA-256, unwraps the content
key, performs authenticated AES-GCM decryption with manifest AAD, decompresses
gzip within a bounded byte budget, verifies plaintext SHA-256 against the
pinned hash, and executes through a temporary Blob URL. It never falls back to
plaintext and never stores decrypted runtime bytes in `localStorage`,
`IndexedDB`, or Cache Storage. Buffers are zeroed and the Blob URL is revoked
after module evaluation.

Origin and Referer checks are supplementary controls only; session signatures,
expiry, build binding, ECDH key possession, and replay state form the
authorization boundary.

## ChatGPT DOM provider

Selectors live in `js/userscript/chatgpt-selectors.js`. `ChatGPTDOMAdapter`,
`ChatGPTConversationRouter`, `ChatGPTModelController`, and
`ChatGPTTurnController` separately own DOM access, Hex-session/ChatGPT-URL
routing, dynamic model selection, and turn completion.

For the normal AI bridge, one ChatGPT conversation DOM permits one in-flight
Hex request at a time. Completion requires a new assistant-turn identity, a
matching submitted user turn, non-empty stable content, a DOM quiet period, and
a stopped generating state. Errors, cancellation, navigation, multiple new
turns, manual interference, and timeout are explicit failures; an old assistant
turn is never returned.

This per-conversation rule is separate from the Admin-only **Dev Agent Worker
Pool**, which may host up to six same-origin hidden Worker iframes inside one
Supervisor tab, each owning its own ChatGPT conversation/turn controller and
obeying the one-in-flight rule per Worker. See `improving-agent.md` for the
canonical Dev Agent topology.

Available model/reasoning choices are discovered from the visible picker.
Canonical IDs such as `chatgpt-web/sol`, `chatgpt-web/terra`, and
`chatgpt-web/luna` are exposed only when matching UI options are observed. A
requested model and reasoning level are re-read after selection; mismatch fails
closed without fallback.

Each Hex `conversationId` binds to an AIRuntime session, and each AIRuntime/Hex
session key binds to a ChatGPT `/c/<id>` URL. Switching A → B → A restores both
layers independently. ChatGPT history provides reasoning continuity only; Hex
EvidenceStore and deterministic tools remain truth.

The bridge never reads cookies or tokens, never calls undocumented ChatGPT
APIs, and never implements Cloudflare/Sentinel/Turnstile bypasses.

## Host UI isolation

The userscript and standalone site share the same application and CSS. In the
userscript, the fully resolved stylesheet is wrapped in
`@scope (#hex-userscript-host)`. `uiRoot()` owns product readiness,
AI/keyboard/sheet state, size classes, theme, language, and CSS variables on
the Hex host instead of `chatgpt.com`'s `<html>`. Provider/model controls
belong to the AI panel contract; there is no userscript-only title-bar picker.
