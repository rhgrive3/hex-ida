# fresh-holdout — selection authority and exact-build proof

Status: **frozen before any parent evaluator run**
Author: Freebuff4 (fresh-holdout lane), 2026-09-30T10:48:00.830Z
Schema: `hex-jev-fresh-holdout/v1`

## 1. What this is

A new, untouched holdout of 40 verified scalar member queries
(20 OpenTTD, 20 OpenMW) plus 10 natural unanswerable controls, prepared to assess generic
recovery improvements **independently of the parent implementation**. The corpus
is frozen (`fresh-holdout-freeze.json`) before the parent runs any evaluator.

## 2. Independence / non-inspection statement

Read (and why):

- `docs/ENGINEERING_PROCESS_GUARDRAILS.md` — mandatory process rules.
- `evidence/jev-realgame-final/layout-openttd.json`, `layout-openmw.json` — the exact-build
  oracle layouts explicitly authorised as the current-report authority; used both as a
  source of audited identities and as an independent cross-check of my own extraction.
- `checkpoints/jev-realgame-final/case-inventory.txt` — original70 **case labels only**, used
  solely to exclude duplicate gold fields and duplicate query wording.
- `scripts/jev-realgame-gdb-layout.py` — the retained extraction script the task requires.
- `evidence/jev-realgame-final/run-openttd-extraction.sh` / `run-openmw-extraction.sh` — the
  exact-build collection provenance (package, build-id, debug path), nothing about recovery.
- The durable handoff log of the previous fresh-holdout lane (its reasoning only).

Deliberately **not** read: any parent recovery implementation or probe code, any Jev
execution output (summary/raw results, control results, recovery control results), any
candidate snapshot, `structural-gold.json`, and any evaluation output. Gold/source names
appear only in the original70 label file and in this frozen corpus.

Disclosure: one early repository-wide literal search for the token `original70` returned
five matching lines (usage strings of an evaluation script and three lines of a policy
freeze document). No recovery logic and no evaluation outcome was opened. Every other
command in this lane was limited to the exact-build layouts/DWARF, the original70 labels,
my own extraction artifacts and my own logs.

## 3. Exact-build proof

| | OpenTTD | OpenMW |
|---|---|---|
| package | openttd-dbgsym (Ubuntu noble ddebs, 13.4-1build3 arm64) | openmw-dbgsym (Ubuntu noble multiverse, 0.48.0-1ubuntu5 arm64) |
| binary SHA-256 | `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5` | `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db` |
| build-id | `d878fe2573ea43be2209d5ea5afef0b476f39d70` | `eef0625b6b9af7971e72c4fc8260258b50dcae43` |
| debug file | `/mnt/workspace/.dev-state/agent-work/checkpoints/jev-realgame-final/openttd-dbgsym/usr/lib/debug/.build-id/d8/78fe2573ea43be2209d5ea5afef0b476f39d70.debug` | `/mnt/workspace/.dev-state/agent-work/checkpoints/jev-realgame-final/openmw-dbgsym/usr/lib/debug/.build-id/ee/f0625b6b9af7971e72c4fc8260258b50dcae43.debug` |
| debug SHA-256 | `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be` | `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41` |
| source label | Ubuntu noble exact build | Ubuntu noble exact build |

Re-verified in this lane, not merely copied:

- `sha256sum` of both binaries and both debug files reproduced the values above
  (they are also the values recorded in the authorised layouts).
