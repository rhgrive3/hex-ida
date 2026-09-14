# Tasks: Versioned Language and Runtime Metadata Providers (HEX-C3-03)

- [x] T001: Implement Common Metadata Boundary & Contract in `js/metadata/provider.js`
- [x] T002: Add unit tests for Common Metadata Boundary in `tests/metadata-provider-contract.test.mjs`
- [x] T003: Implement Go Metadata Provider & Pclntab/Moduledata Parser in `js/metadata/go.js`
- [x] T004: Add focused tests for Go metadata (versions 1.2, 1.16, 1.18, 1.20+, malformed, stripped, future magic) in `tests/metadata-go.test.mjs`
- [x] T005: Implement Rust Metadata Provider & Demangler / VTable / Layout Safety in `js/metadata/rust.js`
- [x] T006: Add focused tests for Rust metadata (v0, legacy, toolchain identity, vtables, layout safety, malformed) in `tests/metadata-rust.test.mjs`
- [x] T007: Implement Swift & ObjC unified adapters in `js/metadata/swift.js` and `js/metadata/objc.js`
- [x] T008: Add focused tests for Swift & ObjC unified adapters and unknown-kind fail-closed behavior in `tests/metadata-apple.test.mjs`
- [x] T009: Implement Unified Central Metadata Registry & Runtime Call Classifier in `js/metadata/index.js`
- [x] T010: Wire unified metadata into `TypeConstraintGraph`, function discovery, and runtime call classifier in `js/analysis/` and `js/apple/runtime.js`
- [x] T011: Add downstream integration tests verifying `TypeConstraintGraph` hard/soft constraint emission and function discovery in `tests/metadata-downstream-integration.test.mjs`
- [x] T012: Run complete test suite and canonical verification gates (`npm run check` and `npm test`)
- [x] T013: Self-review 3 passes (False precision, Architecture/duplication, Regression/integration)
- [x] T014: Update ledger in `docs/analysis-improvement-finding-ledger.md`
