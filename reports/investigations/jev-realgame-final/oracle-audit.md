# Independent oracle audit — Jev real-game final (evidence receipt)

Status: **authority binding, corpus immutability, and the verified/unverified denominators independently re-verified.**
This receipt contains no gold/name injections, makes no Jev calls, and does not read the live evaluation outcomes.

## 1. What was audited (paths)

| Artifact | Path |
|---|---|
| Structural gold (evaluation-only) | `.../evidence/jev-realgame-final/structural-gold.json` (`hex-jev-realgame-structural-gold/v1`) |
| Authoritative layouts | `.../evidence/jev-realgame-final/layout-openttd.json`, `layout-openmw.json` |
| Semantic alternative audit | `.../evidence/jev-realgame-final/oracle-authority.json` |
| Extraction script (authoritative) | `.../checkpoints/jev-realgame-final/extract-gdb-layout.py` (GDB Python, `Type.fields`) |
| Scores it | `.../checkouts/jev-realgame-final/hex-ida/scripts/audit-jev-realgame-gold.mjs` |
| Frozen corpus | `.../checkouts/jev-realgame-final/hex-ida/reports/investigations/jev-real-game-freeform-holdout/{holdout-cases.json,holdout-manifest.json}` |
| Debug packages (cache) | `.../cache/jev-realgame-final/ddeb/{openttd-dbgsym_13.4-1build3,openmw-dbgsym_0.48.0-1ubuntu5}_arm64.ddeb` |

## 2. Authority binding — every value recomputed by this review

| Binding | Independent measurement | Recorded expectation | Match |
|---|---|---|---|
| OpenTTD frozen binary sha256 | `sha256sum …/cxx2/root-openttd/usr/games/openttd` = `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5` | manifest + layout `binarySha256` + authority | ✅ |
| OpenTTD frozen binary GNU build-ID | `readelf -n` → `d878fe2573ea43be2209d5ea5afef0b476f39d70` | layout `buildId` + authority | ✅ |
| OpenTTD debug file sha256 | `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be` | layout `debugFileSha256` | ✅ |
| OpenTTD debug file build-ID | same as frozen binary (`…/d8/78fe25…70.debug`) | layout `buildId` | ✅ |
| OpenTTD debug package sha256 | `09930c29507c3d5e02b8c1aa5c25dd9f44ad3f8975b00ce0b37adabce91d3b40` | `oracle-authority.json` | ✅ |
| OpenMW frozen binary sha256 | `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db` | manifest + layout + authority | ✅ |
| OpenMW frozen binary GNU build-ID | `eef0625b6b9af7971e72c4fc8260258b50dcae43` | layout `buildId` + authority | ✅ |
| OpenMW debug file sha256 | `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41` | layout `debugFileSha256` | ✅ |
| OpenMW debug package sha256 | `77272a82a9311d0a41d403a55c6ead13e7ae7f40455559c1005557047dbe41ef` | `oracle-authority.json` | ✅ |
| Rejected prior OpenTTD oracle | build-ID `60f73adac2fbf747728486c9c86547cb7c196c38` ≠ `d878fe25…`; sha256 `3011026d…` | `rejectedOldOracle` | ✅ correctly rejected |

The prior OpenTTD oracle (16.0-beta4 unstripped DWARF) is a **different build** and is not used to score the frozen 13.4 binary
(confirmed: `rejectedOldOracle.matchingBuildId !== buildId`, `oldOracleRejected: true`).

## 3. Frozen corpus immutability and denominators

- `holdout-cases.json` sha256 recomputed here = `05def989cdf8df4728bbdee5201f069e37a4e2a0c0d8bd6a91055cd10895df9a`
  = `manifest.caseSha256` = `CASE_HASH` in `scripts/jev-realgame-final-contract.mjs:7`. **70 cases, 70 unique ids, 55 answerable / 15 abstain.**
- Frozen case bytes are only ever consumed through `verifyCases()` (hash + count + id-uniqueness), used by collector, evaluator, and gold audit.
- `structural-gold.json` recomputed: **49 verified / 6 unverified / 15 control** (70 total). `caseSha256` bound to the frozen hash.
- Unverified (excluded from the answerable denominator, never re-labelled):
  `RG33` `CompanyProperties.max_loan`, `RG44` `Window.scale` (member absent from exact-build DWARF),
  `RG51` `ActorStats.health`, `RG52` `ActorStats.fatigue`, `RG53` `ActorStats.magicka`, `RG54` `CreatureStats.mLevel` (class unresolved in exact-build DWARF).
  Their frozen annotations (offsets 176 / 56) are **not** used as substitutes.