- `readelf -n` reproduced build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70` for `openttd` and
  `eef0625b6b9af7971e72c4fc8260258b50dcae43` for `openmw`. Per the handoff correction, **only** the
  `openmw` binary is used as debug authority; `openmw-essimporter` shares nothing with it and
  was never used.
- Extraction command pattern (both games), run with TMPDIR/TMP/TEMP pointed at
  `/mnt/workspace/.dev-state/agent-work/scratch`:

  ```
  gdb -batch -nx -ex "file <exact-build debug file>" -x scripts/jev-realgame-gdb-layout.py
  ```

  driven by `HEX_ORACLE_CLASSES` / `HEX_ORACLE_OUTPUT` in
  `scratch/jev-realgame-final/fresh-holdout/`. My own outputs:
  - `openttd-verify-layout.json` (9 classes, defining classes of every OpenTTD gold)
  - `openmw-extra-layout.json` (40 candidate classes: MWWorld::, MWMechanics::, MWGui::,
    MWInput::, ESM:: gameplay/session/UI classes)

- Every OpenTTD identity was checked **twice**: against my own retained-script extraction
  and against the authorised `layout-openttd.json` — offsets, sizes and types agree
  exactly for all 20. Every OpenMW identity comes from my own extraction; where the
  authorised `layout-openmw.json` contains the class (`MWMechanics::CreatureStats`) the two
  agree exactly as well.

## 4. Selection rules applied

1. **Scalar only.** The gold is a direct member of its declaring class with a scalar type
   (integer, bool, float, enum, small fixed type). Aggregates, `_vptr`, pointers to
   objects, `std::vector`/`std::string`/`std::map` members and array members are excluded.
2. **Declaring-class identity.** `identities[].compilerClass` is the DWARF class that
   declares the member, with base-class adjustments already applied by the retained
   script, so the offset is valid for the queried object too. Where an inherited view is
   equally valid at the same offset it is recorded as an explicit alternative
   (`Station::build_date`, `Company::face`).
3. **Understandable semantics.** Only gameplay/UI/session meaning a human would describe
   in words. vptr, container bookkeeping and internal plumbing fields are excluded.
   Where a neighbouring field with adjacent meaning exists it is listed in
   `neighbouringFieldsConsidered` instead of being silently ignored.
4. **Natural queries.** Each query is a plain English description of the meaning. No query
   contains a source field spelling, an offset, a type name or a class name.
5. **No original70 overlap.** Gold field identities (and the alternative identities the
   original70 recorded) and query wording were checked programmatically against
   `case-inventory.txt`; the build script aborts if any match appears. Result:
   `overlapFound: false`.
6. **No preference for already-recovered fields.** Recovery outputs were never opened, so
   no selection could be biased towards or away from them.
7. **Ambiguity preserved.** Cases whose meaning could plausibly be answered by a different
   existing field keep that field visible as an `alternatives`/`neighbouringFieldsConsidered`
   entry rather than being narrowed or dropped.

## 5. Controls

Ten natural questions in the same style as the verified ones, each marked `status: control`
with empty `identities`. Absence is argued from the exact-build DWARF identifier catalogs
(77,248 identifiers for OpenTTD, 186,320 for OpenMW, produced with
`readelf --debug-dump=info` in this lane's scratch directory): every token in
`absenceEvidence.tokens` was searched in both catalogs and every hit was reviewed —
all remaining hits are unrelated string-table/enum identifiers (documented per case in
`absenceEvidence.review`). No struct member in either binary describes any control concept.
Controls reuse no wording from the original70 control set (RG56–RG70).

## 6. Limitations, stated honestly

- The corpus is limited to fields whose identity could be proven from the exact-build
  DWARF in this lane. Nothing was inferred from source, RTTI or memory of the games; where
  a semantic reading was not defensible the field was dropped rather than guessed.
- OpenMW needed extra classes, so a curated candidate list (gameplay/session/UI classes)
  was run through the retained script; unresolved names are simply absent from my
  extraction and were never used as gold.
- Controls prove *identifier-level* absence plus reviewed matches, not a formal proof over
  every DWARF byte; the review text for each control records exactly what was found.
- Two inherited-view alternatives (`Station::build_date`, `Company::face`) share their
  defining class offset because the base subobject sits at offset 0; this is stated in the
  alternative's `note` instead of being hidden.

## 7. Files

- `fresh-holdout.json` — the 50 cases (`sha256 31a0247628db0e651da39a1108c80f4f2e667b9f7d7d569cefd6611153a2c397`)
- `fresh-holdout-authority.md` — this document
- `fresh-holdout-freeze.json` — freeze record with hashes of both files and of the
  canonical cases array (`sha256 b6e4155d09a426de91f50b8d2ded587b124a9f5e9538dca0c54d2555b8b97e5c`)

The parent is expected to validate and freeze the representation/routing independently
before reading any outcome.
