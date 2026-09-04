# Data Model: HEX-SYM-01

## Tier classification

`TierRoute = { supported, tier, reason, maxBvWidth, exhaustiveDomainSize }`

- `exhaustive-oracle`: maximum expression width <=8 and complete symbol domain <= assignment ceiling.
- `bitblast-qfbv`: supported Bool/BV formula through width 64 outside the exhaustive tier.
- unsupported: malformed DAG, unknown semantics, invalid query, non-Boolean predicate, or width >64.

## CNF model

- Literal: signed non-zero integer; sign denotes polarity.
- Clause: disjunction of literals.
- Formula: conjunction of clauses with one distinguished true literal.
- Symbol binding: canonical `symbolId` to one Bool literal or a little-endian vector of BV literals.
- Gate memo: deterministic mapping from gate kind/input literals to a Tseitin output literal.

## Search state

Watched clause positions, literal watch lists, tri-state variable assignment, trail, propagation head, decisions, and propagations. Only a complete `sat` or `unsat` search state may cross as proof. `timeout`, `cancelled`, decision/propagation exhaustion, or malformed state is non-publishable.

## Result evidence

Existing `SolverResult`, extended through its open `stats` object with `routingTier`, `routingReason`, `engineBackend`, `attempts`, `cnfVariables`, `cnfClauses`, `decisions`, `propagations`, and algorithm identity. Semantic identity remains query hash + backend ID/version + capability fingerprint.

`VerificationQuery` schema `1.2.0` binds canonical expression hashes and every query identity field without embedding the full expression objects in the digest payload. Exact boundaries recompute this digest with bounded, call-local traversal after structured cloning; the received `queryHash` is never authority by itself.
