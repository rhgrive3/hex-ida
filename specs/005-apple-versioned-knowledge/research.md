# Research and Existing-Evidence Audit (HEX-X-02)

## Current Main

| Surface | Existing strength | Missing X-02 fact |
|---|---|---|
| Chained imports/bind sites | Bounded payload/import/page/chain parsing; formats 1,2,3,6,7,9,10,12 partially decoded | Formats 4/5 have width but no decoder; authenticated fields and all site provenance are not published |
| Classic dyld | Bounded classic and threaded bind streams; export trie cycle/budget handling | No shared-cache identity/mapping result |
| Swift/ObjC | Versioned C3-03 provider results and ambiguity-aware runtime resolution | No Apple matrix binding the provider verdicts to dyld/PAC/signing cells |
| Mach-O signing | Rebuild adapter rejects any `LC_CODE_SIGNATURE` presence | No bounded SuperBlob/CodeDirectory structure or explicit non-validity/signing consequence |
| Rebuild | Fresh parser plus registered independent `llvm-readobj` oracle for supported cells | X-02 must reuse this proof; signing validity is not provided by it |

## Stale Branch 407c2411

The stale branch introduced a worker-layer chained-import recovery path and real-binary CI wiring. Main supersedes the parser with `js/binary/macho-dyld.js`, including stronger shared budgets, page ownership, segment/file bounds, unsupported-format tracking, signed ordinals/addends, and direct canonical-loader integration. The stale worker/backend/harness/CI files are outside this lane and are not reused. Its sound unique intent—recover import names from `LC_DYLD_CHAINED_FIXUPS` when classic symbols are insufficient—is already present on main and retained as regression context.

## Format Posture

- Chained-fixups header version 0 is supported; future versions stay unsupported.
- Uncompressed symbol pools are supported; compressed/unknown pools stay explicit partial/unsupported until a bounded browser-safe decoder is an owned requirement.
- Pointer format numbers are identities, not interchangeable layouts. Authenticated, unauthenticated, bind, and rebase records remain disjoint.
- Format 4 is cache-base-relative, not image-base-relative. Without a trusted shared-cache base its offset is retained and its target remains unresolved.
- dyld shared-cache parsing is deliberately bounded to the stable v1 prefix and mapping table. Slide-info and complete image extraction are non-goals.
- Code-signing parsing recognizes bounded embedded-signature container and CodeDirectory structures, including nonzero v2.3 `codeLimit64`. Source-backed Mach-O requests exactly the declared signature range. It does not perform CMS, certificate, requirement, hash-slot, platform, entitlement, or OS trust validation.

## Independent Review Hardening

The follow-up reviews found that short/incomplete load-command tables could imply signature absence, shortened chained page tables could omit owned pages, format 4 accepted a caller-authored cache base, public provider/cache/image shapes could mint completeness, and CodeDirectory reserved/hash/page/version fields were under-validated. The hardening regressions now require byte-derived private issuance and exact artifact binding, malformed/partial load-command state, full-segment chained ownership and exact page coverage, explicit storage width and fat-container offsets, duplicate-site ambiguity, source-backed signature reads, effective `codeLimit64`, infinite-page/hash/version bounds, module-issued cache-base format 4 resolution, and evidence-only serialized matrices. The external Phase 12 `llvm-readobj` fixture remains required and unavailable locally.

The final provider-binding review reproduced false Swift absence by pairing an issued image identity with caller-selected sections and no byte reader. Swift/Objective-C matrix probes are therefore now constructed only inside the Apple module from the Mach-O authority snapshot, use a private revalidated resident-byte snapshot, and require complete load-command/metadata coverage before absence can be complete. Copied or mutated section arrays, missing/custom readers, caller providers, and post-issuance byte mutation remain partial or unissued.

The next adversarial review replaced the exported Swift provider prototype with a forged matching-shape result. Canonical probes now invoke lexical implementations captured inside their provider modules during module evaluation; they never dispatch through mutable exported prototypes or caller instances, so prototype/own-method/subclass/callback/proxy-result replacement cannot enter the private issuance set.
