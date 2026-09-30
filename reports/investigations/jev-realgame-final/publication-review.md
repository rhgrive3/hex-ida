# Independent publication review — Jev real-game final (evidence receipt)

Status: **independent re-verification complete; no blocking counterexample found.**
Every claim below was reproduced by this review (probe re-run, code read, or focused test at exact HEAD),
not inherited from the prior lane. Prior lane `publication-review-cline7.log` died on provider balance
(`Insufficient balance`) while still drafting probe H; its probes A–G sources are reusable and were re-run.

## 1. Identity and scope

| Fact | Value |
|---|---|
| Reviewed publication implementation (task A) | `/mnt/workspace/.dev-state/agent-work/checkouts/pinpoint-cxx-member-candidates/hex-ida` @ `bb5f415cc9498aff47fc41f0867f201a515d53b2` |
| Reviewed integrated product | `/mnt/workspace/.dev-state/agent-work/checkouts/jev-realgame-final/hex-ida` @ `d990c1783b92039937c7fa64993ab8a568321c70` (blind collection SHA `a15e196c0d5176870c22c5995b3cf1e1d399adc9`) |
| A vs integrated product | `diff -rq A/js I/js` → **empty**; `diff -rq A/js/analysis/cxx I/js/analysis/cxx` → **empty** |
| Consequence | Probes run against A measure the integrated product's publication path byte-for-byte unchanged |

Changed-file inventory of the A publication delta (`git diff --stat d2177389cd1770edb3548251a080bf23e829a8a0..bb5f415cc`), 25 files, +1308/−42:
`js/analysis/cxx/member-index.js` (+179), `js/analysis/cxx/object-evidence.js` (±16), `js/analysis/cxx/project.js` (+27),
`js/pinpoint-fields.js` (+25), `js/pinpoint-legacy.js` (±66), `js/pinpoint.js` (±6), `js/analysis/query/app-adapter.js` (+13),
`js/analysis/investigation-service.js` (±15), `js/auto.js` (±5), `js/narrate.js` (+3), `js/panels-base.js` (±19),
`scripts/validate-pinpoint-cxx-members.mjs` (+249), `tests/phase7/cxx/{pinpoint-member-index,pinpoint-publication,projection}.test.mjs`,
`tests/phase7/pinpoint-cxx-cross-lane-route.test.mjs`, `tests/pinpoint-jev-probe-audit.mjs`, `.circleci/config.yml`,
`.github/workflows/phase7-ownership.yml`, `tools/validation/phase7/cross-lane-inventory.mjs`, `userscript/*`, docs.
Commits: `ba45ab291` publish canonical member evidence → `25c3385ab` shared enumeration → `5f1566633` ownership out of offset hints →
`3d7cad32e` disjoint keys → `84447ed98` CI exact cross-owner inventory → `bb5f415cc` authenticated egress without byte scans.

## 2. Reproduced probe results (independent re-run, `node <probe>` from task scratch)

| Probe | Result (verbatim essentials) | Verdict |
|---|---|---|
| A (class-name reach, named `Player`) | `query=player/Player` → `verdict=ambiguous universe=3`; 3 anonymous members `member_0x8/0xc/0x10` p=0.2505, `ev=[size-fits,class-name,access-verified]` | No unnamed member reaches strong; 0→nonzero retention |
| A/D (ObjC + C++ mixed) | `D before` top `_player` p=0.6654; `D after` unchanged **and** 3 anon C++ candidates added in recall lane; `D top identity/probability preserved: true` | Legacy top-1 identity and probability preserved |
| B (producer-supplied `memberName:'health'` on an unrelated class) | `verdict=likely p=0.981309 ev=[field-name-asked,type-numeric,size-fits,access-verified]`; published `name=health`, `memberName=undefined`, provenance 1 | Name is carried, never minted; see §4 |
| C (adversarial keys) | 14 adversarial class/ivar names → `published 14 keys; distinct 14`; `any raw # in a C++ key: false`; `legacy-key collision found: null`; lattice keys distinct, count 14 | Published C++ keys are disjoint from ObjC keys and injective |
| E (forged look-alike owner in legacy map) | `forged look-alike fields accepted: 0`; `forged candidates from pinch: 0` | Owner binding is not guessable |
| E2 (hand-built `source:'cxx'` field) | `E2 verdict none universe 3`; `candidates by class: []`; `forged hand-built candidates: 0 total 3` | Non-canonical C++-looking field fails closed |
| F (worst case unnamed) | `Health/health`, `HealthManager/health`, `Coin/coins`, `Score/score` → all `verdict=ambiguous p=0.4557`; `Player/player` → `none p=0.2598`; 40 competing members → `top p 0.2977 runnerUp p 0.2977 margin LN 0.000` | An unnamed member cannot exceed `ambiguous` even with an exact class-name match |
| G (scale/boundedness) | 512 functions × 40 members = 20480 observations → `fieldCount 40 provenanceLen 64 provenanceCount 512 truncated true readCount 1536 (=512×3) writeCount 512 revisionAfter 512`; `clear() → fieldCount 0` | Counts exact, dedupe per function, provenance bounded |

