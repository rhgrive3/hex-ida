import assert from 'node:assert/strict';
import { DevSupervisorEngineV0 } from '../../js/ai/dev/supervisor/dev-supervisor-engine-v0.js';
import { DevSupervisorV0 } from '../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DEV_RUN_STATUS } from '../../js/ai/dev/run/dev-run.js';
import {
  DEV_TOOL_ERROR_HISTORY_KIND,
  describeDevToolError,
  isDevToolAbort,
  isTerminalDevToolError,
  sanitizeDevToolArguments,
} from '../../js/ai/dev/supervisor/tool-error-recovery.js';

testClassification();
testArgumentSanitization();
await testRecoverableToolErrorKeepsRunAlive();
await testTerminalToolErrorStillFails();
await testAbortStillCancels();
await testRecoveryBudgetIsBounded();
await testWorkerClaimFailureKeepsCleanupObligation();
await testAbandonedAmbiguousClaimStillReleases();
await testReleaseFailureKeepsClaimOwnership();
await testErrorMessageSecretRedaction();
console.log('Dev Supervisor tool error recovery: ok');

function testClassification() {
  assert.equal(isTerminalDevToolError(withCode(new Error('boom'), 'script-not-loaded')), false);
  assert.equal(isTerminalDevToolError(new TypeError('bad arguments')), false, 'plain argument failures must stay recoverable');
  assert.equal(isTerminalDevToolError(withCode(new Error('x'), 'dev-extension-integrity-mismatch')), true);
  assert.equal(isTerminalDevToolError(withCode(new Error('x'), 'dev-security-boundary-escape')), true);
  assert.equal(isTerminalDevToolError(withCode(new Error('x'), 'dev-invariant-violation')), true);
  assert.equal(isTerminalDevToolError(withCode(new Error('x'), 'dev-runtime-corruption')), true);
  assert.equal(isTerminalDevToolError(Object.assign(new Error('x'), { fatal: true })), true);
  assert.equal(isTerminalDevToolError(abortError()), true);
  assert.equal(isDevToolAbort(abortError()), true);
  assert.equal(isDevToolAbort(withCode(new Error('x'), 'cancelled')), true);

  const described = describeDevToolError(withCode(new Error('m'.repeat(2000)), 'script-not-loaded'));
  assert.equal(described.code, 'script-not-loaded');
  assert.ok(described.message.length <= 512, 'tool error messages must be bounded');
  assert.equal(describeDevToolError(new Error('no code')).code, 'Error');
}

function testArgumentSanitization() {
  const sanitized = sanitizeDevToolArguments({
    index: 3,
    needle: 'createProject',
    sessionToken: 'must-not-leak',
    authorization: 'Bearer must-not-leak',
    nested: { apiKey: 'must-not-leak', ok: true },
    long: 'x'.repeat(400),
    list: Array.from({ length: 30 }, (_value, i) => i),
  });
  assert.equal(sanitized.index, 3);
  assert.equal(sanitized.needle, 'createProject');
  assert.equal(sanitized.sessionToken, '[redacted]');
  assert.equal(sanitized.authorization, '[redacted]');
  assert.equal(sanitized.nested.apiKey, '[redacted]');
  assert.equal(sanitized.nested.ok, true);
  assert.ok(sanitized.long.length < 200, 'long argument text must be truncated');
  assert.ok(sanitized.list.length <= 13, 'long argument arrays must be bounded');
  assert.doesNotMatch(JSON.stringify(sanitized), /must-not-leak/);
}

/* Required regression: a thrown Dev tool must not end the run. The same run and
   the same Supervisor session must continue into the next decision. */
