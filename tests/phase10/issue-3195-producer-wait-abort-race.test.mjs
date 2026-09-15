// Canonical Phase 10 discovery bridge for the dedicated #3195 regression.
// Keep the root test as the single behavioral oracle; this file only makes it
// reachable from the required `npm run phase10:test` discovery path.
import "../issue-3195-producer-wait-abort-race.mjs";