## 3. Invariants audited against implementation

1. **Canonical receiver/member only.** `member-index.eligible` (`js/analysis/cxx/member-index.js:37-45`) requires
   `isCanonicalCppMemberEvidence(member) && accessProven===true`, `receiverDigest===receiver.digest`, matching `functionId`/`snapshotId`,
   `readCount+writeCount>0`, `!mixedWidths && !indexed`, BigInt offset in `[0, MAX_SAFE_INTEGER]`, `sizeBytes>0`.
   WeakSet identities (`indexes/classes/fields`) mean a structurally identical plain object is not accepted (probe E/E2 = 0).
2. **Owner not guessed.** `ownerKeyFor` (`:14-21`) needs a real `classIdentity`, rejects `offsetToTop !== 0n`, and returns `null` when no
   named/vtable/typeinfo identity exists; the publish loop skips `null` ownerKey (`:93-95`). The published `classIdentity` is
   `provenance[0].receiver.classIdentity` (`:54`) — never derived from an offset or name.
3. **No fabricated width/type/offset.** `createCppMemberEvidence` (`object-evidence.js:327+`) rejects an absent offset, accepts
   `sizeBytes` only in `0..64`, requires category/typeLabel to agree, requires `rule` when a type is proven and `reason` when it is not,
   and requires `read+write>0`. `typeFor` (`member-index.js:23-35`) yields kind `unknown` unless `typeProven`. `projectMembers` rejects
   (never repairs) any record the canonicaliser refuses (`project.js:143-161`: "A record the canonicaliser rejects is dropped").
4. **Ambiguous fail-closed.** Enumeration admits C++ members only when `isCxxMemberField(iv, cls)` (WeakSet + `cls.ownerKey===iv.ownerKey`);
   `if ((cls.source==='cxx' || iv.source==='cxx') && !cxx) continue` (`pinpoint-legacy.js:151-152`). Composition refuses to re-expose an
   owner already claimed (`pinpoint-fields.js:9-15`). Probes A/F show the ceiling is `ambiguous`, never `likely`/`confirmed`.
5. **Anonymous retention 0→nonzero.** Probe A/D: universe 3 → 3 retained candidates; anonymous C++ candidates join via
   `candidates.filter(c => c.source==='cxx' && !keys.has(c.key))` marked `recallLane` (`pinpoint-legacy.js:216-220`), so they never displace a
   name match (probe D: top identity + probability preserved).
6. **Stable, injective, ObjC-disjoint keys.** Key = `JSON.stringify([ownerKey, offset, size, category, typeLabel, signedness,
   categoryCandidates, widthOnly]).replaceAll('#', '\\u0023')` (`member-index.js:103-104`, so no raw `#` can appear in a published key).
   Legacy/ObjC keys are `className#offset#ivar`,
   so "no raw `#` in a published C++ key" is a sufficient disjointness proof — measured in probe C (0 collisions over 14 adversarial names).
   Deterministic ordering via `byRecallLane` + key tiebreak (`pinpoint.js:86-90`).
7. **Snapshot/cache binding.** `cxxMemberIndexForApp` returns `null` unless `backend`, `symbols`, `backendGeneration`, `architecture` and
   `sliceIndex` all match (`app-adapter.js:35-44`). Consumers bind additionally: `investigation-service.js:222,290-291` (identity + `cxxRevision`),
   `panels-base.js:1517,1607-1611` (cache key includes `cxxFields.snapshotId` + `revision`), and `clear()` bumps `revision`.