## 4. Representative facts re-derived independently from the exact-build DWARF

Run against the build-ID-matched debug files with `gdb -batch -nx -ex "file <debug>" -ex "ptype /o <class>"` (a different reader than the
Python `Type.fields` extractor):

| Fact | Independent `ptype /o` reading | `layout-*.json` | Consistent |
|---|---|---|---|
| `Vehicle.cur_speed` | `/* 274 \| 2 */ uint16 cur_speed;` | offset 274, size 2, `unsigned short` | ✅ (frozen annotation says **offset 306** → `annotationOffsetMismatch: true`) |
| `Vehicle.tile` | `TileIndex tile` @ 112, total size 4 | offset 112, size 4 | ✅ |
| `Vehicle.direction` | `/* 248 \| 1 */ Direction direction;` | offset 248, size 1 | ✅ |
| `RoadVehicle` inherited `tile`/`direction` | via base `Vehicle` | offset 112 / 248, `declaringClass: Vehicle`, `declaringOffset: 112 / 248`, inheritance `GroundVehicle<RoadVehicle,(VehicleType)1>@0`, `SpecializedVehicle<RoadVehicle,(VehicleType)1>@0`, `Vehicle@0` | ✅ exact owner + base adjustment |
| `MWWorld::Ptr.mRef` | `class MWWorld::Ptr : public MWWorld::PtrBase<std::remove_const_t>` (total size 24) | `mRef` offset 0, size 8, `declaringClass MWWorld::PtrBase<std::remove_const_t>`, `owningOffset 0`, base `@0` | ✅ RG55 verified through compiler base-layout metadata |
| `GroundVehicleCache.last_speed` | — | offset 30, size 2 | ✅ RG01 alternative |

## 5. Scalar-parser regression check

The authoritative layout comes from `extract-gdb-layout.py` (`Type.fields`, declaring owners, recursive base offsets). To check the earlier
scalar/semicolon parsing failure is gone, the same three classes were re-parsed with the independent text extractor
`scripts/extract-jev-realgame-layout.mjs` (`ptype /o` text parser) on the identical debug file:

- same member path in both extractors: **125**; **offset/size mismatches: 0** (no scalar value regression).
- 96 `type` string differences are typedef spelling/underlying-type only (`uint16` vs `unsigned short`, `Money` vs `OverflowSafeInt<long long>`,
  `TileIndex` vs its expanded struct) — the authoritative layout reports the stripped type; offsets/sizes agree.
- Representation-only differences: 58 paths present only in the text parser (nested aggregate flattening, e.g. `coord.left`, `foo[N]` arrays)
  and 15 only in the Python extractor (`_vptr.<Base>` entries, arrays as `foo`). No frozen gold label is an aggregate/array member.
- In-repo machine regression: `tests/jev-realgame-final.test.mjs` →
  "independent DWARF extractor retains scalar, pointer and array declarations ending in semicolons" passes on the reviewed integration working tree.

## 6. Conservative exclusions and label qualification

- `RG33 CompanyProperties.max_loan` / `RG44 Window.scale`: classes resolve in exact-build DWARF but the named member is **absent** in both
  extractors → `unverified` ("Named member absent from exact-build DWARF; no source/RTTI guess").
- `RG51–RG54`: `ActorStats` / unqualified `CreatureStats` do not resolve. The GDB dump shows the exact-build DWARF contains
  `MWMechanics::CreatureStats` **and** `ESM::CreatureStats`; an unqualified `CreatureStats.mLevel` label cannot be silently bound, so RG54 is
  excluded conservatively. Machine guard: test "unqualified class labels require verified qualification and cannot guess a namespace" passes.
