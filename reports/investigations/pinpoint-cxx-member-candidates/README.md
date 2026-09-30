# C++ member publication into Pinpoint

Branch: `fix/pinpoint-cxx-member-candidates`.

## Cause and first divergence

`createCxxEvidenceProvider.projectForFunction()` already produces canonical,
receiver-bound members with offsets, access widths, recovered types and access
counts. They reach the decompiler through `cxxEvidence`, but never enter the
Objective-C-only `FieldIndex`. `pinpointField()` returns `no-class-table` for an
ELF without ObjC metadata. Even after publication, the old intent/name filter
would discard unnamed C++ members.

The first divergence is the missing publication between the canonical C++
projection and field enumeration, before deterministic ranking or Jev.

## Data flow and interface

The existing per-slice C++ provider publishes its canonical projections into
`CxxMemberIndex`. `cxxMemberIndexForApp(app)` reads the existing index without
starting analysis. Pinpoint accepts `cxxFields` alongside `fields`; its shared
field view enumerates both into the existing evidence fusion and ranking.
Investigation and automatic analysis pass that same index, and publication
revisions invalidate cached results. A binary/slice/generation change expires
the index.

C++ candidates retain `className`, `field.name`/`memberName`, `offset`, `size`/
`width`, `type`/`recoveredType`, `classIdentity`/`owningClassIdentity`,
`provenance`, and a stable structural `key`. Provenance retains canonical
receiver/member objects and their function, snapshot, binding, access and type
rules. Missing names become offset labels, never inferred semantic facts.
Unknown types remain explicit.

Repeated observations deduplicate by owner/location/width/type. Distinct owners
and conflicting width/type observations retain distinct identities. Unproven,
replayed, malformed or unsupported ownership evidence is withheld.

Anonymous members remain in the shared ranked lattice after literal narrowing.
Generic ObjC accessor verification, global offset scans and shape-site fallback
cannot add evidence to a C++ candidate. Already proven accesses can contribute
existing deterministic evidence when a separate intent match exists.

`rerankWithJev(query, result, options)` receives the ordinary Pinpoint result
and candidate objects. No separate Jev candidate universe, prompt change,
routing change, confidence change, or evaluation-policy change is introduced.

## Validation

Focused tests cover named/unnamed members, owners with identical names,
multiple locations and type/width conflicts, partial RTTI, binding failures,
malformed/forged evidence, duplicate/key collisions, ObjC compatibility,
production Fast publication, cache invalidation and the existing Jev boundary.

Real-binary counts and matched before/after timings are pending exact-SHA
Actions validation. Corpus: Ubuntu noble ARM64 OpenTTD 13.4-1build3 and OpenMW
0.48.0-1ubuntu5. Validation samples existing recovered vtable functions and
executes the production Fast decompile route; it does not add a production
whole-binary recovery pass.

## Limits

The lattice contains members of functions already analyzed by the existing
C++ producer. RTTI/vtables alone do not prove fields. Static/free functions,
adjusted/secondary receivers, ambiguous owners and missing receiver proof
remain unavailable. Stripped builds usually provide offset labels rather than
member names. Structural recovery does not establish which field implements a
natural-language concept. Existing recovery budgets and Pinpoint's 400-entry
ranking bound still apply. No deep analysis pass moves into Fast.
