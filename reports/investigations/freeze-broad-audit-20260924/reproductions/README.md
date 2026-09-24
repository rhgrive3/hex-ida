# Reproductions

No reproduction artifacts are included because this audit confirmed **zero**
Critical or Major findings. Per the audit methodology, reproductions are only
produced for confirmed findings; manufacturing a reproduction for an
unconfirmed candidate would be a false positive.

All candidates that were investigated were either (a) deliberate fail-closed
behavior, (b) already covered by an open issue / open PR / HANDOFF known-issue,
or (c) not demonstrable with a concrete execution path, and are therefore
recorded as rejected in `../checked-areas.md` rather than here.

If a future pass confirms a finding, add a self-contained script here that a
reviewer can run unchanged (no network, no `/tmp` reliance beyond the repo
scratch convention) to observe the defect.
