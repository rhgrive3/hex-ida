import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './round4-bootstrap-gate.mjs';
import { AdminAuthProvider, AllowAllAdminProvider, readAdminIdentity } from '../../js/ai/dev/auth/admin-provider.js';
import { availableAgentProfiles, canSelectAgentProfile } from '../../js/ai/dev/policy/agent-profile.js';
import { DEV_DECISION_POLICIES, assertDevDecisionPolicy, devDecisionPolicyContract } from '../../js/ai/dev/policy/decision-policy.js';
import { createAnalysisScopeRequest, createDevAnalysisScopeRequest, toLegacyAnalysisScope } from '../../js/ai/dev/run/analysis-scope.js';
import { DEV_RUN_IDENTITY_FIELDS, DEV_RUN_STATUS, transitionDevRun } from '../../js/ai/dev/run/dev-run.js';
import { DEV_SUPERVISOR_PROTOCOL, DEV_SUPERVISOR_DECISION_TYPES, validateDevSupervisorDecision, parseDevSupervisorDecision } from '../../js/ai/dev/protocol/hex-dev-supervisor-v1.js';
import { DevSupervisorV0 } from '../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DevAgentUiSettings } from '../../js/ai/dev/ui/settings.js';
import { createAgentProfileEngine } from '../../js/ai/dev/ui/engine-router.js';
import { ScopeController, SCOPE_ORDER } from '../../js/ai/control/scope.js';
import { ProposalStore } from '../../js/ai/proposals.js';

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok    ' + name); }
  catch (error) { failures++; console.log('FAIL  ' + name + ' — ' + (error?.stack || error)); }
}

await check('dev-profile-admin-visibility', () => {
  const allow = readAdminIdentity(new AllowAllAdminProvider());
  assert.deepEqual(allow, { authenticated: true, admin: true, provider: 'allow-all-admin' });
  assert.deepEqual([...availableAgentProfiles(allow)], ['standard', 'dev']);
  assert.equal(canSelectAgentProfile(allow, 'dev'), true);
  class NonAdminProvider extends AdminAuthProvider { getIdentity(){ return { authenticated: true, admin: false, provider: 'fixture' }; } }
  const settings = new DevAgentUiSettings({ authProvider: new NonAdminProvider(), storage: null });
  assert.deepEqual([...settings.profiles()], ['standard']);
  assert.throws(() => settings.setAgentProfile('dev'), /Admin privileges/);
});

await check('dev-policy-normal-yolo', () => {
  const memory = new Map();
  const storage = { getItem: (key) => memory.get(key) || null, setItem: (key, value) => memory.set(key, value) };
  const settings = new DevAgentUiSettings({ storage });
  assert.deepEqual([...DEV_DECISION_POLICIES], ['normal', 'yolo']);
  assert.equal(settings.decisionPolicy, 'normal');
  assert.equal(devDecisionPolicyContract('normal').securityOrPermissionBoundary, 'human-confirmation-normally');
  assert.equal(devDecisionPolicyContract('yolo').securityOrPermissionBoundary, 'autonomous');
  assert.equal(devDecisionPolicyContract('yolo').availableCapabilitiesOnly, true);
  assert.equal(devDecisionPolicyContract('normal').mayAskHuman, true);
  settings.setDecisionPolicy('yolo');
  assert.equal(new DevAgentUiSettings({ storage }).decisionPolicy, 'yolo');
  assert.throws(() => assertDevDecisionPolicy('unsafe'), /Unsupported/);
});

await check('dev-analysis-scope-none', () => {
  const none = createDevAnalysisScopeRequest();
  assert.deepEqual(none, { initial: 'none', expansionPolicy: 'agent' });
  assert.equal(toLegacyAnalysisScope(none), null);
  assert.deepEqual(createAnalysisScopeRequest({ initial: 'binary', expansionPolicy: 'locked' }), { initial: 'binary', expansionPolicy: 'locked' });
  assert.equal(toLegacyAnalysisScope({ initial: 'binary', expansionPolicy: 'auto' }), 'auto');
  assert.throws(() => createAnalysisScopeRequest({ initial: 'auto', expansionPolicy: 'agent' }), /Unsupported analysis scope/);
});

