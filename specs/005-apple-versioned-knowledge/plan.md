# Implementation Plan: Versioned Apple Metadata and Fixup Knowledge (HEX-X-02)

## Production Boundaries

1. Extend the canonical chained-pointer decoder in `js/binary/macho-dyld.js` for the already recognized 32-bit cache and firmware formats, and publish immutable site evidence without changing pointer authority.
2. Add `js/apple/knowledge.js` for bounded dyld shared-cache header/mapping parsing, embedded-signature structure parsing, signing-consequence classification, and assembly of the versioned Apple matrix.
3. Teach `js/binary/macho-core.js` to retain `LC_CODE_SIGNATURE` command provenance and parse it through the Apple signing parser.
4. Keep Swift/ObjC parsing in their existing providers; the matrix consumes their versioned results verbatim.
5. Provide deterministic JSON-safe serialization/reparse helpers that preserve BigInt evidence, ordering, and provenance while stripping non-transferable completeness/authority.
6. Let the synchronous parser request exactly the declared signing bytes from `SparseByteBuffer`, retaining fat-container offsets without materializing the whole slice.

## Trust Boundaries

- `macho-dyld.js` owns bind/rebase decoding and page/site identity.
- `macho-core.js` owns Mach-O load-command and slice ranges.
- `metadata/swift.js` and `metadata/objc.js` own language facts.
- `apple/knowledge.js` owns only Apple container facts and cross-provider reporting.
- Signing structure is local evidence. Cryptographic/platform validity remains unknown unless a future separately trusted validator contract is added.
- A module-issued in-memory matrix is immutable. Its serialized form is evidence-only and cannot grant complete cell, binary/slice authority, signing authority, or serializer authority to a cloned shape.
- Rebuild proof continues through the existing transaction/reparse/independent-oracle path; this feature does not weaken or duplicate it.

## Verification

- One focused X-02 suite exercises the full matrix and serializer.
- Existing chained, Swift, ObjC, Mach-O, and Phase 12 Mach-O rebuild tests remain green.
- Syntax/import checks cover every changed module.
- The actual changed-file inventory is compared with the X-02 allowlist and forbidden lanes.
