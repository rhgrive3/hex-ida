# Implementation Plan: Versioned Language and Runtime Metadata Providers (HEX-C3-03)

## Architecture Overview

```
                           Binary Input (Mach-O / ELF / PE)
                                         │
                   ┌─────────────────────┴─────────────────────┐
                   │                                           │
                   ▼                                           ▼
      ┌─────────────────────────┐                 ┌─────────────────────────┐
      │  DebugInfoProvider      │                 │ LanguageMetadataProvider│
      │  (DWARF / PDB)          │                 │ (ObjC, Swift, Go, Rust) │
      └────────────┬────────────┘                 └────────────┬────────────┘
                   │                                           │
                   │                                           ▼
                   │                              ┌─────────────────────────┐
                   │                              │  LanguageMetadataResult │
                   │                              │  - Ecosystem & Version  │
                   │                              │  - Identity Verdict     │
                   │                              │  - Records & Complete   │
                   │                              └────────────┬────────────┘
                   │                                           │
                   ▼                                           ▼
      ┌─────────────────────────────────────────────────────────────────────┐
      │                     TypeConstraintGraph Gate                        │
      │  isAuthoritative(identity) && isRecordAuthoritative(...)           │
      │    -> addHardConstraint (nominal, structural, type claims)         │
      │    -> else addSoftEvidence / retain diagnostic candidate            │
      └──────────────────────────────────┬──────────────────────────────────┘
                                         │
                                         ▼
                   ┌─────────────────────────────────────────┐
                   │ Downstream Consumers:                   │
                   │ - Discovery (functionCandidates)        │
                   │ - Runtime Calls (classifyRuntimeCall)   │
                   │ - Decompiler Type Recovery              │
                   │ - Prototype / Symbol Viewers            │
                   └─────────────────────────────────────────┘
```

## Phase Breakdown

1. **Phase 1: Common Metadata Boundary & Provider Contract**
   - Implement `js/metadata/provider.js`:
     - `createLanguageMetadataIdentity`, `isAuthoritative`, `isLanguageRecordAuthoritative`
     - `createLanguageMetadataRecord`, `createLanguageMetadataPage`, `createLanguageMetadataResult`
     - `LanguageMetadataProvider` base class with paged accessors and identity gate
     - `applyLanguageMetadataTypesToGraph(graph, result, page)`
     - `languageMetadataFunctionEvidence(result, page)`
   - Unit tests: verify identity verdict gating, coverage filters, fail-closed partial behavior, and hard vs soft graph constraints.

2. **Phase 2: Go Metadata Provider**
   - Implement `js/metadata/go.js`:
     - Pclntab parser supporting Go 1.2, 1.16, 1.18, 1.20+ with magic headers (`0xfffffffb`, `0xfffffffa`, `0xfffffff0`, `0xfffffff1`).
     - Safe paged function table reader, string reader, PC-line/PC-file decoder.
     - Moduledata & type descriptor parser for Go struct/interface/slice/map/func types.
     - Toolchain identification from `.go.buildinfo`, `runtime.buildVersion`, and pclntab magic.
     - Strict bounds checking, pathological count rejection, cyclic table protection.
     - Stripped and malformed fail-closed tests.

3. **Phase 3: Rust Metadata Provider**
   - Implement `js/metadata/rust.js`:
     - Demangler & parser for Rust v0 (`_R...`) and legacy (`_ZN...17h...E`) symbols.
     - Compiler/toolchain identity extractor from `.comment`, `.note.rustc`, and symbol fingerprints.
     - Trait vtable extractor (`<Type as Trait>::vtable`).
     - Rust type layout safety gate: `repr(Rust)` structs have compiler-dependent field ordering; only `repr(C)` / primitives / DWARF-backed types are marked layout-stable.
     - Malformed symbol tests, recursion depth limits, stripped binary tests.

4. **Phase 4: Swift & Objective-C Integration**
   - Implement `js/metadata/swift.js` & `js/metadata/objc.js`:
     - Wrap `js/swift.js` and `js/apple/objc-metadata.js` / `js/apple/objc-runtime.js` into the unified `LanguageMetadataProvider` contract.
     - Audit Swift context descriptor kinds, fail-closed for unknown kinds > 18.
     - Preserve ObjC completeness accounting and IMP validation requirements.

5. **Phase 5: Unified Entrypoint & Central Registry**
   - Implement `js/metadata/index.js`:
     - `parseLanguageMetadata(context, options)`: scans sections, invokes relevant ecosystem providers, merges results, preserves ambiguities.
     - `classifyLanguageRuntimeCall(symbol, context)`: extends runtime call classification to Go, Rust, Swift, and ObjC.

6. **Phase 6: Downstream Wiring & Integration**
   - Wire language metadata into `js/analysis/index.js` (`TypeConstraintGraph`).
   - Wire function discovery into `DiscoveryProducerRegistry` / `functionCandidates`.
   - Wire call resolution into `js/apple/runtime.js`.
   - Ensure non-regression of C3-02 ABI classification.

7. **Phase 7: Comprehensive Test Matrix & Invariant Validation**
   - Focused unit tests for every ecosystem and boundary.
   - Malformed, truncated, future-magic, and stripped matrices.
   - Canonical repo gates: lint, invariant gates, module boundaries, full check suite, exact-head CI.
