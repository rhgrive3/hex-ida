# Feature Specification: Versioned Apple Metadata and Fixup Knowledge (HEX-X-02)

**Feature Branch**: `work/x02-complete`

**Created**: 2026-09-03

**Status**: Implementation Hardened / Independent-Oracle Verification Blocked

## Finding Contract

- **FINDING_ID**: HEX-X-02
- **PROBLEM**: Mach-O build identity, dyld shared-cache layout, chained pointers, Swift/Objective-C providers, arm64e authentication metadata, and code-signing consequences are currently reported by separate parsers. Consumers cannot distinguish a fully identified Apple artifact from a partial or future format, and authenticated pointer fields and signature structure are not available through one fail-closed contract.
- **FIRST_DIVERGENCE**: A chained pointer format may have a known storage width but no decoder, authenticated pointers lose diversity/key/address-discrimination fields at publication, and an `LC_CODE_SIGNATURE` is reduced to presence without parsing its bounded SuperBlob structure. No single result binds these facts to one binary/slice identity.
- **CANONICAL_OWNER**: `js/binary/macho-dyld.js` remains the sole chained-pointer decoder; `js/binary/macho-core.js` remains the Mach-O load-command authority; `js/metadata/{swift,objc}.js` remain language-metadata authorities. `js/apple/knowledge.js` only normalizes their evidence into a versioned Apple matrix and parses Apple-specific shared-cache/signing containers that have no existing owner.
- **CANONICAL_FACT**: `AppleKnowledgeResult/v1`, bound to exact binary and slice identities, contains independent dyld-cache, chained-fixup, Swift, Objective-C, PAC/authentication, and signing cells. Every cell has an explicit status, format/version identity, completeness reasons, and exact byte/address provenance.
- **IDENTITY_SOURCE**: Parser-derived SHA-256 identity over resident input bytes, parser-issued Mach-O/cache artifact identity, exact architecture/slice identity, chained-fixups header and pointer-format number, producer-issued language-provider evidence, and CodeDirectory structural fields. Caller labels never create authority.
- **PROVENANCE_SOURCE**: Exact file offsets, virtual addresses, table indexes, raw words, load-command offsets, and provider identities. A raw word, decoded target, bind ordinal, and authentication metadata remain separate fields.
- **COMPLETENESS_SOURCE**: Bounded count/range validation, supported-version tables, per-chain termination, import/symbol completeness, provider verdicts, and structural signing parse results.
- **INVALIDATION_SOURCE**: Any input-byte/slice identity, architecture, provider version, metadata version, raw pointer word, load-command range, or rebuilt output change.
- **CONSERVATIVE_BOUNDARY**: Unknown/future versions and formats remain `unsupported`; malformed ranges remain `malformed`; partial evidence remains partial; overlapping cache mappings remain ambiguous; code-signature presence or structural correctness never means cryptographic or platform validity.
- **NON_GOALS**: Decoding dyld cache slide-info generations, extracting complete cache images, signing/resigning, validating CMS trust, validating PAC cryptography, changing MachineEffects, adding a second Swift/ObjC parser, or claiming full F3/F6 support.
- **FORBIDDEN_SHORTCUTS**: Guessing future layouts, canonicalizing PAC bits into an address, selecting one overlapping mapping, accepting truncated strings/tables, trusting cloned/manual provider or cache shapes, treating shortened chained page tables as complete, reusing writer output as independent proof, or claiming a signature valid without an authoritative external validator.

## Acceptance Scenarios

1. A known dyld v1 cache header and mapping table yields versioned mapping facts with exact header/table offsets, UUID, architecture, and parser-derived resident-byte identity.
2. Unknown cache magic, unreasonable counts, truncated mappings, file-range overflow, and overlapping mappings fail closed; overlaps retain every candidate.
3. Chained formats 1/2/3/4/5/6/7/9/10/12 distinguish bind from rebase and authenticated from unauthenticated records; format 4 resolves only against an authoritative shared-cache base, and formats without a decoder remain unsupported.
4. Authenticated arm64e records publish key, diversity, and address-diversity separately from raw, target, ordinal, and addend.
5. Chained import names, ordinals, addends, symbol-pool boundaries, page starts, and next deltas reject truncation, overflow, and out-of-range references.
6. A bounded embedded-signature SuperBlob and CodeDirectory yield structural facts only, with `validity: unknown`; malformed or overlapping blob ranges are rejected.
7. Any byte mutation covered by a CodeDirectory is reported as requiring authoritative revalidation/resigning. A no-op or uncovered mutation still cannot become a signature-valid claim.
8. Swift and Objective-C cells retain their provider verdicts and ambiguity/completeness rather than being promoted by the Apple matrix.
9. Serialization is deterministic and retains BigInt offsets/candidate evidence, but deliberately withdraws every complete/authoritative verdict. Reparse rejects any serialized payload that tries to restore such authority; raw bytes/providers must be rerun.
10. A rebuilt Mach-O is freshly reparsed by the canonical loader and independently inspected where a fixture/tool exists; the lane makes no platform-signing-valid claim.
11. Positive and negative completeness requires an immutable module-issued result bound to the exact binary/slice/architecture and a provider created from the parser-owned section snapshot and canonical byte reader through an immutable lexical implementation; exported prototype/instance/subclass replacements, missing/custom readers, copied/caller-mutated sections, proxy results, missing source identity, cloned/manual evidence, incomplete load-command discovery, and partial chained coverage remain incomplete.
12. CodeDirectory page-size zero uses its infinite-page meaning; supported hash types have exact ABI widths, reserved fields are zero, and every version-dependent offset stays within its blob.

## Required Test Matrix

- Positive, negative, adversarial, boundary, and regression cases.
- 32/64-bit chained widths, little/big-endian structured containers, signed addends, maximum ordinals, page and file-range edges, and integer overflow.
- Malformed chains, imports, symbol names, cache mapping tables, SuperBlob indexes, and CodeDirectory ranges.
- Authenticated bind/rebase, unauthenticated bind/rebase, unknown pointer format, and raw-word mismatch.
- Swift/ObjC authoritative, partial, ambiguous, missing, and malformed provider states.
- Deterministic encode/decode and writer-independent rebuild/reparse evidence where repository fixtures support it.
- Sparse source-backed and resident parsing of signed thin/fat Mach-O, exact container-relative provenance, CodeDirectory `codeLimit64`/infinite-page/hash/version bounds, storage width versus chain stride, exact page-count coverage, duplicate sites, missing starts, and early-budget later-segment ownership.
- Changed-file ownership, module-boundary/syntax checks, `git diff --check`, and focused regressions.