await check('dev-supervisor-protocol', () => {
  assert.equal(DEV_SUPERVISOR_PROTOCOL, 'hex-dev-supervisor-v1');
  assert.deepEqual([...DEV_SUPERVISOR_DECISION_TYPES], ['tool', 'human', 'wait', 'final']);
  assert.equal(validateDevSupervisorDecision({ type: 'tool', tool: 'repo.read', arguments: {}, purpose: 'inspect' }, { availableTools: ['repo.read'] }).type, 'tool');
  assert.equal(validateDevSupervisorDecision({ type: 'human', question: 'Continue?', blocking: true }).blocking, true);
  assert.deepEqual(validateDevSupervisorDecision({ type: 'wait', events: [], reason: 'nothing to do' }).events, []);
  assert.equal(validateDevSupervisorDecision({ type: 'final', answer: 'done', completedTasks: [], remaining: [] }).type, 'final');
  assert.throws(() => validateDevSupervisorDecision({ type: 'tool', tool: 'invented', arguments: {}, purpose: 'x' }, { availableTools: ['repo.read'] }), /Unavailable Dev tool/);
  assert.throws(() => validateDevSupervisorDecision({ type: 'tool', tool: 'repo.read', arguments: {}, purpose: 'x', extra: true }), /Malformed/);
  assert.throws(() => validateDevSupervisorDecision({ type: 'worker', worker: 'x' }), /Unsupported/);
  assert.throws(() => parseDevSupervisorDecision('```json\n{}\n```'), /exactly one JSON object/);
});

await check('dev-run-state', () => {
  let n = 0;
  const supervisor = new DevSupervisorV0({
    idFactory: (kind) => `${kind}-${++n}`,
    now: () => `2026-08-17T00:00:0${n % 9}.000Z`,
    availableTools: ['repo.read'],
  });
  let run = supervisor.createRun({ goal: 'implement round 1', plan: ['inspect', 'implement'] });
  assert.equal(run.agentProfile, 'dev');
  assert.equal(run.status, DEV_RUN_STATUS.PLANNING);
  assert.equal(run.analysisScope.initial, 'none');
  for (const field of DEV_RUN_IDENTITY_FIELDS) assert.ok(Object.hasOwn(run, field), field);
  assert.ok(run.runId);
  assert.ok(run.supervisorSessionKey);
  assert.equal(run.workerId, null);
  assert.equal(run.chatgptProjectContext, null);
  ({ run } = supervisor.applyDecision(run, { type: 'tool', tool: 'repo.read', arguments: {}, purpose: 'inspect' }));
  assert.equal(run.status, 'ACTIVE');
  ({ run } = supervisor.applyDecision(run, { type: 'wait', events: ['worker.completed'], reason: 'wait' }));
  assert.equal(run.status, 'WAITING_EVENT');
  ({ run } = supervisor.applyDecision(run, { type: 'human', question: 'Security boundary?', blocking: true }));
  assert.equal(run.status, 'WAITING_HUMAN');
  assert.throws(() => transitionDevRun(run, 'COMPLETED'), /Invalid DevRun transition/);
});

await check('dev-profile-engine-isolation', async () => {
  const settings = new DevAgentUiSettings({ storage: null });
  let standardCalls = 0;
  const standardEngine = {
    async run(input) { standardCalls++; return { answer: `standard:${input.question}` }; },
    capabilities() { return { providers: [] }; },
  };
  let id = 0;
  const supervisor = new DevSupervisorV0({ idFactory: (kind) => `${kind}-${++id}`, now: () => `2026-08-17T00:00:0${id}.000Z` });
  const engine = createAgentProfileEngine({ standardEngine, settings, supervisor });
  assert.equal((await engine.run({ mode: 'chat', question: 'q' })).answer, 'standard:q');
  assert.equal((await engine.run({ mode: 'agent', question: 'q' })).answer, 'standard:q');
  assert.equal(standardCalls, 2);
  settings.setAgentProfile('dev');
  settings.setDecisionPolicy('yolo');
  settings.setAnalysisScope('none');
  const result = await engine.run({ mode: 'agent', question: 'build safely', conversationId: 'hex-c1', onActivity() {} });
  assert.equal(standardCalls, 2, 'Dev must not fall back to Standard Agent engine');
  assert.match(result.answer, /Dev Supervisor run/);
  assert.equal(Object.hasOwn(result, 'devRun'), false, 'DevRun must not leak into the Standard response schema');
  const run = settings.lastRun;
  assert.equal(run.agentProfile, 'dev');
  assert.equal(run.decisionPolicy, 'yolo');
  assert.deepEqual(run.analysisScope, { initial: 'none', expansionPolicy: 'agent' });
  assert.equal(run.hexConversationId, 'hex-c1');
  assert.equal(run.status, 'ACTIVE');
});

