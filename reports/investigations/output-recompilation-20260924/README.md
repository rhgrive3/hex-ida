# Output recompilation re-measure (WIP, 2026-09-24)

Measured on product base e54c993e2 (8 cases = one per group, gcc_O1_g; `--structure none`) with reports/investigations/current-main-weakness-20260923/harness. `before.json` = current state before any declaration fix. No production change yet.

Next: declare locals, fixed-width types, globals/prototypes in emitter + TU packager (prompt: /mnt/workspace/hex-handoff-20260924/prompts/decl.txt), then re-measure into after.json.
