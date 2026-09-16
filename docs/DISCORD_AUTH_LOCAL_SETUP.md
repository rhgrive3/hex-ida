# Discord authentication / authorization — local setup

## Status

Discord OAuth, HEX `free` / `vip` / `admin` authorization, owner bootstrap,
web/userscript sessions, the Admin application, and Admin-only privileged Dev
source delivery are implemented in source. The review branch is pushed for
review; no merge, production deploy, production D1 mutation, Discord Developer
Portal change, or live Discord API call was performed.

The initial 2026-09-13 review used a supplementary esbuild 0.25.9 build because
the pinned toolchain was unavailable there. Follow-up verification with the
lockfile's esbuild 0.28.2, Wrangler 4.131.0, and Playwright 1.63.0 passed the
canonical auth build and browser flows. The canonical build reproduced the two
committed generated release files byte-for-byte; keep the remaining D1 and
production gates below distinct from that completed evidence.

The input archive has no Git metadata. Its files are the baseline for this work.

## Product authority

Discord is identity only and requests only the `identify` scope. Discord guild
roles, guild membership, and Discord permissions are not used by HEX.
Authorization is derived from the current D1 user row on security-sensitive
requests.

| HEX role | Standard Agent | Dev Agent | Dev YOLO | Admin site |
| --- | --- | --- | --- | --- |
| `free` | yes | no | no | no |
| `vip` | yes | no | no | no |
| `admin` | yes | yes | yes | yes |

Standard Agent remains available anonymously. Agent profiles remain only
`standard` and `dev`; `normal` / `yolo` are Dev decision policies. Role labels
have no numeric ordering. Capability mapping lives in `js/auth/capabilities.js`.

A first successful Discord login creates `free`, enabled=true. Later logins keep
the current role/enabled state while updating username and login timestamps.
Pre-registered Discord IDs join the same row on OAuth.

`HEX_OWNER_DISCORD_ID` is the bootstrap owner. It must be configured; auth routes
fail closed when it is missing or malformed. The configured owner is always
effective Admin, cannot be downgraded/disabled through the Admin API, and OAuth
repairs an inconsistent owner row.

## Required configuration

Keep real values in untracked local secrets and later Worker secrets/environment:

```dotenv
DISCORD_CLIENT_ID="<Discord application ID>"
DISCORD_CLIENT_SECRET="<Discord client secret>"
DISCORD_REDIRECT_URI="https://<worker-origin>/auth/discord/callback"
HEX_OWNER_DISCORD_ID="<owner Discord user ID>"
```

The D1 binding is `AUTH_DB`. `wrangler.jsonc` uses logical database name
`hex-auth`, migration directory `migrations/auth`, and the local-only sentinel:

```text
00000000-0000-0000-0000-000000000000
```

Do not deploy with that sentinel. The production validator intentionally rejects
it. `assets.run_worker_first=true` is required so Admin/auth/private paths cannot
fall through to public static assets.

The Discord Developer Portal redirect URI must exactly equal the configured
`DISCORD_REDIRECT_URI`: same Worker origin and `/auth/discord/callback`, with no
query or fragment. Production requires HTTPS. Loopback HTTP is accepted only for
local configuration, but Secure `__Host-` cookies mean HTTPS is preferred for
browser acceptance.

## Canonical local acceptance

Use repository-pinned dependencies. All commands below are local-only and have
finite outer timeouts.

```bash
timeout --kill-after=5s 300s npm ci --no-audit --no-fund
timeout --kill-after=5s 180s npm run auth:build-test
timeout --kill-after=5s 60s npm run auth:test
timeout --kill-after=5s 120s npm run dev-agent:test
timeout --kill-after=5s 120s npm run lint
timeout --kill-after=5s 60s npm run module-boundaries:test
timeout --kill-after=5s 60s npm run migration:test
timeout --kill-after=5s 30s node scripts/validate-auth-config.mjs --local
timeout --kill-after=5s 120s npm run auth:migrate:local
timeout --kill-after=5s 180s npm run auth:browser
timeout --kill-after=5s 300s npm run userscript:test
timeout --kill-after=5s 300s npm run ai:test
timeout --kill-after=5s 600s node scripts/run-quiet-command.mjs --label test -- npm test
timeout --kill-after=5s 600s node scripts/run-quiet-command.mjs --label check -- npm run check
```

If a broad suite fails, isolate the first failing subsystem rather than reading a
large log or rerunning the whole suite unchanged.

For production preparation, replace the local D1 sentinel with the real D1 UUID
and run:

```bash
timeout --kill-after=5s 30s npm run auth:validate-production-config
```

This command is validation only; it does not deploy or mutate remote D1.

