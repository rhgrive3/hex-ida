# Discord auth implementation verification — 2026-09-13

## Result

The source implementation is complete for the requested Discord identity + HEX
role authority + Admin management + Admin-only Dev/YOLO source-delivery design.
This final self-review found and fixed seven additional boundary/lifecycle/architecture issues.
All focused tests that can run in the current environment are green.

Production acceptance is intentionally **not** labelled 100% complete because the
environment lacks the repository-pinned esbuild 0.28.2, Wrangler, and Playwright
1.62.1, and managed Chromium blocks localhost navigation. Those canonical/manual
gates are listed at the end.

No remote push/merge/deploy, production D1 operation, Discord Developer Portal
change, or live Discord API request was performed.

## Final self-review fixes

### 1. Browser CORS could expose the userscript pairing bootstrap surface

The auth router previously allowed ChatGPT origins and could emit CORS responses.
That was too broad for a design where the userscript Bearer/pairing material is
owned by the GM parent realm. Cross-origin browser preflight is now rejected.
Same-origin web continues to receive CORS headers where appropriate, while
`GM.xmlHttpRequest` needs no browser ACAO. Regression coverage verifies both the
auth router and real `worker-entry.js` routing order, including that auth OPTIONS
cannot fall through to generic `/api/*` CORS.

### 2. Missing owner configuration did not fail closed early enough

`HEX_OWNER_DISCORD_ID` is now mandatory for auth routes and is validated as a
Discord snowflake before repository creation. Missing/malformed owner config
returns 503 `auth-not-configured`; Standard non-auth routes remain available.

### 3. Standard graph policy did not explicitly reject the protected Admin app

`assertStandardGraph()` now forbids `js/auth/admin-app.js` in addition to Dev,
private, and auth-server implementation. A negative test locks this boundary.

### 4. Parent authority race could preserve stale local Admin UI

An older authority request could fail after a newer success and previously be
ignored by sequence ordering. Server-side privileged actions were already denied,
but local Admin identity could remain visible until the next refresh. Any
same-epoch authority failure now invalidates the epoch immediately, so a stale
success cannot restore Admin. A deterministic out-of-order regression test covers
this exact counterexample.

### 5. Child auth RPC had the same stale-failure lifecycle race

A late failed identity request could be discarded after a newer success. The RPC
client now clamps to anonymous on any authority failure and advances its refresh
generation, preventing privileged child UI from surviving the failure. The
counterexample has its own regression test.

### 6. Dev UI collapsed explicit capabilities back into a single Admin bit

Current product semantics still allow Dev/YOLO only for Admin, so this was not a
present privilege bypass. It did, however, violate the requested extension shape:
changing only the VIP capability map later could accidentally couple Dev and YOLO.
The legacy `AdminAuthProvider` adapter now preserves explicit `canUseDevAgent` and
`canUseDevYolo` capabilities. Profile visibility consumes the Dev capability and
YOLO consumes its separate capability, while legacy test providers without a
capability object keep their old Admin fallback. `identity.admin` now describes
actual Admin role rather than being an alias for Dev permission. A regression
fixture proves a future Dev-only/non-YOLO identity exposes Dev but rejects YOLO.

### 7. Sensitive JS responses lacked an explicit same-origin embed policy

Cookie/CORS checks already prevented ordinary cross-site API reads, but a future
custom-domain deployment could have same-site sibling origins. A classic no-CORS
`<script>` request should never be able to consume Admin/private JS merely because
a host-only SameSite cookie is eligible. All auth/Admin/private responses now send
`Cross-Origin-Resource-Policy: same-origin`. The server and actual Worker routing
harness assert the header on authorized private child and Admin JS responses.
This strengthens the browser response boundary without changing the GM parent
transport or same-origin direct-Web path.

## Security architecture rechecked

- Discord uses OAuth2 Authorization Code and `identify` only.
- Discord User ID is the identity key; username is display metadata and updates on
  login.
- D1 `free` / `vip` / `admin` + enabled state is the role authority.
- The configured owner is effective Admin, cannot be downgraded/disabled by Admin
  APIs, and OAuth repairs its row.
- First login is enabled Free; existing role/enabled state is preserved.
- HEX web/userscript session tokens are random 256-bit values; D1 stores SHA-256
  only. Discord access tokens are neither stored nor logged.
- Web session uses Secure/HttpOnly/SameSite=Lax `__Host-hex_session` and same-origin
  + session-bound CSRF for mutation.
- Userscript Bearer is held only in GM private storage; no local/session storage
  fallback exists.
- Pairing requires transaction ID + parent poll secret + callback-only one-time
  proof. Poll is status-only and cannot return a bearer/proof.
- Parent/child RPC whitelists identity/source/control messages and never transports
  Bearer, poll secret, completion proof, Discord token, or CSRF token.
- Admin API/site/private assets re-read current session/user authority.
- Admin assets and private Dev source are Worker-gated before generic assets/API.
- Standard Agent remains usable when auth is absent or unavailable.
- YOLO remains a Dev decision policy, never a third Agent profile.
- Existing Dev supervisor/worker/bootstrap implementation is reused rather than
  copied into Standard code.

## Source-gating evidence

The supplementary emitted build used the provided offline esbuild **0.25.9**.
The repo pin is 0.28.2, so this is strong structural evidence but not the canonical
release gate.

`npm run auth:build-test` passed after the final fixes:

