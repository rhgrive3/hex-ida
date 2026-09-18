import assert from 'node:assert/strict';
import test from 'node:test';

import { EmulatorProvider } from '../../../js/runtime/emulator-provider.js';

const binaryId = 'bin_sha256_' + '88'.repeat(32);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

// #8859 acceptance 1/2/3/4/5: a signal-ignoring launch that loses the abort
// race must never fall through into the resume stage, must stay quarantined
// while unresolved, must block a second run, and its late completion must not
// make the mutated target authoritative for normal work again.
test('#8859 timed-out signal-ignoring launch never resumes, stays tracked, and its late completion quarantines', async () => {
  const launch1 = deferred();
  const machine = { phase: 'initial', pc: 0x1000 };
  let launchCalls = 0;
  let resumeCalls = 0;
  const engine = {
    launch() {
      launchCalls += 1;
      if (launchCalls === 1) return launch1.promise;
      return undefined;
    },
    resume() {
      resumeCalls += 1;
      machine.phase = launchCalls === 1 ? 'second-run' : 'resume';
      machine.pc = 0x1000;
      return { termination: 'return' };
    },
  };
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId, sessionNonce: 'issue-8859-launch' }, { connect: false });
  const result = await session.facets.emulator.run({}, { timeoutMs: 10 });

  // 1: bounded return within the timeout budget.
  assert.equal(result.termination, 'timeout');
  assert.equal(result.completeness, 'truncated');
  // 2: the cancelled launch never became a success stage into resume().
  assert.equal(resumeCalls, 0, 'a timed-out launch must never invoke resume()');
  // 3: the unresolved launch is still tracked; the session is not ready.
  assert.equal(provider.pendingEngineOperations.size, 1, 'the signal-ignoring launch stays tracked until it settles');
  assert.equal(session.state, 'running');
  // 4: reuse is rejected while the stale launch can still mutate the target.
  await assert.rejects(
    session.facets.emulator.run({}, { timeoutMs: 10 }),
    /emulator engine still has an unsettled operation/,
  );
  assert.equal(launchCalls, 1);

  // 5: the stale launch settles late by mutating the target; that must not
  // silently re-enable normal work over an unrepresented state change.
  machine.phase = 'late-first-launch';
  machine.pc = 0x5000;
  launch1.resolve();
  await nextTurn();
  assert.equal(session.state, 'degraded', 'late mutable completion quarantines instead of restoring ready');
  await assert.rejects(
    session.facets.emulator.run({}, { timeoutMs: 10 }),
    /quarantin/,
  );
  assert.equal(resumeCalls, 0);
  // 6 (recovery): an authoritative reset re-admits work on the same engine.
  await provider.resetEngineAuthority();
  assert.equal(session.state, 'ready');
  const recovered = await session.facets.emulator.run({}, { timeoutMs: 100 });
  assert.equal(recovered.termination, 'return');
  assert.equal(launchCalls, 2);
  assert.equal(resumeCalls, 1);
  await session.close();
});

// #8859 acceptance 6/8/9: timed-out execute that later completes must not have
// its mutated target trusted by subsequent runs; the recovery boundary owns it.
test('#8859 signal-ignoring execute timeout taints the target until authoritative recovery', async () => {
  const execute1 = deferred();
  let calls = 0;
  const machine = { pc: 0x1000 };
  const engine = {
    execute() {
      calls += 1;
      if (calls === 1) return execute1.promise;
      return { termination: 'return', pc: machine.pc };
    },
  };
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId, sessionNonce: 'issue-8859-execute' }, { connect: false });
  const result = await session.facets.emulator.run({}, { timeoutMs: 10 });
  assert.equal(result.termination, 'timeout');
  assert.equal(session.state, 'running');
  await assert.rejects(session.facets.emulator.run({}, { timeoutMs: 10 }), /unsettled operation/);

  machine.pc = 0x2000;
  execute1.resolve({ termination: 'return', pc: 0x2000 });
  await nextTurn();
  assert.equal(session.state, 'degraded');
  // 8/9: the late completion carries no successful provenance, so no later run
  // may report the late-mutated target as current runtime state.
  await assert.rejects(session.facets.emulator.run({}, { timeoutMs: 10 }), /quarantin/);
  await provider.resetEngineAuthority();
  const after = await session.facets.emulator.run({}, { timeoutMs: 100 });
  assert.equal(after.termination, 'return');
  assert.equal(calls, 2);
  await session.close();
});

// #8859 acceptance 7: external cancellation has the same fail-closed semantics.
test('#8859 external cancellation of a signal-ignoring execute quarantines late mutations', async () => {
  const external = new AbortController();
  const execute1 = deferred();
  const started = deferred();
  let calls = 0;
  const engine = {
    execute() {
      calls += 1;
      if (calls === 1) {
        started.resolve();
        return execute1.promise;
      }
      return { termination: 'return' };
    },
  };
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId, sessionNonce: 'issue-8859-external' }, { connect: false });
  const run = session.facets.emulator.run({}, { timeoutMs: 1000, signal: external.signal });
  await started.promise;
  external.abort('caller-cancelled');
  const result = await run;
  assert.equal(result.termination, 'cancelled');
  assert.equal(session.state, 'running');
  execute1.resolve({ termination: 'return' });
  await nextTurn();
  assert.equal(session.state, 'degraded');
  await assert.rejects(session.facets.emulator.run({}, { timeoutMs: 100 }), /quarantin/);
  await provider.resetEngineAuthority();
  assert.equal(session.state, 'ready');
  const reused = await session.facets.emulator.run({}, { timeoutMs: 100 });
  assert.equal(reused.termination, 'return');
  assert.equal(calls, 2);
  await session.close();
});

