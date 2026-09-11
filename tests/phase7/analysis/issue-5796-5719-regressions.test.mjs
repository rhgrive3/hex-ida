// The issue-specific files keep their direct standalone entry points, while
// this discovered aggregate makes the canonical Phase 7 runner execute both
// regressions as part of the owned analysis lane.
import '../issue-5796-auto-report-source-identity-authority.mjs';
import '../issue-5719-schema-recovery-strings-progress.mjs';
