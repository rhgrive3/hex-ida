# C++ member candidates in Pinpoint

Branch: `fix/pinpoint-cxx-member-candidates`.

## Cause / first divergence

`createCxxEvidenceProvider.projectForFunction()` already recovers canonical,
receiver-bound members, with offsets, widths, types and accesses. The decompiler
consumes them, but the ObjC-only `FieldIndex` never published them to Pinpoint.
ELF field enumeration therefore returned `no-class-table` / zero candidates.
The first divergence was **canonical projection → field enumeration**, before
ranking or Jev. A second name/intent filter also discarded unnamed members.

Existing RTTI/vtable ownership and symbol proofs establish the receiver;
receiver aliases and member type recovery establish its accesses. Virtual-slot
and indirect-target evidence retain their existing authority and flow. This
change adds publication, with no new recovery, reader, disassembly or callsite
pass. Ambiguous vtable owners remain withheld.

## Data flow / schema

The existing per-slice provider publishes into `CxxMemberIndex`.
`cxxMemberIndexForApp(app)` reads that existing index. `pinpointField()` and the
combined `pinpoint()` share its enumeration with ObjC, then use existing
deterministic evidence fusion/ranking. Investigation and automatic analysis
forward the index; publication revisions expire cached results, and binary /
slice / backend epoch changes expire the index.

| Candidate facts | Representation / authority |
| --- | --- |
| class / owner | `className`, `classIdentity`, `owningClassIdentity`; canonical receiver proof |
| member name | nullable `memberName` / `fieldName`; producer-supplied names only |
| display label | `field.name`, `anonymous`, `syntheticName`; offset labels are never name evidence |
| location / width | `offset`, `size`, `width`; canonical receiver-bound access |
| type | `type`, `recoveredType`; category, alternatives, signedness, rule/reason, width-only status |
| provenance | canonical `{receiver, member}` references, snapshot/function/digests and access counts |
| key | snapshot + structural owner + offset + width + type/sign/alternatives, JSON-encoded; `#` escaped to stay disjoint from ObjC keys |
| confidence | existing deterministic evidence/fusion; no new evidence code or threshold |

Repeated observations deduplicate. Conflicting widths/types remain explicit
separate candidates; retained provenance is bounded to 64 records with count /
truncation flags. Unproven, forged, malformed, adjusted or ambiguous ownership
fails closed. Generic offset scans, shape sites and offset-only function hints
cannot establish a C++ class/member attribution.

## Real binaries / latency

[Exact-SHA Actions validation](https://github.com/rhgrive3/actions/actions/runs/36655237565)
passed on `25c3385aba2a7612802aa0305816f751469690d7`, compared with main
`d2177389cd1770edb3548251a080bf23e829a8a0`. Both sides selected the same 30
existing, uniquely owned functions and used the production Fast decompile
route. Counts cover those analyzed functions, not every field in the binary.

| ARM64 ELF corpus | Candidate count before → after | Classes | Named / unnamed | Key collisions / binding failures |
| --- | ---: | ---: | ---: | ---: |
| OpenTTD 13.4-1build3 | 0 → **47** | 19 | 0 / 47 (100% unnamed) | 0 / 0 |
| OpenMW 0.48.0-1ubuntu5 | 0 → **19** | 10 | 0 / 19 (100% unnamed) | 0 / 0 |

No candidate or provenance truncation occurred. Every ranked C++ field was a
member of the published canonical lattice. Duplicate observations aggregate,
and every published key is distinct. For intent `health`, both verdicts remain
`none`: structural members do not establish health semantics.

| Timing (ms; before → after) | OpenTTD | OpenMW |
| --- | ---: | ---: |
| Fast decompile median | 1612.734 → 1606.713 | 1279.577 → 1199.697 |
| Fast decompile P95 | 14819.937 → 15306.221 | 7767.558 → 7978.581 |
| 30-function total | 90320.721 → 90821.006 | 68570.148 → 65912.269 |
| Publication total / P95 per call | 2.314 / 0.224 | 1.463 / 0.232 |
| Pinpoint field enumeration/rank | 1.988 → 9.811 | 1.221 → 5.990 |

These are one matched cold comparison per binary on Actions, with runner/JIT
variation; they are not a guaranteed speedup. Publication adds milliseconds
across the sample and no reads or analyses. Setup remains existing work
(OpenTTD 22.426 → 22.441 s; OpenMW 126.358 → 129.451 s).

Binary SHA256: OpenTTD
`8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`;
OpenMW `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`.
Official Ubuntu noble packages; verifier records corpus hash, exact SHA, script
hash, sample addresses, per-function outcomes and timings in uploaded JSON.
The first run's artifact-copy error was corrected; failed runs are excluded
from passing evidence.

## Focused tests / limits / Jev handoff

Focused regressions cover named/unnamed members, repeated names across classes,
multiple members, offset/type/width differences, partial RTTI, no-proof and
malformed/forged cases, collisions/deduplication, ownership conflicts, ObjC
ranking, public/automatic publication, epoch/cache expiry and offset-only
misattribution. The unchanged Jev shortlist/fail-closed tests are also exercised.
The full-gate repairs use an explicit local D1 sentinel fixture and preserve
historical Jev source/artifact hashes. Router continuity checks pin the exact
current file and the unchanged old body outside two exact C++ safeguards;
negative controls reject policy drift even if the current-file hash is refreshed.

Only **already analyzed** canonical projections are published. RTTI/vtables
alone do not prove fields; metadata-only queries can still have zero members.
The existing production projection hook and real-binary validation are ARM64;
x86_64 semantic decompilation does not currently invoke this receiver/member
producer, and this branch does not add that recovery. Free/static functions,
adjusted receivers, ambiguous owners and missing binding remain unavailable.
Indexed or mixed-width access records without a fixed member width are withheld.
Existing recovery budgets and Pinpoint's 400-entry bound remain. The current
producer supplies types/accesses but no recovered member names; supplied names
are preserved by the canonical schema and tested without semantic guessing.

Jev evaluation can call:

```js
const result = await pinpointField({ goal, fields: app.fields,
  cxxFields: cxxMemberIndexForApp(app), limit: 400 });
const reranked = await rerankWithJev(intent, result, existingOptions);
```

The same candidate objects/keys enter Jev after deterministic ranking. Jev
selects only existing candidates. Prompts, descriptions, routing, thresholds,
default enablement, prospective evaluation and Sparkle/XADMaster holdouts are
unchanged. All structural facts remain deterministic Hex authority.
