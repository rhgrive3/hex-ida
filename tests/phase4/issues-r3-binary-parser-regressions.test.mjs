// Required Phase 4 denominator wiring for the binary parser R3 regressions.
// Keep the focused root regressions independently runnable while ensuring
// `npm run check` executes them through the recursive Phase 4 runner.
import '../issue-6097-pe-section-virtual-range.mjs';
import '../issue-6110-eh-frame-hdr-count-cap.mjs';
import '../issue-6115-pe-export-ordinal-range.mjs';
import '../issue-6118-pe-directory-count-validation.mjs';
import '../issue-6184-dwarf5-addrx-resolution.mjs';