await check('standard-agent-policy-isolation', async () => {
  const evidenceStore = { has: (id) => id === 'ev-1' };
  const store = new ProposalStore({ evidenceStore });
  const proposal = store.create({ kind: 'comment', target: { address: '0x1000' }, before: null, after: 'note', evidenceIds: ['ev-1'] });
  let applied = false;
  await assert.rejects(() => store.apply(proposal.id, { currentState: null, apply: async () => { applied = true; } }), /approval/i);
  assert.equal(applied, false);
  const { approvalToken } = store.approve(proposal.id);
  await store.apply(proposal.id, { approvalToken, currentState: null, apply: async () => { applied = true; } });
  assert.equal(applied, true);
});

await check('standard-agent-scope-regression', () => {
  assert.deepEqual([...SCOPE_ORDER], ['selection', 'function', 'neighborhood', 'binary', 'project', 'runtime']);
  const snapshot = { binaryId: 'b', currentFunction: { address: '0x1000', range: { start: '0x1000', end: '0x1100' } }, selection: null };
  const auto = new ScopeController(snapshot, 'auto');
  assert.equal(auto.effectiveScope, 'function');
  assert.equal(auto.expandTo('binary', 'need search'), true);
  assert.equal(auto.effectiveScope, 'binary');
  const locked = new ScopeController(snapshot, 'function');
  assert.equal(locked.expandTo('binary', 'must stay locked'), false);
  assert.equal(locked.effectiveScope, 'function');
});

function staticModuleSpecifiers(source) {
  const matches = [];
  for (const pattern of [
    /^\s*import\s*['"]([^'"]+)['"]\s*;?/gm,
    /^\s*import\s+[^;]*?\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
    /^\s*export\s+(?:\*\s+as\s+(?:[A-Za-z_$][\w$]*|['"][^'"]+['"])|\*|\{[^;]*?\})\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
  ]) {
    for (const match of source.matchAll(pattern)) matches.push({ index: match.index, specifier: match[1] });
  }
  return matches.sort((left, right) => left.index - right.index).map(({ specifier }) => specifier);
}

const DYNAMIC_IMPORT_PATTERN = /\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029]|$))*\(/;

await check('dev-context-packet-dependency-boundary', () => {
  const source = readFileSync(new URL('../../js/ai/dev/protocol/context-packet.js', import.meta.url), 'utf8');
  assert.deepEqual(staticModuleSpecifiers(source), ['../run/analysis-scope.js']);
  assert.doesNotMatch(source, DYNAMIC_IMPORT_PATTERN, 'context packet must not gain dynamic import authority');
  assert.deepEqual(
    staticModuleSpecifiers("import './side-effect.js';\nexport { value } from './re-export.js';\nexport * as storage from '../storage.js';"),
    ['./side-effect.js', './re-export.js', '../storage.js'],
  );
  assert.match("void import('./dynamic.js')", DYNAMIC_IMPORT_PATTERN);
  assert.match("void import /* dependency */ ('./dynamic.js')", DYNAMIC_IMPORT_PATTERN);
  assert.match("void import // dependency\n('./dynamic.js')", DYNAMIC_IMPORT_PATTERN);
  assert.match("void import // dependency\r('./dynamic.js')", DYNAMIC_IMPORT_PATTERN);
  assert.match("void import // dependency\r\n('./dynamic.js')", DYNAMIC_IMPORT_PATTERN);
  assert.match("void import // dependency\u2028('./dynamic.js')", DYNAMIC_IMPORT_PATTERN);
  assert.match("void import // dependency\u2029('./dynamic.js')", DYNAMIC_IMPORT_PATTERN);
});

console.log(failures ? `\n${failures} dev-agent test(s) failed` : '\ndev-agent round1 foundation: PASS');
if (failures) process.exit(1);
