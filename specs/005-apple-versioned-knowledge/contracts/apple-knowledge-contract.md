# Apple Knowledge Contract v1

1. The matrix is a projection of canonical parser/provider facts, never a second address, symbol, type, or signing authority.
2. `binaryIdentity` and `sliceIdentity` are explicit. Their absence makes the matrix non-authoritative.
3. Unknown version/format values are preserved numerically and reported unsupported.
4. PAC/authentication bits are never folded into canonical target identity. Authentication metadata is descriptive and never proof that authentication succeeds.
5. Bind ordinals and rebase targets are mutually exclusive. Addends remain signed exact integers.
6. Every decoded site carries raw word, virtual address, container- and slice-relative file offsets, pointer format, storage width, stride, and chain-next identity. Duplicate/conflicting sites remain candidates and make resolution ambiguous.
7. Shared-cache mapping overlap yields an ambiguity set; no winner is selected.
8. Code-signature parsing reports structure and mutation consequences only. `validity` is always unknown in this contract.
9. Malformed structured input cannot produce a complete/supported cell.
10. Serialization/reparse is deterministic, schema-checked, and BigInt-safe. It is lossless for evidence but intentionally not for authority: all cells become `unknown`/incomplete and caller-authored complete cells are rejected.
11. Missing/truncated chained starts and early budget termination reserve every possibly loader-owned segment before ordinary pointer fallback is considered.
12. `DYLD_CHAINED_PTR_32_CACHE` is shared-cache-base-relative and has no resolved target without an authoritative cache base.
