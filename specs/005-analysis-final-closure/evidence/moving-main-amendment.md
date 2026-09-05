# T060 — verified moving-main successor

User authorization: 2026-09-05, explicit approval to amend the rules.
Code and product checks below passed. This is not Stage A completion, a main
merge receipt, Stage B activation, or physical-device proof. The publication
and activation successors still require exact-head operational/runtime/hosted
verification before further component acceptance.

## Immutable identities

| Boundary | Commit | Tree |
| --- | --- | --- |
| Previous accepted E | `2526882602a40e934499e6a1a5270c86fcbe3bb5` | `22d7441c83c60de9711d7916603c4eac6475ca2b` |
| Reviewed main merge R | `398fbf05de14b783188f449876756158bbc54f23` | `ed9c41802d7052ae52cc9323adf1f02bae24c001` |
| Code A | `0d4ae3b2dce13f4d8d2606623e4c9c115124dd26` | `f8594f37df5826f88c54be9a384a134fcc666fd5` |
| Canonical product G | `e6cd26d3e2f4e7b7f4afc534e91b2cb4d3a18e8d` | `e3e5cc50b4c1cce2a55abc187d260b007e25596c` |

R's ordered parents are E and main `eef6223fc08d90ef3e86b5eb8e4a56c06f04af84`.
Git's conflicted automatic tree is `a2b1f8f511d61832e045edffefdda77846287d0c`.
All seven conflict resolutions select the exact integration-parent blob:

- T051 `js/ai/control/snapshot.js`: retain the stronger slice/binary binding.
- T051 `js/ai/dev/ui/controls.js` and `tests/ai-ui-dev-profile.mjs`: main PR
  #6451's fix already exists here; retain explicit late-repaint and cleanup
  regression coverage rather than replacing it with a fixed-delay assertion.
- T059 `js/core/scheduler/analysis-scheduler.js`: retain strict canonical
  ArtifactId handling; the competing change is formatting.
- T058 `tests/phase4/ownership/integration-contract-repair.test.mjs`: retain
  stronger executable workflow/denominator checks, tested on the new product.
- T049 `userscript/hex.user.template.js` and `userscript/release-version.json`:
  provisional parent selection only; canonical G regeneration replaces it.

All clean main changes are retained. The canonical verifier independently
checks ordered parents, actual conflict paths, exact parent blobs and the
automatic tree. An earlier unpublished candidate `4c28992d32887d89caf3887e0c6a71b23a175759`
is preserved locally; its old-main evidence does not certify this candidate.

## Implemented boundary

T060 adds `E → R → A → G → E2 → P → D` without changing historical T046/T058
anchors, accepted checkpoint rows, frozen gate commands, oracle contracts,
thresholds, or existing owners. P matches its actual main-to-P Git inventory.
D changes only T060's status/handoff. Subsequent main refreshes use ordered
two-parent R2 commits without rewriting P, D, or historical component receipts.
Both current tails and later historical checkpoint rows use the same exact
merge verifier and inventory-refresh validator. Retained owners, handoffs,
revalidations, checkpoint metadata and amendment receipts remain immutable.
The amendment's accepted tasks are a prefix of future checkpoints, not a
mutable replacement task set. Static compatibility never substitutes for Git
lineage, actual path sets, or exact generated-product verification.

## Executed evidence

- Exact clean A: `node tests/final-closure/preflight.test.mjs` PASS, 422.3 s,
  in `ida-245-t060-product`. A's head/tree and tracked worktree stayed unchanged.
- Focused post-D refresh positive, negatives and historical R2 replay PASS,
  56.0 s. Permanent cases reject arbitrary resolution blobs, retained-owner
  reassignment, stale base, false accepted task sets, and mutation of receipt,
  checkpoint, handoff and revalidation metadata. Existing coordinated path
  omission, activation, stale-fork and Stage B cases remain in the full suite.
