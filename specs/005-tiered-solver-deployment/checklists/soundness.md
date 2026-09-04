# Soundness Checklist: HEX-SYM-01

- [x] No heuristic backend can mint SAT/UNSAT proof authority.
- [x] Tseitin gates encode equivalence, not one-way implications.
- [x] Fixed-width arithmetic discards only out-of-width carry and uses little-endian bit vectors consistently.
- [x] Signed/unsigned comparisons, saturated shifts, zero divisors, and `MIN / -1` are specified and tested at 32/64 bits.
- [x] UNSAT requires completed DPLL search; every interrupted search returns a non-proof status.
- [x] SAT models bind canonical symbol IDs and are independently evaluated against the original query.
- [x] Malformed model/result/request-token/query/backend identity fails closed.
- [x] Cancellation, timeout, stale result, disposal, and deterministic budget exhaustion cannot publish proof.
- [x] Exhaustive complete-domain differential is independent of the bit-blast implementation.
- [x] Structured-clone-safe canonical recomputation rejects constraint, assertion, symbol, and query-identity mutations under a reused hash.
- [x] Hostile deep, wide, and cyclic graphs are bounded iteratively before recursive solver work.
- [x] NaN, coercible strings, infinities, fractions, zero, and negative budget authorities fail closed.
- [x] Capability fingerprint binds route policy and both exact engines.
- [x] Runtime is local, browser-safe, and dependency-free.
- [ ] Physical iPad Safari execution and memory-pressure behavior have been observed on the exact deployable identity.
