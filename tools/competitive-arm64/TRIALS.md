# Bounded T0–T3 trial execution (experimental, opt-in)

This runner is executable source, not a published benchmark result. It does not
load providers, call a model or enable a default rollout merely by importing it.
The supplied synthetic fixtures are not real competitor measurements. All
release/default-rollout/victory flags remain false.

## Plan file and explicit execution

The JSON input has exactly `protocols` and `config`. `protocols` contains T0, T1,
T2 and T3 **raw** competitive-protocol inputs; each is validated and reconstituted
by `createCompetitiveProtocol`. T0 uses `scripted-substrate`, T1/T3 `native-best`,
and T2 `knowledge-equalized`. The existing protocol schema, case/binary/metric
inventory and pinned model configuration are reused, not a parallel benchmark
format. See `tests/scpa/benchmark-fixture.mjs` for a **synthetic** input example
and `tests/scpa/trial-cli.test.mjs` for the full plan-file contract.

`config` contains `seed`, `cacheStates`, one `tasks` entry for every case, and
`resources` (`deadlineMs` and `cleanupMs`). Tasks carry the existing native
adapter request. No tasks are inferred from an incomplete file. The full plan
is limited to 4,096 cells; source files to 1 MiB; result output to 8 MiB.

```sh
node tools/competitive-arm64/trials.mjs --plan input.json --out plan.json
node tools/competitive-arm64/trials.mjs --run input.json --host ./host.mjs \
  --timeout-ms 30000 --maximum-trials 64 --out result.json
```

Output files are created exclusively with mode 0600; existing output, input and
host files are not overwritten. The CLI accepts a finite 100–120,000 ms worker
lifetime and at most 256 executed cells per invocation. **A persisted resume API is available through `--resume`**. Cells beyond the
invocation cap remain UNMEASURED, not omitted. See the session12 continuation
contract below. A successful synthetic scale test is not a completed real pilot.

A host module must explicitly export `createTrialHost({plan, protocols, signal})`
and return `{getAdapter, adjudicate?}`. `getAdapter(binding, context)` returns the
existing native-adapter wrapper plus its preparation, currentness and cleanup
callbacks. The source contract is in `scoped-trials.js`; `trials.test.mjs` shows
receipt doubles and an actual native-service fixture. Adapters are not discovered
or downloaded. Any external model or competitor use requires separately supplied,
authorized local host integration and its own account/resource limits.

Host JavaScript runs in a terminateable worker (256 MiB old generation, 32 MiB
young generation, 4 MiB stack). The parent imposes a wall deadline and a 32 KiB
host-log cap; raw logs are discarded rather than copied into reports. This is
**not a security sandbox**, OS process-tree killer or remote-job cancellation
guarantee. Host modules execute local code with the user's permissions. External
processes, network operations, costs and remote jobs must be bounded and cleaned
up by that host. The entry-module SHA-256 records only the read entry file, not
a dependency attestation or proof of the executed environment.

Preparation must bind tool/binary/model/cache scope, fresh namespace, resource
limits, cancellation, knowledge availability/license and T0 model exclusion.
Missing adapters stay UNAVAILABLE. Completed raw answers stay UNMEASURED until
independently adjudicated. A host adjudicator can only produce measurement
**candidates**, not admit a protocol, correctness result, release or victory.
T2 knowledge-policy mismatches invalidate the paired group. Failed cleanup
invalidates that cell and removes its candidates. Parent cancellation and stale
owners reject late publication. Transported host reports are not independently
admitted evidence.

`reviewAstraTrialReadiness` evaluates only branded in-process plans/results. It
retains missing/unavailable/failed cells, cache modes, repetitions, and independent
oracle/device/statistical/human-adjudication vetoes. Those external admission
gates are intentionally not satisfied by a successful synthetic run.

## Related session9 interfaces

* Knowledge: `recognizeScoped` now has single-use scope/revision-bound page
  continuation and opt-in `retrieval: 'indexed'`. The indexed path streams a
  bounded reference prefix through the **existing** matcher, rereads selected
  primary records and invalidates on database revision. Approximate candidate
  cuts never establish an exhaustive reference universe or exact identity.
  SDK version-family membership is a set of observed annotations, not a version
  order, release range, identity proof or automatic type/name transfer.
* Investigation: a host-bound fixed success contract and budget/cost samples
  qualify only the read-only frontier. A language goal alone does not prove
  task completion; missing/new obligations and cycles keep it unresolved.
