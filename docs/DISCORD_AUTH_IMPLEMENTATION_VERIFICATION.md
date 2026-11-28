# Discord Auth Implementation & Verification Reference

## Architecture summary

Hex implements Discord OAuth2 identity (`identify` scope only), D1-backed role
and enabled-state authority (`free` / `vip` / `admin`), Admin management UI,
and Admin-only privileged source delivery across:

- **Server (`js/auth/server/`):** `router.js`, `oauth.js`, `repository.js`,
  `ai-capability.js`, `admin-site.js`, `primitives.js`
- **Client & RPC (`js/auth/`):** `client.js`, `rpc.js`, `capabilities.js`,
  `runtime.js`, `runtime-context.js`, `transport.js`, `userscript-login.js`,
  `assistant-host.js`, `extension-loader.js`
- **Privileged entries:** `js/auth/privileged/parent-entry.js`,
  `js/auth/privileged/child-entry.js`, `js/auth/admin-app.js`
- **Database schema (`migrations/auth/`):** `0001_auth.sql` (`users`,
  `sessions`, `oauth_transactions`, append-only `audit_log`),
  `0002_oauth_transaction_consumed.sql` (`oauth_consumed_at` index)
- **Worker & deploy guards:** `worker-entry.js`, `wrangler.jsonc`,
  `scripts/validate-auth-config.mjs`, `scripts/deploy-production.mjs`

## Security invariants

1. **Identity vs. authority separation:** Discord User ID is the identity key;
   Discord guild roles/membership are never consulted. D1 `free` / `vip` /
   `admin` plus `enabled` state is the sole role authority, re-read on
   security-sensitive requests.
2. **Fail-closed owner bootstrap:** `HEX_OWNER_DISCORD_ID` is required and
   validated as a Discord snowflake before repository creation. Missing or
   malformed owner configuration returns `503 auth-not-configured` while
   keeping non-auth Standard routes available.
3. **Default deny in Dev provider:** `DenyAllAdminProvider`
   (`js/ai/dev/auth/admin-provider.js`) is the fail-closed default when no
   authenticated provider is wired; explicit `canUseDevAgent` and
   `canUseDevYolo` capabilities are preserved independently rather than
   collapsed into a single Admin boolean.
4. **Session & token hygiene:** Web and userscript session tokens are random
   256-bit values stored in D1 as SHA-256 digests only. Discord access tokens
   are never persisted or logged. Web sessions use `__Host-hex_session`
   (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`) plus exact same-origin
   `Origin` and session-bound CSRF tokens for mutations.
5. **Userscript transport & pairing isolation:** Userscript Bearer tokens live
   only in GM private storage (`GM.getValue` / `GM.setValue` /
   `GM.deleteValue`). Auth endpoints reject cross-origin browser CORS preflight
   from ChatGPT page JavaScript while remaining reachable via
   `GM.xmlHttpRequest`. Pairing requires transaction ID + parent poll secret +
   one-time callback proof; polling returns status only.
6. **Parent/child authority & race safety:** Parent/child RPC whitelists
   identity/source/control messages and never transports Bearer, poll secret,
   completion proof, Discord token, or CSRF token. Any same-epoch authority
   failure invalidates cached Admin identity immediately in both parent and
   child, preventing stale successes from restoring privileged UI.
7. **Source gating & embed protection:** Standard builds reject `js/ai/dev/**`,
   `js/userscript/dev/**`, `js/auth/server/**`, `js/auth/privileged/**`, and
   `js/auth/admin-app.js`. All auth, Admin, and private responses send
   `Cache-Control: no-store` and `Cross-Origin-Resource-Policy: same-origin`,
   and `wrangler.jsonc` enforces `assets.run_worker_first: true`.

## Automated verification suites

### 1. Unit, server, client, routing, and deploy tests (`npm run auth:test`)

Runs `node --test tests/auth/*.test.mjs && node tests/userscript-publication.mjs`:

| Test file | Coverage |
| --- | --- |
| `tests/auth/server.test.mjs` | OAuth flow, owner bootstrap, role/enabled enforcement, CSRF, audit log, pairing theft prevention |
| `tests/auth/client.test.mjs` | Web client CSRF serialization, parent/child authority invalidation races, capability mapping |
| `tests/auth/worker-entry-routing.test.mjs` | `worker-entry.js` routing precedence, auth OPTIONS/CORS isolation, `CORP: same-origin` headers |
| `tests/auth/build-policy.test.mjs` | Standard graph exclusion of Dev, private, auth-server, and Admin modules |
| `tests/auth/deploy-production.test.mjs` | `npm run deploy:production` config validation gate, fail-closed stop before Wrangler, flag lockdown |
| `tests/auth/deploy-assets-provenance.test.mjs` | Published asset provenance and private backing exclusion |
| `tests/auth/deploy-entrypoint-provenance.test.mjs` | Production Worker entrypoint provenance |
| `tests/auth/token-canonical-encoding.test.mjs` | Canonical token encoding and digest verification |
| `tests/auth/issue-9237-storage-write-order.test.mjs` | Storage write ordering invariant |
| `tests/auth/issue-9273-filesystem-root-graph.test.mjs` | Filesystem root graph boundary |
| `tests/auth/issue-9644-oauth-reclaim.test.mjs` | OAuth transaction reclaim and consumed-index behavior |
| `tests/userscript-publication.mjs` | Committed userscript template and release-version publication contract |

To run the production deploy gate standalone:

```bash
NODE_OPTIONS=--experimental-global-webcrypto node --test tests/auth/deploy-production.test.mjs
```

### 2. Build & source-gating acceptance (`npm run auth:build-test`)

Runs `npm run userscript:build && node tests/auth/build-acceptance.mjs`.
Inspects esbuild metafiles, required private inputs, generated private hashes,
runtime/release identity binding (`userscript/release-version.json` and
`userscript/hex.user.template.js`), GM grants, and walks every public file in
`dist/` to reject any private bundle byte leakage.

### 3. Config validation & D1 migrations

```bash
npm run auth:validate-production-config
node scripts/validate-auth-config.mjs --local
npm run auth:migrate:local
```

### 4. Browser verification

```bash
npm run auth:browser      # Full local HTTPS browser/CSP/userscript/standalone flow
npm run auth:browser-dom  # Admin XSS-safe rendering, owner locks, role/enabled editing, pairing UI
```

No live Discord API call is required for automated verification; OAuth tests
mock Discord endpoints locally.