Use `npm run deploy:production` for production releases. The command validates
`wrangler.jsonc` with the production sentinel check before running `wrangler
deploy`; it fails closed and does not start Wrangler when validation fails. It
does not accept a different config or environment, so the file validated is the
file deployed. Keep this validation out of `build.command`: Wrangler runs that
custom build step for both `wrangler dev` and `wrangler deploy`, while local
development relies on the sentinel. See [Wrangler custom builds](https://developers.cloudflare.com/workers/wrangler/custom-builds/).

## Session security

Web OAuth uses a random, one-use, <=10-minute state plus a separate browser
binding cookie. OAuth callback exchanges the code server-side and reads
`/users/@me`. Discord tokens are never persisted. HEX then issues its own 256-bit
session token; D1 stores only SHA-256.

The web cookie is `__Host-hex_session` with Secure, HttpOnly, SameSite=Lax,
Path=/, and no Domain. Sessions have a seven-day TTL. Cookie-authenticated
mutations require exact same-origin `Origin` plus a random session-bound CSRF
token. The web client serializes CSRF rotation + mutation to avoid self-races.

Userscript sessions are independent Bearer sessions stored only through
`GM.getValue` / `GM.setValue` / `GM.deleteValue`. There is no fallback to
`localStorage` or `sessionStorage`. Credential-bearing requests use
`GM.xmlHttpRequest` and an exact Worker origin. Auth endpoints deliberately do
**not** expose cross-origin browser CORS to ChatGPT page JavaScript; a normal page
preflight is rejected while GM transport remains usable.

## Userscript OAuth pairing

The parent userscript realm owns pairing. The child may request display of login
UI, but it never receives the poll secret, completion proof, bearer, CSRF token,
Discord token, or Worker secret.

1. Parent starts `/api/auth/userscript/start` with an allowlisted ChatGPT opener
   origin.
2. Worker returns transaction ID, parent-only poll secret, and Discord URL.
3. A real click in the parent UI opens Discord; no automatic popup is used.
4. Polling is finite and returns status only.
5. Callback creates a separate one-use, short-lived completion proof bound to the
   transaction. It is posted only to the stored exact opener origin when possible.
6. If opener delivery is unavailable, copy/paste the proof from the callback page.
7. `/api/auth/userscript/complete` requires transaction ID + poll secret + proof
   and issues the Bearer exactly once.

The theft regression explicitly covers an attacker who owns transaction ID and
poll secret but not the callback proof; poll alone never returns a session.

## Privileged source delivery

The common Standard runtime contains only auth/capability/extension boundaries.
Existing Dev implementation is reused from two private entries:

- `js/auth/privileged/parent-entry.js`
- `js/auth/privileged/child-entry.js`

Build policy rejects `js/ai/dev/**`, `js/userscript/dev/**`, auth server/private
modules, and `js/auth/admin-app.js` from Standard graphs. Parent/child private
bundles are fetched only after current Admin capability is confirmed. Each private
GET re-reads the current D1-backed session and requires the exact current private
build ID. Responses are no-store and have no generic public backing asset.

The acceptance test inspects esbuild metafiles, required private inputs, generated
private hashes, runtime/release identity binding, and every public `dist/` file for
accidental exact private bundle bytes. Source changes in parent, child, or Admin
private bundles change the release identity.

Auth/Admin/private responses also send `Cross-Origin-Resource-Policy: same-origin`
so sensitive JavaScript cannot be consumed as a no-CORS subresource by a sibling
origin in a future custom-domain deployment.

Role loss is fail closed: current privileged operations are denied server-side;
authority failures invalidate parent/child cached identity even when an older
request finishes after a newer success; loaded extensions are closed and Dev UI
is clamped back to Standard when the client observes the loss. The Dev UI adapter
preserves separate `canUseDevAgent` / `canUseDevYolo` capabilities instead of
collapsing them into an Admin bit, so future VIP policy changes can remain
capability-only. Previously fetched client source cannot be erased from a former
Admin's device; no such impossible guarantee is claimed.

## D1 migration

`migrations/auth/0001_auth.sql` creates:

- `users`
- hashed `sessions`
- hashed OAuth/pairing transactions
- append-only `audit_log` with UPDATE/DELETE rejection triggers

Admin mutations use prepared SQL and D1 `batch()` so the guarded mutation and its
audit append are one transactional batch. Search/pagination and request bodies are
bounded. User hard delete is intentionally not implemented.

The focused tests execute this exact SQL using `node:sqlite`. That is useful
coverage but **does not replace** a fresh and already-migrated Wrangler-local D1
acceptance run.

## Manual / environment-dependent work still required

Before calling production acceptance complete:

1. Install repository-pinned dependencies with `npm ci`; the lockfile currently
   resolves esbuild 0.28.2, Wrangler 4.131.0, and Playwright 1.63.0.
2. `npm run auth:build-test` has reproduced the two committed generated release
   files byte-for-byte with esbuild 0.28.2. The branch receipt also records the
   build-acceptance results.
3. Run fresh and existing Wrangler-local D1 migration acceptance.
4. The full local HTTPS browser/CSP/userscript flow passed on Playwright 1.63.0;
   retain the exact-browser receipt alongside the branch acceptance evidence.
5. Preserve the broad-suite baseline result: `npm test` reaches the unchanged
   failures in `tests/issue-5227-effective-address-wrap.test.mjs`; the exact
   logs and focused lint/auth/build results are in the branch receipt.
6. After all canonical evidence is available, perform the task-defined Full Review
   three consecutive times with zero new findings.
7. Configure real `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
   `DISCORD_REDIRECT_URI`, `HEX_OWNER_DISCORD_ID`, and the production D1 UUID.

No live Discord call is required for automated acceptance; OAuth tests mock it.