// #8859 acceptance 10: cooperative cancellation still recovers without
// poisoning — a late settlement that only observed the abort (rejected or
// aborted) is not an unrepresented target mutation.
test('#8859 cooperative cancellation recovers without permanent taint', async () => {
  let calls = 0;
  const engine = {
    execute(_input, { signal }) {
      calls += 1;
      if (calls > 1) return { termination: 'return' };
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cooperative abort')), { once: true });
      });
    },
  };
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId, sessionNonce: 'issue-8859-cooperative' }, { connect: false });
  const timedOut = await session.facets.emulator.run({}, { timeoutMs: 10 });
  assert.equal(timedOut.termination, 'timeout');
  await nextTurn();
  assert.equal(session.state, 'ready', 'a cooperative late rejection must not taint the target');
  const reused = await session.facets.emulator.run({}, { timeoutMs: 100 });
  assert.equal(reused.termination, 'return');
  assert.equal(calls, 2);
  await session.close();
});

// #8859 acceptance 11/12: normal successful paths are unchanged.
test('#8859 normal execute and launch/resume success paths are unchanged', async () => {
  const executeEngine = { async execute() { return { termination: 'return', value: 7 }; } };
  const executeProvider = new EmulatorProvider(executeEngine);
  const executeSession = await executeProvider.openSession({ binaryId, sessionNonce: 'issue-8859-normal-execute' }, { connect: false });
  const executed = await executeSession.facets.emulator.run({}, { timeoutMs: 100 });
  assert.equal(executed.termination, 'return');
  assert.equal(executeSession.state, 'ready');
  await executeSession.close();

  const stagedEngine = {
    calls: { launch: 0, resume: 0 },
    async launch() { this.calls.launch += 1; },
    resume() { this.calls.resume += 1; return { termination: 'return', value: 'staged' }; },
  };
  const stagedProvider = new EmulatorProvider(stagedEngine);
  const stagedSession = await stagedProvider.openSession({ binaryId, sessionNonce: 'issue-8859-normal-staged' }, { connect: false });
  const staged = await stagedSession.facets.emulator.run({}, { timeoutMs: 100 });
  assert.equal(staged.termination, 'return');
  assert.deepEqual([stagedEngine.calls.launch, stagedEngine.calls.resume], [1, 1]);
  assert.equal(stagedSession.state, 'ready');
  await stagedSession.close();
});

// The bounded outcome shape itself: a raw abort sentinel must never reach run()
// for the execute stage either, and a failed bounded launch still throws.
test('#8859 failed launch throws instead of falling through, aborted launch never resumes', async () => {
  const failEngine = {
    resume() { throw new Error('resume must not run after a failed launch'); },
    async launch() { throw new Error('launch boom'); },
  };
  const failProvider = new EmulatorProvider(failEngine);
  const failSession = await failProvider.openSession({ binaryId, sessionNonce: 'issue-8859-failed-launch' }, { connect: false });
  const failed = await failSession.facets.emulator.run({}, { timeoutMs: 100 });
  assert.equal(failed.termination, 'exception');
  await failSession.close();

  const abortEngine = {
    resume() { throw new Error('resume must not run after an aborted launch'); },
    launch(_input, { signal }) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('abort seen')), { once: true });
      });
    },
  };
  const abortSession = await new EmulatorProvider(abortEngine).openSession({ binaryId, sessionNonce: 'issue-8859-aborted-launch' }, { connect: false });
  const aborted = await abortSession.facets.emulator.run({}, { timeoutMs: 10 });
  assert.equal(aborted.termination, 'timeout');
  await nextTurn();
  assert.equal(abortSession.state, 'ready');
  await abortSession.close();
});

// Recovery boundary contract: reset requires all operations settled, and the
// engine-provided reset hook is the authoritative reconciliation point.
test('#8859 resetEngineAuthority refuses unsettled operations and delegates to engine.reset', async () => {
  const execute1 = deferred();
  let resetCalls = 0;
  const engine = {
    reset() { resetCalls += 1; },
    execute() { return execute1.promise; },
  };
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId, sessionNonce: 'issue-8859-reset-boundary' }, { connect: false });
  const timedOut = await session.facets.emulator.run({}, { timeoutMs: 10 });
  assert.equal(timedOut.termination, 'timeout');
  await assert.rejects(provider.resetEngineAuthority(), /unsettled operation/);
  assert.equal(resetCalls, 0);
  execute1.resolve({ termination: 'return' });
  await nextTurn();
  assert.equal(session.state, 'degraded');
  await provider.resetEngineAuthority();
  assert.equal(resetCalls, 1);
  assert.equal(session.state, 'ready');
  await session.close();
});
