# Feature Specification: Versioned Language and Runtime Metadata Providers

**Feature Branch**: `feat/analysis-hex-c3-03-versioned-language-metadata`

**Created**: 2026-08-31

**Status**: In Implementation / Verification

**Input**: User description: "Close HEX-C3-03 versioned language metadata providers across Go, Rust, Swift, and Objective-C with canonical facts, fail-closed boundaries, version identity, and downstream TypeConstraintGraph wiring."

## Finding Contract

- **FINDING_ID**: HEX-C3-03
- **PROBLEM**: Language and runtime metadata providers are fragmented across ecosystems. Swift and Objective-C have partial models without a unified cross-ecosystem identity contract; Go (pclntab/moduledata) and Rust (v0/legacy mangling, toolchain identity, vtable metadata, type layout safety) are fragmented or shallow. When version, toolchain, or metadata format is unknown or malformed, heuristics risk guessing layouts or minting false exact types/functions.
- **FIRST_DIVERGENCE**: When encountering unrecognized or future runtime metadata versions, malformed structures, stripped binaries, or ambiguous toolchain evidence, systems lacking explicit versioned contracts either crash, guess current-version layout, or promote unproven heuristics to exact canonical types.
- **CANONICAL_OWNER**: `js/metadata/**` (or `js/analysis/metadata/**`) owns language/runtime metadata providers, toolchain/version detection, and unified provider results; `js/analysis/types/**` (`TypeConstraintGraph`) owns type constraint consumption; `js/apple/runtime.js` and `js/recognition/classifier.js` consume runtime call/classification contracts; discovery consumes function candidate evidence.
- **PRODUCER**: Architecture/binary-format readers and language metadata providers (ObjC, Swift, Go, Rust) produce versioned identity, nominal types, method/vtable tables, function descriptors, conformances, and completeness facts.
- **CANONICAL_FACT**: A versioned `LanguageMetadataResult` containing `ecosystem`, `identity` (verdict, providerId, providerVersion, toolchainVersion, binaryIdentity, architecture, platform), `records` (symbols, types, vtables, conformances, fields, methods), and `completeness` (present, declared, scanned, parsed, unreadableEntries, invalidEntries, complete).
- **IDENTITY_SOURCE**: Proven compiler/toolchain version, runtime header magic (e.g. Go pclntab magic `0xfffffffb`, `0xfffffffa`, `0xfffffff0`, `0xfffffff1`), Swift section/descriptor flags and ABI version, ObjC runtime version, Rust `.comment`/`.note` and mangling generation, bound to verified binary slice identity.
- **PROVENANCE_SOURCE**: Exact section origin, descriptor address, table index, byte offset, and provider identity; never string guesses or bare symbol names.
- **COMPLETENESS_SOURCE**: Explicit count accounting (`declared`, `scanned`, `parsed`, `unreadableEntries`, `invalidEntries`, `complete`), budget bounds, and reference resolution proof.
- **INVALIDATION_SOURCE**: Binary identity, slice identity, target architecture/platform, provider version, compiler/toolchain version, or changed byte buffers.
- **DIRECT_CONSUMERS**: `TypeConstraintGraph` (hard constraints for authoritative facts, soft evidence for unverified/partial facts), `functionCandidates` / discovery, `classifyRuntimeCall`, decompiler type recovery, and symbol presentation.
- **DOWNSTREAM_CONSUMERS**: Decompiler signatures, call-site analysis, points-to summaries, query surfaces, and UI viewers.
- **POSITIVE_CASES**: Supported and identity-proven Go (1.2, 1.16, 1.18, 1.20+), Swift 5 nominal/field/protocol/conformance/vtable/witness tables, ObjC 2.0 classes/methods/protocols/categories with executable IMP proof, and Rust v0/legacy demangled symbols and vtables.
- **NEGATIVE_CASES**: Missing version, unknown future version/magic, older unsupported version, malformed/truncated metadata, out-of-bounds pointer/index, wrong endian/architecture/platform, stale binary identity, conflicting/mixed evidence, stripped binary, corrupted lengths/counts, and unsupported feature flags.
- **CONSERVATIVE_BOUNDARY**: Only identity-proven, structurally complete metadata may emit hard constraints into `TypeConstraintGraph` or exact function candidates into discovery. Unproven, partial, ambiguous, or malformed metadata emits soft evidence or explicit diagnostic warnings, never promoted to exact truth.
- **NON_GOALS**: Inventing speculative layouts for unknown future compiler versions; guessing unproved struct field layouts in `repr(Rust)`; treating stripped binaries as having metadata; bypassing `TypeConstraintGraph`; or overriding ABI C3-02 classifications.
- **FORBIDDEN_SHORTCUTS**: Guessing unknown versions as current; promoting heuristics or high confidence to exact authority; silently picking one candidate from conflicting metadata; ignoring malformed/truncated errors; laundering unverified names into struct layouts; denominator/assertion weakening.

## User Scenarios & Testing

### User Story A - Known, Supported, Identity-Proven Metadata → Exact Canonical Facts (Priority: P1)

