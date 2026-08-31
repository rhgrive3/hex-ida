# Contract: Language Metadata Provider

1. **Identity Precedence**: No metadata record may create hard constraints unless `isAuthoritative(identity)` is true and (if partial) the record matches the explicit identity coverage filter.
2. **Fail-Closed on Unknown Version**: When header magic, format version, or compiler version is unrecognized, the provider MUST return `verdict: 'unsupported'` or `'matched-partial'` with explicit reasons and MUST NOT decode assuming current-version offsets.
3. **Bounded Processing**: All record and table readers must respect explicit budgets (`maxRecords`, `maxBytesScanned`, `maxDepth`) and must not allocate unbounded buffers.
4. **Stripped Binary Integrity**: In the absence of metadata sections, providers must return clean empty results without fabricating type structures or synthetic names.
5. **Preserve Ambiguity**: When candidate records conflict or multiple implementations share an address, providers must retain all candidates and preserve ambiguity rather than selecting an arbitrary single candidate.