- Independent Luna Max source review, focused refresh and Stage B checks PASS;
  root inspected the actual source/test diff and all seven parent selections.
- Exact G: real-Git `moving-main-amendment.test.mjs` PASS, 1.1 s; Phase 4
  `ownership/integration-contract-repair.test.mjs` PASS, 4.3 s.
- Exact G: `CI=1 node tests/ai-ui-dev-profile.mjs` PASS in real Chromium,
  3.8 s, including late asynchronous repaint and observer cleanup.
- Exact G: canonical `node scripts/build-userscript.mjs` ran twice with zero
  tracked diff after each run. Loader changes are exactly the generated
  serial/build substitution; no generated hash was manually manufactured.
- Exact G: all three registered cumulative rolling gates for T051/T059 PASS;
  both pinned independent shadow reports PASS. These certify two accepted
  components, not the thirteen remaining components or final corpus.

Release serial: `2322242133`; build ID: `c66c0b76c27366ce34c113f9`.
Release identity: `041b7008efd4ef074f868c87f448aff1894d4f5a4db7394aaa46752d4124737a`.
Initial candidate gate digest: `63fb512b688c281f862740411f20df72` (unchanged).
P publishes machine-derived generation, rolling and shadow receipts in
`contracts/integration-inventory.json`; prose is not their authority.

Physical device: `SKIPPED_USER_WAIVER`, never PASS. Browser/runtime and exact-head
CI remain required. CodeRabbit on an old PR head does not certify A/G/D.
Answer 002 remains on hold; its contents were not read or adopted.

## Post-activation revalidation — 2026-09-05

Hosted run `33959764659` on published D
`27e2429f87be465f479ca4172846c83d5e041739` failed a historical fixture:
the fixture copied live T060 DONE into an intentionally PENDING task graph.
The original activation, amendment, accepted checkpoints and handoffs remain
unchanged. This append-only correction is D → A2 → G2 → E3 → P2; it is not
a new component acceptance or a replacement for the failed run.

- Final A2: `159f3064695e982db7c536334fba2620facd9e86`;
  tree `9f9809b95e0db9d48e66fe9e179e1e9ed0b7b0de`.
- Final G2: `672c29f180271ead32f33968c764625e7f0971bc`;
  tree `9f9809b95e0db9d48e66fe9e179e1e9ed0b7b0de`.
- A2 changes only the existing preflight verifier/test and append-only plan.
  The historical fixture normalizes its T060 state. The separate immutable
  revalidation receipt authenticates the code, generated product, evidence,
  inventory-only publication and continuation without rewriting original D.
- `node tests/final-closure/run.mjs` passed in 419.7 s on clean A2 predecessor
  `b45abb68f810b0d8dc9ebd5a9c624208de6d4402`, already in T060 DONE state.
  The final A2 delta adds an explicit publication-stage/prefix-length guard
  and two negative assertions; its focused revalidation suite passed in
  19.0 s. The predecessor full-run result is not exact-final-head CI proof.
- Permanent real-Git cases cover receipt removal/rewrite, historical Stage B
  verification, original D identity, verified A2/E3 path seals, G2 selection,
  wrong parents, arbitrary source edits, invalid generation proof, publication
  state and P2 → next-component continuation. Source/test syntax and diff
  whitespace checks passed. Independent Luna Max review and root diff review
  completed; T060 retains its original accepted-prefix length, not T058's zero.
- Canonical generation on A2 produced no changes. Both canonical rebuilds on
  exact G2 produced zero diff. All three registered T051/T059 cumulative
  rolling gates and both pinned independent shadow reports passed on G2.
  Release serial/build/release identities remain exactly those above.

P2 publishes the machine-derived G2 receipt as
`movingMainAmendmentRevalidation`. Exact P2 canonical full regression,
operational verification and runtime reproduction remain mandatory in hosted
CI before another component is accepted. At E3 publication these are pending,
not PASS. Physical device remains `SKIPPED_USER_WAIVER`; Answer 002 is unread.