An analyst inspecting a binary built with a supported toolchain (Go 1.16/1.18/1.20+, Swift 5, ObjC 2.0, Rust) receives exact canonical function definitions, nominal types, method dispatches, and vtable structures.

**Acceptance Scenarios**:
1. **Given** a Go binary with valid pclntab 1.18/1.20+ and moduledata, **When** metadata parsing runs, **Then** all declared functions, names, entrypoints, and type descriptors are emitted with `matched-authoritative` identity and complete status.
2. **Given** a Swift 5 binary with nominal type descriptors and complete field descriptors, **When** parsed, **Then** exact nominal types, field names, and vtable entries are emitted into the canonical metadata model.
3. **Given** an ObjC binary with complete method lists and verified executable IMPs, **When** indexed, **Then** unique IMP resolutions and class hierarchies are published with authoritative identity.
4. **Given** a Rust binary with v0/legacy mangled symbols and vtables, **When** demangled and parsed, **Then** crate/trait/method structures are resolved cleanly with exact provenance.

### User Story B - Unknown / Future Toolchain or Metadata Version → Explicit Partial/Unsupported (Priority: P1)

An analyst inspecting a binary with an unrecognized future metadata header magic, unknown Swift descriptor kind, or future compiler format receives explicit `unsupported` or `matched-partial` status, and the parser NEVER guesses current-version layouts.

**Acceptance Scenarios**:
1. **Given** a Go binary with an unknown future pclntab magic (e.g. `0xffffffef`), **When** metadata parsing runs, **Then** the result has `verdict: 'unsupported'`, `authoritative: false`, and no fabricated functions or types are created.
2. **Given** a Swift binary with an unknown future context descriptor kind (`kind > 18`), **When** parsed, **Then** the descriptor is flagged as unsupported and does not emit guessed struct/class fields.
3. **Given** a Rust binary with unknown compiler version and `repr(Rust)` structs, **When** analyzed, **Then** internal compiler struct layouts are NOT assumed to match any specific version.

### User Story C - Malformed / Truncated / Corrupt Metadata → Bounded Failure & Incompleteness (Priority: P1)

An analyst inspecting a truncated, corrupt, or adversarial binary never encounters an unhandled exception, unbounded loop, or out-of-bounds read; the parser terminates within budget and marks the result incomplete.

**Acceptance Scenarios**:
1. **Given** a truncated pclntab, corrupted function count (e.g. `0x7fffffff`), or cyclic string table, **When** parsed, **Then** the parser stops safely within its budget, records `complete: false`, and emits diagnostics.
2. **Given** a Swift field descriptor with unreadable bytes or truncated symbolic reference payload, **When** parsed, **Then** `complete: false` and the error reason are retained.
3. **Given** an ObjC method list with invalid stride or unreadable pointer slot, **When** parsed, **Then** `invalidEntries` is incremented and `complete: false` is published.
4. **Given** a malformed Rust v0 symbol (invalid hex, unclosed delimiter), **When** demangled, **Then** it fails safely (`parsed: false`), returning original text without crashing.

### User Story D - Conflicting / Mixed Metadata → Ambiguity Preserved (Priority: P2)

When a binary contains conflicting evidence (e.g. overlapping symbols with different types, multiple matching IMPs, or mixed Swift/ObjC candidates), the system preserves all candidates rather than silently selecting an arbitrary winner.

**Acceptance Scenarios**:
1. **Given** multiple ObjC methods sharing the same IMP or a partial runtime index, **When** `resolveObjcIMP` is called, **Then** all candidates are returned and confidence is kept non-authoritative.
2. **Given** ambiguous Swift witness tables or unresolved symbolic references, **When** dispatch is resolved, **Then** candidates are retained and `complete: false` is recorded.
3. **Given** contradictory type claims from different metadata sources, **When** fed to `TypeConstraintGraph`, **Then** selection is withheld and a contradiction is recorded.

### User Story E - Downstream Consumers Obey Identity & Completeness Contract (Priority: P1)

Downstream consumers (TypeConstraintGraph, function discovery, call classification, decompiler) consume metadata strictly through the canonical gate: hard constraints are emitted ONLY when identity is authoritative and complete.

**Acceptance Scenarios**:
1. **Given** an authoritative complete metadata result, **When** `applyLanguageMetadataTypesToGraph` is called, **Then** `addHardConstraint` is invoked for covered types.
2. **Given** an unverified, partial, or heuristic metadata result, **When** applied to the graph, **Then** only `addSoftEvidence` is invoked.
3. **Given** function discovery evidence from language metadata, **When** fused, **Then** authoritative results emit `exact` confidence and partial results emit `heuristic`.

### User Story F - Stripped / Minimal Binary → Zero Fabricated Structures (Priority: P1)

An analyst opening a stripped binary without language metadata sections receives a clean empty/absent result with `verdict: 'identity-unavailable'` and zero fabricated types, functions, or vtables.

**Acceptance Scenarios**:
1. **Given** a stripped Go/Rust/Swift/ObjC binary with no runtime metadata sections, **When** parsed, **Then** the provider returns `present: false`, `records: []`, and no artificial names or types are minted.