async function testRecoverableToolErrorKeepsRunAlive() {
  let scriptSourceCalls = 0;
  const harness = createHarness({
    client: {
      enabled: true,
      pageScripts: async () => ({ scripts: [{ index: 0, external: false }] }),
      pageScriptSource: async () => {
        scriptSourceCalls += 1;
        if (scriptSourceCalls === 1) {
          const error = new Error('Requested script is not a currently loaded external page script.');
          error.code = 'script-not-loaded';
          throw error;
        }
        return { index: 0, excerpts: [{ text: 'function createProject(){}' }] };
      },
    },
    decisions: [
      { type: 'tool', tool: 'chatgpt.page.script_source', arguments: { index: 0, needle: 'createProject', sessionToken: 'must-not-leak' }, purpose: 'inspect inline source' },
      { type: 'tool', tool: 'chatgpt.page.script_source', arguments: { index: 0, needle: 'createProject' }, purpose: 'retry after the tool error' },
      { type: 'final', answer: 'recovered', completedTasks: ['inspect'], remaining: [] },
    ],
  });

  const result = await harness.engine.run({ goal: 'inspect ChatGPT page source', conversationId: 'conversation-recovery' });
  assert.equal(result.answer, 'recovered');
  assert.equal(scriptSourceCalls, 2, 'the Supervisor must be able to retry the failed tool inside the same run');
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.COMPLETED, 'a recoverable tool failure must not fail the run');

  assert.equal(harness.prompts.length, 3, 'the Supervisor must be asked for the next decision immediately after the tool error');
  assert.equal(new Set(harness.sessionKeys).size, 1, 'recovery must stay in the same Supervisor session');
  assert.equal(harness.sessionKeys[0], harness.settings.lastRun.supervisorSessionKey);

  const errorEntry = harness.historyAt(1).find((entry) => entry.kind === DEV_TOOL_ERROR_HISTORY_KIND);
  assert.ok(errorEntry, 'the failed tool must be returned to the Supervisor as tool-error history');
  assert.equal(errorEntry.tool, 'chatgpt.page.script_source');
  assert.equal(errorEntry.code, 'script-not-loaded');
  assert.ok(errorEntry.message.length <= 512, 'the provider-bound message stays bounded');
  assert.doesNotMatch(errorEntry.message, /not a currently loaded external page script/, 'raw free-form tool text stays out of provider-bound history');
  assert.equal(errorEntry.recoverable, true);
  assert.equal(errorEntry.arguments.index, 0);
  assert.equal(errorEntry.arguments.needle, 'createProject');
  assert.equal(errorEntry.arguments.sessionToken, '[redacted]');
  assert.equal(errorEntry.remainingRecoveries, 5);
  assert.doesNotMatch(JSON.stringify(harness.historyAt(1)), /must-not-leak/);
}

async function testTerminalToolErrorStillFails() {
  const harness = createHarness({
    client: {
      enabled: true,
      pageScripts: async () => { throw Object.assign(new Error('integrity'), { code: 'dev-extension-integrity-mismatch' }); },
    },
    decisions: [
      { type: 'tool', tool: 'chatgpt.page.scripts', arguments: {}, purpose: 'list scripts' },
      { type: 'final', answer: 'unreachable', completedTasks: [], remaining: [] },
    ],
  });
  await assert.rejects(
    () => harness.engine.run({ goal: 'terminal failure', conversationId: 'conversation-terminal' }),
    (error) => error.code === 'dev-extension-integrity-mismatch',
  );
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.FAILED, 'fatal integrity failures stay terminal');
}

async function testAbortStillCancels() {
  const harness = createHarness({
    client: {
      enabled: true,
      pageScripts: async () => { throw abortError(); },
    },
    decisions: [
      { type: 'tool', tool: 'chatgpt.page.scripts', arguments: {}, purpose: 'list scripts' },
      { type: 'final', answer: 'unreachable', completedTasks: [], remaining: [] },
    ],
  });
  await assert.rejects(
    () => harness.engine.run({ goal: 'cancelled', conversationId: 'conversation-cancel' }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.CANCELLED, 'cancellation must remain cancellation, not failure');
}

async function testRecoveryBudgetIsBounded() {
  let calls = 0;
  const harness = createHarness({
    maxToolErrorRecoveries: 2,
    client: {
      enabled: true,
      pageScripts: async () => { calls += 1; throw Object.assign(new Error('transient'), { code: 'provider-error' }); },
    },
    decisions: Array.from({ length: 8 }, () => ({ type: 'tool', tool: 'chatgpt.page.scripts', arguments: {}, purpose: 'retry forever' })),
  });
  await assert.rejects(
    () => harness.engine.run({ goal: 'budget', conversationId: 'conversation-budget' }),
    (error) => error.code === 'provider-error',
  );
  assert.equal(calls, 3, 'the recovery budget must stop unbounded retries');
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.FAILED);
}