- `qualifiedAliases` is empty for both binaries (`aliases: 0`), so no alias path is silently used.
- `oracle-authority.json.rejectedSemanticAlternatives` rejects `CreatureStats.mSpells` ("the exact build declares `MWMechanics::Spells`, a
  known-spell container; it cannot prove the magical-energy pool") and supplies **no** replacement gold.
## 7. Gold isolation from production and from Jev input (re-verified)

- `collect-jev-realgame-final.mjs` line 2: "Blind production evidence collection. This process never opens an oracle." It imports only
  `persistentWrite, sha256, verifyCases, snapshotCandidate` from the contract.
- `jev-realgame-final-client.mjs` imports only `requestBody, sha256`; `requestBody` sends `state.userPhrase` + candidate descriptions built by
  `describeCandidate` from binary-derived facts only.
- `snapshotCandidate` (`contract.mjs:32-62`) is an explicit whitelist (key/owner/offset/size/recoveredType/functionContexts/scores) — "Gold labels
  and arbitrary descriptions cannot flow through this boundary".
- The authority producer and scorer reference gold/layout artifacts: `audit-jev-realgame-gold.mjs` ("Evaluation authority only. Never imported by the
  production collector/client") and `evaluate-jev-realgame-final.mjs` (`structuralMatch` / `funnel`, post-hoc scoring).
- Machine guard: test "all representations ignore injected oracle/source fields and arbitrary descriptions" passes on the reviewed integration working tree.

## 8. How the verified gold is scored (no ownership rewrite)

`audit-jev-realgame-gold.mjs:15-25` resolves a label only to an exactly matching layout member (`status: resolved`, unique
`path === label.field`, valid extent). Inherited aliases are expanded (lines 66-72) **only** when exact-build compiler metadata agrees on
`owningClassName`, `owningOffset`, `size`, `type`, and the member sits under an inheritance chain — no production receiver ownership is rewritten.
`structuralMatch` (`contract.mjs:94-104`) then compares `binarySha256 + className + offset + size` and, when the recovered type is proven, the
`allowedCategories` list; candidates flagged `conflict` never match.

## 9. Limitations and blockers

- **Answerable denominator is 49, not 55**: 6 of the 55 originally answerable cases have no provable exact-build structural identity and are excluded
  (never re-labelled, never offset-substituted). 49 cases carry verified structural identities; 15 controls test weak preference versus proof without a gold identity.
- **RG55 depends on the Python extractor's base expansion.** `ptype /o MWWorld::Ptr` does not expand the base's members, so the text parser alone
  would mark it unresolved. Its verification therefore rests on `Type.fields` base metadata, confirmed here by reading the same debug file with GDB 12.1.
- **Aggregate/array path representation is extractor-specific** (`foo[N]` vs `foo`; nested paths vs `isAggregate`). Frozen gold uses scalar members
  only, so this is latent, not active.
- **Layout coverage is scoped to the requested classes** (28 OpenTTD, 15 OpenMW); it is evidence, not a full type database.
- Debug authority was fetched from `ddebs.ubuntu.com` at the recorded URLs/versions with the recorded sha256 (see `oracle-authority.json`).
- No live Jev calls were made, and the live final-evaluation outcome files were deliberately not inspected.

## 10. Production recoverability of the verified identities (blind artifact, counts recomputed here)

Actions `36689172349` @ productSha `a15e196c0d5176870c22c5995b3cf1e1d399adc9`, bound to `caseSha256 05def9…` and per-binary sha256:

| Binary | distinct canonical C++ candidates | distinct classes | named | all in ≤255 shortlist |
|---|---|---|---|---|
| OpenTTD (64 rows) | **47** | 19 | 0 | yes (47/47) |
| OpenMW (6 rows) | **19** | 10 | 0 | yes (19/19) |

These are recovered *structural* candidates (anonymous canonical evidence), not name matches; semantic labels stay evaluation-only.

## 11. Exact commands used

```
sha256sum <frozen openttd/openmw binaries>; readelf -n <binary|debug-file>; sha256sum <*.ddeb>
node -e "… sha256(holdout-cases.json); structural-gold.json status counts …"
gdb -batch -nx -ex "file <openttd debug>" -ex "ptype /o Vehicle"
gdb -batch -nx -ex "file <openmw debug>" -ex "ptype /o MWWorld::Ptr"
node scripts/extract-jev-realgame-layout.mjs --debug-file <openttd debug> --class Vehicle --class CompanyProperties --class Window \
  --out <scratch>/ptype-openttd.json --binary-sha256 8f1686… --build-id d878fe25…
node --test tests/jev-realgame-final.test.mjs; node --test tests/jev-realgame-holdout.test.mjs
```
