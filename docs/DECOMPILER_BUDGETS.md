# Decompiler transform budgets

The `fast` profile uses deterministic work limits during normal decompilation.
The PassManager keeps its 12,000 node and 16 iteration defaults, the rewrite
engine keeps its 4,096 node, 12 iteration, and 2,048 application limits, and
Phase 8 keeps the profile's 10,000 work item limit. The stack recovery rewrite
engines keep their 2,048 node, 10 iteration, and 512 application limits.
Identical input therefore reaches the same work boundary on hosts with
different speeds.

Fast mode has one monotonic 2,000 ms transform safety ceiling. It is carried as
an absolute deadline through Phase 8, PassManager, the rewrite engine, and stack
recovery. It is a last-resort bound; deterministic work limits are the normal
stop condition. If the ceiling is reached, the result is degraded, warnings
retain the existing budget message, PassManager metrics carry
`degradationReason: "transform-safety-ceiling"`, and a withheld Phase 8 ledger
uses `stopReason: "transform-safety-ceiling"`.

Work limit exhaustion is reported as `transform-work-budget` in the relevant
PassManager metric or Phase 8 ledger. A result remains structurally valid after
either kind of truncation. An explicit `decompilerTimeBudgetMs` replaces the
profile ceiling and is reported as `transform-time-budget`. Explicit
`deterministicTransforms: true` disables transform wall-clock deadlines while
keeping deterministic work limits. The `deep` profile retains its existing
250 ms PassManager deadline and no profile Phase 8 deadline.

Frozen Phase 8 corpus measurements run with deterministic transforms. In
`decompileEntry`, an explicit `decompilerTimeBudgetMs` also caps the existing
PassManager node-work allowance at `min(12,000, floor(milliseconds))`. This
keeps deliberately tight and generous measurement allowances distinct without
using host elapsed time; the default 20,000 ms measurement allowance retains
the normal 12,000-node cap.

These are in-process transform limits. The outer process or worker watchdog,
including `--function-timeout-ms`, remains the hard stop and is unchanged.