```text
standard-runtime: 667 esbuild inputs; no privileged implementation
standard-parent: 663 esbuild inputs; no privileged implementation
standard-loader: 4 esbuild inputs; no privileged implementation
Embedded assets: 20 collected classic inputs, 3 esbuild worker graphs
Privileged source hashes, private backing exclusion, and GM grants: PASS
Actual encrypted runtime / private bytes / committed release binding and
private-only change sensitivity: PASS
```

The acceptance test additionally walks every regular public `dist/` file and
rejects exact parent/child/Admin private bundle payload leakage. Private parent and
child metafiles must contain the existing Dev implementation modules. Standard
metafiles reject `js/ai/dev/**`, `js/userscript/dev/**`, auth private/server
modules, and `js/auth/admin-app.js`.

Final supplementary generated identity:

```text
userscript serial: 2322242248
release identity: 8a6343573bdf15140e0d52313d1e1cc88fb97696aaa6f01c9a7c0e599d7aaf42
runtime build:     26c1445b63c814f0ef960623
private build:     26c1445b63c814f0ef960623.20a7a1c35002d8376f1d730f
```

These generated files must be regenerated with the pinned 0.28.2 toolchain before
production use.

## Final executed verification

| Check | Result |
| --- | --- |
| `npm run auth:test` | **PASS 36/36**, 0 fail, 0 skip |
| `npm run auth:build-test` | **PASS with supplemental esbuild 0.25.9**; not canonical pin |
| `npm run dev-agent:test` | **PASS** |
| `npm run lint` | **PASS — 4,204 files** |
| `npm run module-boundaries:test` | **PASS** |
| `npm run migration:test` | **PASS** |
| `node scripts/validate-auth-config.mjs --local` | **PASS** |
| `npm run auth:validate-production-config` | **Expected FAIL**: local D1 sentinel rejected |
| `npm run auth:browser-dom` | **PASS, supplementary** with Playwright core 1.57 + Chromium 144 |
| focused `tests/userscript-routes.mjs` | **BLOCKED**: local Wrangler executable absent (`ENOENT`) |
| `npm run auth:migrate:local` | **BLOCKED**: `wrangler: not found` |
| full local HTTPS `npm run auth:browser` | **BLOCKED** by managed Chromium `ERR_BLOCKED_BY_ADMINISTRATOR` |
| focused `tests/agent-capability-plane.mjs` | existing `approval_required` FAIL reproduced identically in untouched implementation baseline |

The DOM browser pass covers Admin XSS-safe rendering, owner locks, role/enabled
editing, audit/search/registration, tablet width, real login-button click,
copy/paste fallback, and cancellation. It explicitly does not substitute for
network/CSP/compiled-runtime/pinned-browser acceptance.

An exact 0.28.2 esbuild registry fetch was attempted with a finite timeout and
failed DNS (`Could not resolve host: registry.npmjs.org`). Local cache searches
also found no pinned esbuild, Wrangler, or pinned Playwright package. No fake
binary or dependency downgrade was committed.

## Broad-suite isolation

Broad suites were not repeatedly rerun after known environment/baseline barriers.
The first relevant blockers were reduced instead:

- userscript route integration stops at the missing Wrangler binary.
- the AI capability fixture fails at `annotation.rename` requiring
  `approval_required`; the exact same failure is present in the untouched prior
  implementation artifact, so this review did not modify that subsystem to mask
  it.
- earlier broad `npm test` baseline evidence likewise reproduced the first
  InvestigationSessionStore failure in the untouched baseline.
- a broad `check`/invariants attempt was stopped after it moved into unrelated
  long-running machine-effects validation; focused auth/module/migration/lint
  gates were then run separately and passed.

This preserves the first-failure evidence without treating unrelated baseline
issues as Discord-auth regressions.

## Review status

After the seven fixes above, subsequent security, integration/runtime, and
operations-focused source reviews found no new code defect in the auth change.
The focused test suite was rerun after the fixes and remains green.

However, the task-defined **Full Review** explicitly includes canonical build,
D1/browser evidence and three consecutive clean runs. Because pinned build,
Wrangler-local D1, and full browser gates are unavailable here, those reviews do
not qualify for the formal streak.

```text
Post-fix source/focused review passes: 3/3 clean
#1 attacker/security emphasis:       0 new findings
#2 integration/runtime emphasis:     0 new findings
#3 operator/maintainability emphasis: 0 new findings

Task-defined Full Review clean streak: not countable yet
```

The three clean passes are source/focused reviews only. They are deliberately not
renamed to the task's `Full Review`, because that definition also requires the
canonical pinned build, Wrangler-local D1, full browser path and complete evidence
check that this environment cannot supply.

This is deliberate: missing canonical evidence is not reported as a clean Full
Review.

## Remaining canonical/manual acceptance

Later, with the real local toolchain/browser available:

1. `npm ci` using the repository lock/pins.
2. `npm run auth:build-test` with esbuild 0.28.2; keep the new public-byte leak
   check and verify the resulting release identity.
3. Apply `migrations/auth` through fresh and already-migrated Wrangler-local D1.
4. Run full local HTTPS browser/CSP/userscript/standalone integration with
   Playwright 1.62.1 or the repository's exact supported browser harness.
5. Re-run affected userscript/AI/broad/check suites, separating any baseline
   failures by a safe untouched copy.
6. Perform three consecutive task-defined Full Reviews with zero new findings.
7. Before any separately authorized production deploy, configure the real
   `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`,
   `HEX_OWNER_DISCORD_ID`, and production `AUTH_DB` UUID, then require the
   production config validator to pass.

Until those environment/manual gates are done, the source is implementation-ready
but should not be described as production-accepted or 3/3 Full Review complete.
