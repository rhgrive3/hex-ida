# Discord Authentication / Authorization — Local Setup & Operations

## Overview

Hex uses Discord OAuth2 (`identify` scope only) for user identity, Cloudflare
D1 (`AUTH_DB`, logical database `hex-auth`) for role/enabled authority, and
Admin-only server-gated delivery for privileged Dev Agent and Admin UI bundles.

## Product authority

Discord is identity only and requests only the `identify` scope. Discord guild
roles, guild membership, and Discord permissions are never used by Hex.
Authorization is derived from the current D1 user row on every
security-sensitive request.

| HEX role | Standard Agent | Dev Agent | Dev YOLO | Admin site |
| --- | --- | --- | --- | --- |
| `free` | yes | no | no | no |
| `vip` | yes | no | no | no |
| `admin` | yes | yes | yes | yes |

Standard Agent remains available anonymously. Agent profiles remain `standard`
and `dev`; `normal` / `yolo` are Dev decision policies. Role labels have no
numeric ordering. Capability mapping lives in `js/auth/capabilities.js`.

A first successful Discord login creates a `free` user with `enabled = true`.
Subsequent logins preserve the current role and enabled state while updating
username and login timestamps. Pre-registered Discord IDs join the same row on
OAuth.

`HEX_OWNER_DISCORD_ID` is the bootstrap owner. Auth routes fail closed (`503
auth-not-configured`) when it is missing or malformed. The configured owner is
always effective Admin, cannot be downgraded or disabled through the Admin API,
and OAuth repairs any inconsistent owner row.

## Required configuration

Keep real secrets in untracked local `.dev.vars` (for local Wrangler dev) and
Cloudflare Worker secrets/environment variables (for production):

```dotenv
DISCORD_CLIENT_ID="<Discord application ID>"
DISCORD_CLIENT_SECRET="<Discord client secret>"
DISCORD_REDIRECT_URI="https://<worker-origin>/auth/discord/callback"
HEX_OWNER_DISCORD_ID="<owner Discord user ID>"
```

`wrangler.jsonc` configures:

- Worker entrypoint: `./worker-entry.js` (with `crons: ["*/5 * * * *"]`)
- Static Assets: `./dist` with `binding: "ASSETS"` and `run_worker_first: true`
  (required so Admin, auth, and private paths never fall through to public
  static assets)
- Durable Objects (SQLite-backed): `AI_QUOTA` (`AIQuota`) and
  `RUNTIME_BOOTSTRAP` (`RuntimeBootstrap`)
- D1 database binding: `AUTH_DB` (`database_name: "hex-auth"`,
  `migrations_dir: "migrations/auth"`, production UUID configured in
  `wrangler.jsonc`)

The Discord Developer Portal redirect URI must match `DISCORD_REDIRECT_URI`
exactly: same Worker origin and `/auth/discord/callback`, with no query or
fragment. Production requires HTTPS. Loopback HTTP is accepted only for local
development, though Secure `__Host-` cookies mean HTTPS is preferred for full
browser acceptance.

## D1 migrations

`migrations/auth/` contains:

- `0001_auth.sql` — creates `users`, hashed `sessions`, hashed
  `oauth_transactions`, and append-only `audit_log` with UPDATE/DELETE
  rejection triggers.
- `0002_oauth_transaction_consumed.sql` — adds the `oauth_consumed_at` index on
  `oauth_transactions(consumed_at)`.

Apply migrations using the canonical `package.json` scripts:

```bash
# Local Wrangler D1
npm run auth:migrate:local

# Remote production D1
npm run auth:migrate:remote
```

Admin mutations use prepared SQL and D1 `batch()` so the guarded mutation and
its audit append execute in one transactional batch. Search/pagination and
request bodies are bounded. User hard delete is intentionally not implemented.

## Verification and deployment commands

Repository-pinned devDependencies (`package.json`): `esbuild 0.28.2`,
`playwright 1.65.1`, `wrangler ^4.168.0`.

```bash
# Install pinned dependencies
npm ci --no-audit --no-fund

# Validate Wrangler auth configuration
npm run auth:validate-production-config
node scripts/validate-auth-config.mjs --local

# Apply local D1 migrations
npm run auth:migrate:local

# Run focused auth unit/server/client/routing/deploy tests
npm run auth:test

# Verify build policy, private bundle exclusion, and release identity
npm run auth:build-test

# Run browser acceptance tests
npm run auth:browser
npm run auth:browser-dom

# Run production deployment (validates wrangler.jsonc before invoking Wrangler)
npm run deploy:production
```

`npm run deploy:production` (`scripts/deploy-production.mjs`) validates
`wrangler.jsonc` with `scripts/validate-auth-config.mjs` before invoking
Wrangler and rejects alternate `--config` or `--env` overrides so the validated
file is always the deployed file. Keep auth validation out of `build.command`
because Wrangler runs `build.command` for both local `dev` and `deploy`.

## Session security

- **Web OAuth:** uses a random, one-use, ≤10-minute state plus a separate
  browser binding cookie. The callback exchanges the authorization code
  server-side and reads `/users/@me`. Discord tokens are never persisted or
  logged. Hex issues its own 256-bit session token; D1 stores only its SHA-256
  digest.
- **Web cookies & CSRF:** `__Host-hex_session` (`Secure`, `HttpOnly`,
  `SameSite=Lax`, `Path=/`, no `Domain`) with a 7-day TTL. Cookie-authenticated
  mutations require an exact same-origin `Origin` header plus a random
  session-bound CSRF token.
- **Userscript sessions:** independent Bearer sessions stored solely via
  `GM.getValue` / `GM.setValue` / `GM.deleteValue` (no `localStorage` or
  `sessionStorage` fallback). Credential-bearing requests use
  `GM.xmlHttpRequest` to the exact Worker origin. Auth endpoints deliberately
  do not expose cross-origin browser CORS to ChatGPT page JavaScript.

## Userscript OAuth pairing

The parent userscript realm owns pairing (`js/auth/userscript-login.js`). The
child sandbox may request login UI display, but never receives the poll secret,
completion proof, Bearer token, CSRF token, Discord token, or Worker secret:

1. Parent starts `/api/auth/userscript/start` with an allowlisted ChatGPT
   opener origin.
2. Worker returns transaction ID, parent-only poll secret, and Discord URL.
3. A real click in the parent UI opens Discord (no automatic popup).
4. Polling is finite and returns status only.
5. Callback creates a separate one-use, short-lived completion proof bound to
   the transaction and posts it only to the stored exact opener origin when
   available (with manual copy/paste fallback on the callback page).
6. `/api/auth/userscript/complete` requires transaction ID + poll secret + proof
   and issues the Bearer token exactly once.

## Privileged source delivery

The Standard runtime contains only auth/capability/extension boundaries.
Privileged Dev Agent code is built from two private entries:

- `js/auth/privileged/parent-entry.js`
- `js/auth/privileged/child-entry.js`

Build policy (`tests/auth/build-policy.test.mjs`,
`tests/auth/build-acceptance.mjs`) rejects `js/ai/dev/**`,
`js/userscript/dev/**`, `js/auth/server/**`, `js/auth/privileged/**`, and
`js/auth/admin-app.js` from Standard graphs. Parent/child private bundles are
fetched only after current Admin capability is confirmed; each GET re-reads the
D1 session and requires the exact current private build ID. All auth, Admin,
and private responses are `no-store` and send
`Cross-Origin-Resource-Policy: same-origin`.

Role loss fails closed: privileged operations are denied server-side, authority
failures invalidate parent/child cached identity immediately, loaded extensions
are torn down, and Dev UI clamps back to Standard.