/* A claim that throws leaves ownership indeterminate, so the cleanup
   obligation must survive the recovery and the retry must still work. */
async function testWorkerClaimFailureKeepsCleanupObligation() {
  const calls = [];
  let claims = 0;
  const harness = createHarness({
    client: workerClient({
      claim: async (args) => {
        claims += 1;
        calls.push(['claim', args.workerId]);
        if (claims === 1) throw Object.assign(new Error('worker busy'), { code: 'worker-busy' });
        return { workerId: args.workerId, claimed: true };
      },
      release: async (args) => { calls.push(['release', args.workerId]); return { workerId: args.workerId, released: true }; },
    }),
    decisions: [
      { type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'claim a worker' },
      { type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'retry the claim' },
      { type: 'final', answer: 'claim recovered', completedTasks: ['claim'], remaining: [] },
    ],
  });

  const result = await harness.engine.run({ goal: 'claim recovery', conversationId: 'conversation-claim' });
  assert.equal(result.answer, 'claim recovered');
  assert.equal(claims, 2, 'the Supervisor must be able to retry a failed claim');
  assert.deepEqual(calls.map((call) => call[0]), ['claim', 'claim', 'release'], 'the recovered claim must still be released exactly once');
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.COMPLETED);
}

/* Recovery can now reach a normal ending after an ambiguous claim, so the
   ambiguous slot must still be released — best effort, without failing the run. */
async function testAbandonedAmbiguousClaimStillReleases() {
  const calls = [];
  const harness = createHarness({
    client: workerClient({
      claim: async () => {
        calls.push('claim');
        throw Object.assign(new Error('Dev Worker RPC timed out: dev.worker.claim'), { code: 'transport-failure' });
      },
      release: async () => { calls.push('release'); return { released: true }; },
    }),
    decisions: [
      { type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'claim a worker' },
      { type: 'final', answer: 'gave up on the Worker', completedTasks: [], remaining: ['worker delegation'] },
    ],
  });

  const result = await harness.engine.run({ goal: 'abandon an ambiguous claim', conversationId: 'conversation-abandon' });
  assert.equal(result.answer, 'gave up on the Worker');
  assert.deepEqual(calls, ['claim', 'release'], 'an abandoned ambiguous claim must still be released');
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.PAUSED, 'remaining work leaves the run paused, not failed');

  /* A release failure on a slot that was never held must not fail the run. */
  const quiet = [];
  const quietHarness = createHarness({
    client: workerClient({
      claim: async () => {
        quiet.push('claim');
        throw Object.assign(new Error('claim timed out'), { code: 'transport-failure' });
      },
      release: async () => {
        quiet.push('release');
        throw Object.assign(new Error('no lease is held'), { code: 'no-lease' });
      },
    }),
    decisions: [
      { type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'claim a worker' },
      { type: 'final', answer: 'finished without a Worker', completedTasks: ['analysis'], remaining: [] },
    ],
  });
  const quietResult = await quietHarness.engine.run({ goal: 'ambiguous claim cleanup', conversationId: 'conversation-quiet' });
  assert.equal(quietResult.answer, 'finished without a Worker');
  assert.deepEqual(quiet, ['claim', 'release']);
  assert.equal(quietHarness.settings.lastRun.status, DEV_RUN_STATUS.COMPLETED);
}

/* A release that throws must not drop the claim: the run still owns it. */
async function testReleaseFailureKeepsClaimOwnership() {
  const calls = [];
  let releases = 0;
  const harness = createHarness({
    client: workerClient({
      claim: async (args) => { calls.push('claim'); return { workerId: args.workerId, claimed: true }; },
      release: async () => {
        releases += 1;
        calls.push('release');
        if (releases === 1) throw Object.assign(new Error('release transport failed'), { code: 'transport-failure' });
        return { released: true };
      },
    }),
    decisions: [
      { type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'claim a worker' },
      { type: 'tool', tool: 'worker.release', arguments: {}, purpose: 'release the worker' },
      { type: 'final', answer: 'release recovered', completedTasks: ['release'], remaining: [] },
    ],
  });

  const result = await harness.engine.run({ goal: 'release recovery', conversationId: 'conversation-release' });
  assert.equal(result.answer, 'release recovered');
  assert.deepEqual(calls, ['claim', 'release', 'release'], 'a failed release must leave the claim owned so the run releases it again');
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.COMPLETED);
}