* Certificates: `encoding: 'shared-dag-v1'` is optional for certificate exports;
  raw canonical encoding remains the default. `replayProof` accepts the bounded
  envelope, restores the full certificate and invokes existing replay checks.
  Hash/transport integrity is not semantic proof. Packing cannot discard
  contradictions, premises, unknowns or explanation paths.
* Swift: generic declarations come only from the private current metadata-owner
  hook, never arbitrary AI query fields. Alias/same-type/conformance obligations
  join the same witness/vtable candidate schema. Cycles, ambiguities, resilient
  or conditional conformance and unsupported dependent members remain UNKNOWN.
  Automatic ABI extraction and two-toolchain/device acceptance remain open.

Run `node tests/scpa/run.mjs` for source-contract regression tests. IndexedDB
fixtures model transaction events; they are not iPad/Safari runtime admission.


## Session12: saved continuation


The default is plan-only. Supply a trusted **local** host module explicitly to run any adapter. This tool does not provide competitor access, model accounts, API keys, measurement admission, or an external process sandbox.

```sh
node tools/competitive-arm64/trials.mjs --plan input.json
node tools/competitive-arm64/trials.mjs --run input.json --host host.mjs \
  --maximum-trials 256 --timeout-ms 30000 --out batch-01.json
node tools/competitive-arm64/trials.mjs --run input.json --host host.mjs \
  --resume batch-01.json --maximum-trials 256 --timeout-ms 30000 --out batch-02.json
```

Use the unchanged input and host module, and a **new output path** for each batch. Output files are created with mode0600 and never overwrite an existing file. An output-path failure is detected before executing a host. Inputs, host modules and checkpoints must be bounded regular files; FIFOs are rejected without waiting for a writer.

## Contract

`input.json` keeps the existing `{protocols, config}` contract. Protocol keys are `T0`, `T1`, `T2`, `T3`; all modes retain the fixed cases, participants, repetitions and cache strata. No CLI resume flag changes a plan. `host.mjs` exports the existing `createTrialHost({plan, protocols, signal, ...})` factory and returns the adapters required by `runAstraTrials`. Host code is explicitly trusted code, not an untrusted capsule. Hosts MUST bound and cancel their own processes, network requests, model spending, and external resources.

The plan cap remains4096 cells, the invocation cap1–256, the worker wall bound100–120000ms, and saved report/worker message bound8 MiB. Trial limits are forwarded unchanged. Each consumed cell, including a failed or unavailable cell, stays consumed. An interrupted process without a valid returned checkpoint cannot be assumed not to have caused external effects; automatic retry is intentionally absent.

A successful CLI invocation returns `status: "executed-not-admitted"`, not an experiment or product acceptance. Inspect `result.progress.nextOrdinal` against `result.denominator`. A complete execution still has correctness/independent measurements unadmitted. `review.verdict` stays `NOT-YET`; release, default-rollout and victory flags stay false.

## Wire and JavaScript interfaces

The CLI emits compact JSON with result schema `same-astra-trial-results-compact/v1`. It removes only information already bound by the exact plan; statuses, observations, cleanup failures and measurement references remain. The reader rejects duplicated plan context, altered order/bindings, missing cells, malformed observations, forged admission flags and inconsistent progress. Expansion has its own8 MiB bound; arbitrarily large per-cell evidence is not guaranteed to fit.

The existing `executeAstraTrialFile` JavaScript API returns an expanded `same-astra-trial-results/v1` by default; `compactResult: true` requests the wire representation. Both forms may be resumed. Core callers can use:

```js
const first = await runAstraTrials(plan, protocols, {
  work, getAdapter, maximumTrials: 256,
});
const serialized = JSON.stringify(packAstraTrialContinuation(plan, first));
// After persistence: create a fresh bounded work context and the same plan.
const second = await runAstraTrials(plan, protocols, {
  work: nextWork, getAdapter, maximumTrials: 256,
  resumeFrom: JSON.parse(serialized),
});
```

The core validator is `validateAstraTrialContinuation(plan, protocols, raw)`. Plan objects must come from the existing `createAstraTrialPlan`. Validation and restoration do not create a receipt-verification authority.

## Boundaries that must not be inferred

Progress digests detect accidental transport changes; they are not signatures. The CLI binds the input bytes and root host-module SHA-256, not transitive imports, remote services, machine state or a whole reproducible environment. Imported observations remain `imported-unadmitted`. Cache namespaces and T2 knowledge conditions are checked across batches; a later T2 mismatch retracts earlier affected candidate measurements. Independently admitted measurements still require the existing competitive matrix and its verifiers.

The continuation tests include a2304-cell **synthetic** scale plan and separate-process save/resume. These are execution-control tests, not the Post-B competitor experiment, real model calls, physical-device observations or a human study.