8. **Bounded duplicates/provenance.** `MAX_PROVENANCE=64`; `sources` keeps a deterministic lexicographically-smallest sample beyond 64
   (`member-index.js:153-161`); dedupe key `${receiver.digest}:${member.digest}` (`:118-119`); counts are per-`functionId` maxima (`:145-150`);
   `names` trimmed deterministically with `namesTruncated`; `provenanceCount`/`provenanceTruncated` published (`:64-65`). Probe G confirms all counts.
9. **Fast path / projection only.** `pinpoint-fields.js:3-4` ("Reading this view never starts recovery or reads binary bytes");
   `composePinpointFields` returns `fields` unchanged when there is no index or `fieldCount===0`. No path in this review triggers recovery on Pinpoint.
10. **Blind collection carries no names.** `projectMembers` (`js/analysis/cxx/project.js:143-161`) is the only production producer and passes
    **no** `memberName`; the artifact contains 47/19 (OpenTTD) and 19/10 (OpenMW) distinct anonymous canonical candidates and **0 named** ones.
## 4. Limitations, residual risks, and what this receipt does NOT claim

- **Probe B reachability.** A producer-supplied `memberName` yields `likely` (p=0.981). This is not fabrication (the name is carried verbatim
  and never inferred), and it is **unreachable in the reviewed product** (§3.10). A future producer that supplies a name inherits probe B's
  behaviour and must be re-reviewed.
- **Unbounded-but-count-only state.** `sourceKeys`, `counts`, `records`, `#states`, `#classes` grow with distinct functions/members/snapshots;
  they hold counts/dedupe identity only and no query copies an unbounded history (`member-index.js:151-152`).
- **Universe shift.** Publishing C++ members increases `universe` for ELF C++ binaries, so legacy/ObjC probabilities on the same binary can move;
  anonymous C++ candidates stay `ambiguous`. This shift is not measured by any probe here.
- **Probe H never executed** (prior lane died mid-write). Its intended local main-vs-branch "0→nonzero" measurement on the ARM64 fixture is
  *superseded* by the parent's exact-SHA real-binary evidence (Actions `36689172349` @ `a15e196c0`). This review did not re-run heavy Fast analysis.
- **Gate invocation lives outside the reviewed tree.** `scripts/validate-pinpoint-cxx-members.mjs` exposes a CLI with failure propagation, but the
  only in-repo reference is the collector importing `selectSamples`; the pass/fail evidence producer is the external exact-SHA workflow. Nothing
  in this receipt substitutes for that canonical gate.

## 5. Exact evidence used

- Probes (task scratch, re-run by this review): `.../scratch/jev-realgame-final/probe-{a,b,c,e,e2,f,g}.mjs` (+ `probe-h-*.mjs`, draft only).
- Prior lane log (bounded tail only): `.../evidence/jev-realgame-final/publication-review-cline7.log`; ANSI-stripped copy
  `.../scratch/jev-realgame-final/cline7.clean.txt`.
- Focused tests on the integration working tree based on HEAD `d990c1783` (local, cheap): `node --test tests/jev-realgame-final.test.mjs` → **10 pass / 0 fail** (incl.
  "unqualified class labels require verified qualification and cannot guess a namespace"); `node --test tests/jev-realgame-holdout.test.mjs` →
  **5 pass / 0 fail**. An earlier integration run (`scratch/jev-realgame-final/int.names`) showed 1 failure ("holdout manifest and case hashes
  are verified and frozen"); it is **green at current HEAD**.
- Blind collection artifact (counts recomputed by this review from `*.json` `rows[].{candidates,shortlist,recovered}`): productSha `a15e196c0`,
  caseSha256 `05def9…`; `openttd.json` 47 distinct keys / 19 classes, `openmw.json` 19 / 10, all keys present in the ≤255 shortlist.
- Reviewed at exact trees A `bb5f415cc` and integration `d990c1783`; `git diff --stat` and `diff -rq` outputs as in §1.
- **No repository writes by this review.** The integration checkout's working tree is unchanged by me (same `M`/`??` set as at task start);
  it additionally gained a parent-owned untracked `scripts/verify-jev-realgame-final.mjs` (written concurrently at 17:01 +0800 by the parent lane,
  not authored here). HEADs are untouched. Product publication sources are byte-identical to the stated HEAD; parent-owned evaluation changes were reviewed in the working tree and require the final exact-head gate.