/* #5137: tool-controlled free-form error text is untrusted and cannot be
   certified secret-free by key-name/value patterns — the issue's exact
   counterexample (`Authorization failed: <secret>`) matches none of them.
   Provider-bound history therefore carries only the failure class (code/name)
   plus fixed guidance; free-form diagnostic text stays in local diagnostics. */
async function testErrorMessageSecretRedaction() {
  const secret = 'must-not-leak';

  /* Reviewer-exact minimal counterexample: `Authorization failed: <secret>`
     defeats every key=value / bearer / token pattern. */
  const harness = createHarness({
    client: {
      enabled: true,
      pageScripts: async () => {
        throw Object.assign(new Error(`Authorization failed: ${secret}`), { code: 'provider-error' });
      },
    },
    decisions: [
      { type: 'tool', tool: 'chatgpt.page.scripts', arguments: { authorization: secret }, purpose: 'inspect scripts' },
      { type: 'final', answer: 'recovered from the withheld failure', completedTasks: ['inspect'], remaining: [] },
    ],
  });

  const result = await harness.engine.run({ goal: 'echo the secret back', conversationId: 'conversation-secret-message' });
  assert.equal(result.answer, 'recovered from the withheld failure', 'withholding the message must not break recovery');

  const errorEntry = harness.historyAt(1).find((entry) => entry.kind === DEV_TOOL_ERROR_HISTORY_KIND);
  assert.ok(errorEntry, 'the failed tool must be returned to the Supervisor as tool-error history');
  assert.equal(errorEntry.code, 'provider-error', 'the safe error code must still reach the Supervisor');
  assert.equal(errorEntry.arguments.authorization, '[redacted]', 'arguments stay redacted');
  assert.doesNotMatch(JSON.stringify(harness.historyAt(1)), /must-not-leak/, 'no history field may carry the secret');
  assert.doesNotMatch(harness.prompts[1], /must-not-leak/, 'the next Supervisor prompt must not contain the secret');
  assert.ok(errorEntry.message.length <= 512, 'the provider-bound message stays bounded');
  assert.doesNotMatch(errorEntry.message, /Authorization failed/, 'no raw free-form diagnostic text is provider-bound');

  /* Credential-shaped echoes are equally withheld. */
  const tokenSecret = 'sk-test-MUST-NOT-LEAK';
  const tokenHarness = createHarness({
    client: {
      enabled: true,
      pageScripts: async () => {
        throw Object.assign(new Error(`Authorization failed for token ${tokenSecret}`), { code: 'provider-error' });
      },
    },
    decisions: [
      { type: 'tool', tool: 'chatgpt.page.scripts', arguments: { authorization: tokenSecret }, purpose: 'inspect scripts' },
      { type: 'final', answer: 'recovered from the token echo', completedTasks: ['inspect'], remaining: [] },
    ],
  });
  await tokenHarness.engine.run({ goal: 'echo the token back', conversationId: 'conversation-token-message' });
  assert.doesNotMatch(JSON.stringify(tokenHarness.historyAt(1)), /MUST-NOT-LEAK/, 'credential-shaped echoes stay out of history');
  assert.doesNotMatch(tokenHarness.prompts[1], /MUST-NOT-LEAK/, 'credential-shaped echoes stay out of the prompt');

  /* Local diagnostics keep the free-form text, bounded (#5137 required
     assertion 5): the description itself never exceeds its bound. */
  const described = describeDevToolError(withCode(new Error(`Authorization failed: ${'x'.repeat(5000)}`), 'provider-error'));
  assert.ok(described.message.length <= 512, 'the local diagnostic description stays bounded');
  const benign = describeDevToolError(new Error('connection refused after 3 retries'));
  assert.equal(benign.message, 'connection refused after 3 retries', 'benign non-secret diagnostics stay readable locally');

  /* Terminal error path (#5137 required assertion 6): the raw secret-bearing
     error stays available to the local caller, but no provider-bound field of
     any later prompt re-injects it. */
  let terminalCalls = 0;
  const terminalHarness = createHarness({
    client: {
      enabled: true,
      pageScripts: async () => {
        terminalCalls += 1;
        if (terminalCalls === 1) {
          throw Object.assign(new Error(`Authorization failed: ${secret}`), { code: 'dev-extension-integrity-mismatch' });
        }
        return { scripts: [] };
      },
    },
    decisions: [
      { type: 'tool', tool: 'chatgpt.page.scripts', arguments: { authorization: secret }, purpose: 'list scripts' },
      { type: 'tool', tool: 'chatgpt.page.scripts', arguments: {}, purpose: 'observe in a fresh run' },
      { type: 'final', answer: 'fresh run after terminal failure', completedTasks: [], remaining: [] },
    ],
  });
  let terminalError;
  await assert.rejects(
    () => terminalHarness.engine.run({ goal: 'terminal secret', conversationId: 'conversation-terminal-secret' }),
    (error) => {
      terminalError = error;
      return error.code === 'dev-extension-integrity-mismatch';
    },
  );
  assert.match(terminalError.message, /must-not-leak/, 'the raw error stays available to the local caller');
  assert.equal(terminalHarness.settings.lastRun.status, DEV_RUN_STATUS.FAILED, 'the terminal failure still fails the run');
  const fresh = await terminalHarness.engine.run({ goal: 'fresh run', conversationId: 'conversation-terminal-secret' });
  assert.equal(fresh.answer, 'fresh run after terminal failure');
  for (const [index, prompt] of terminalHarness.prompts.entries()) {
    if (index === 0) continue; /* the failed run's own prompt predates the tool error */
    assert.doesNotMatch(prompt, /must-not-leak/, `no provider-bound prompt after the terminal failure may carry the secret (prompt ${index})`);
  }
}

