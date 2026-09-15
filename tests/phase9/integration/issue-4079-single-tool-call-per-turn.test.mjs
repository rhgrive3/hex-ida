// Keep the #4079 single-tool-call regression in an auto-discovered required
// denominator after reconciling this PR with current main, whose package.json
// has newer unrelated script inventory that must not be replaced by the stale
// branch copy.
await import('../../issue-4079-single-tool-call-per-turn.mjs');