function createHarness({ client, decisions, maxToolErrorRecoveries }) {
  let sequence = 0;
  const prompts = [];
  const sessionKeys = [];
  const supervisor = new DevSupervisorV0({
    workerClient: client,
    idFactory: (kind) => `${kind}-${++sequence}`,
    now: () => '2026-08-18T00:00:00.000Z',
  });
  const settings = {
    decisionPolicy: 'normal',
    analysisScope: undefined,
    lastRun: null,
    setLastRun(run) { this.lastRun = run; },
  };
  let index = 0;
  const bridge = {
    async request(prompt, options = {}) {
      prompts.push(String(prompt));
      sessionKeys.push(String(options.sessionKey || ''));
      const decision = decisions[Math.min(index, decisions.length - 1)];
      index += 1;
      return JSON.stringify(decision);
    },
  };
  const engine = new DevSupervisorEngineV0({
    supervisor,
    settings,
    bridge,
    ...(maxToolErrorRecoveries == null ? {} : { maxToolErrorRecoveries }),
  });
  return {
    engine,
    settings,
    prompts,
    sessionKeys,
    historyAt(promptIndex) { return readHistory(prompts[promptIndex]); },
  };
}

function readHistory(prompt) {
  const match = String(prompt).match(/<HEX_DEV_DATA>\n([\s\S]*?)\n<\/HEX_DEV_DATA>/);
  assert.ok(match, 'the Supervisor prompt must carry its data block');
  return JSON.parse(match[1]).history;
}

function workerClient(overrides) {
  const unused = async () => { throw new Error('unexpected Dev Worker call in this regression.'); };
  return {
    enabled: true,
    discover: unused, claim: unused, createChat: unused, send: unused, observe: unused,
    followup: unused, nudge: unused, stop: unused, result: unused, release: unused, waitEvent: unused,
    ...overrides,
  };
}

function withCode(error, code) { error.code = code; return error; }
function abortError() { const error = new Error('aborted'); error.name = 'AbortError'; return error; }
