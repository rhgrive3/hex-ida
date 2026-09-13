import assert from 'node:assert/strict';
import { AGENT_PROFILE } from '../js/ai/dev/policy/agent-profile.js';
import { createAgentProfileEngine } from '../js/ai/dev/ui/engine-router.js';

function devStub() {
  return {
    calls: [],
    async run(input) { this.calls.push(input); return { source: 'dev', thisIsDev: this.calls !== undefined }; },
    prepareBootstrapExtension() { return { capability: 'prepare', thisIsDev: typeof this.bootstrapProbe === 'function' }; },
    activateBootstrapAtSafeBoundary(options) { return { capability: 'activate', options }; },
    invokeBootstrapCapability(name) { return { capability: 'invoke', name }; },
    bootstrapSessionFor(conversationId) { return { capability: 'sessionFor', conversationId }; },
    createBootstrapCheckpoint(options) { return { capability: 'checkpoint', options }; },
    restoreBootstrapHandoff(handoff) { return { capability: 'restore', handoff }; },
    runBootstrapProof(options) { return { capability: 'proof', options }; },
    bootstrapProbe() { return true; },
  };
}

function fixedOwn(target, key, value) {
  Object.defineProperty(target, key, { value, configurable: false, writable: false, enumerable: true });
  return target;
}

{
  const standardEngine = {};
  const observed = [];
  fixedOwn(standardEngine, 'run', async function issueRepro(input = {}) {
    observed.push(this === standardEngine);
    return { source: 'standard', mode: input.mode };
  });

  const routed = createAgentProfileEngine({
    standardEngine,
    settings: { agentProfile: AGENT_PROFILE.STANDARD },
    devEngine: devStub(),
  });
  assert.equal(!!routed, true);
  assert.equal(typeof routed.run, 'function', 'reading run on a fixed own run must not violate a Proxy invariant');
  const result = await routed.run({ mode: 'chat' });
  assert.deepEqual(result, { source: 'standard', mode: 'chat' });
  assert.deepEqual(observed, [true], 'the original standardEngine.run must receive the engine as this');
}

{
  const standardEngine = Object.freeze({ run: async function frozenRun() { return { source: 'standard', thisIsEngine: this === standardEngine }; } });
  const routed = createAgentProfileEngine({
    standardEngine,
    settings: { agentProfile: AGENT_PROFILE.STANDARD },
    devEngine: devStub(),
  });
  assert.equal(Object.isFrozen(standardEngine), true);
  assert.deepEqual(await routed.run({ mode: 'agent' }), { source: 'standard', thisIsEngine: true }, 'a frozen engine must stay routable in Standard profile');
}

{
  const standardEngine = {};
  Object.defineProperty(standardEngine, 'run', {
    get() { return async (input = {}) => ({ source: 'standard', mode: input.mode, thisIsEngine: this === standardEngine }); },
    configurable: false,
    enumerable: true,
  });
  const routed = createAgentProfileEngine({
    standardEngine,
    settings: { agentProfile: AGENT_PROFILE.STANDARD },
    devEngine: devStub(),
  });
  assert.deepEqual(await routed.run({ mode: 'agent' }), { source: 'standard', mode: 'agent', thisIsEngine: true }, 'a fixed own run accessor must stay routable');
}

{
  const standardEngine = {};
  fixedOwn(standardEngine, 'run', async function sealedRun() {
    return { source: 'standard', thisIsEngine: this === standardEngine };
  });
  fixedOwn(standardEngine, 'capabilities', async function fixedCapabilities() {
    return { thisIsEngine: this === standardEngine, list: ['read'] };
  });
  fixedOwn(standardEngine, 'localContext', { binaryId: 'bin-1' });
  Object.defineProperty(standardEngine, 'sessionStore', {
    get() { return { thisIsEngine: this === standardEngine, store: 'core' }; },
    configurable: false,
    enumerable: true,
  });
  Object.seal(standardEngine);

  const routed = createAgentProfileEngine({
    standardEngine,
    settings: { agentProfile: AGENT_PROFILE.STANDARD },
    devEngine: devStub(),
  });
  assert.deepEqual(await routed.run({ mode: 'chat' }), { source: 'standard', thisIsEngine: true });
  assert.deepEqual(await routed.capabilities(), { thisIsEngine: true, list: ['read'] }, 'fixed own non-run function properties must be readable and bound to the engine');
  assert.deepEqual(routed.localContext, { binaryId: 'bin-1' });
  assert.deepEqual(routed.sessionStore, { thisIsEngine: true, store: 'core' }, 'fixed own accessors must be readable');
  assert.equal(routed.missing, undefined);
}

{
  const standardEngine = fixedOwn({}, 'run', async function standard(input = {}) {
    return { source: 'standard', mode: input.mode, thisIsEngine: this === standardEngine };
  });
  const devEngine = devStub();
  const settings = { agentProfile: AGENT_PROFILE.STANDARD };
  const routed = createAgentProfileEngine({ standardEngine, settings, devEngine });

  assert.equal((await routed.run({ mode: 'chat' })).source, 'standard');
  assert.equal((await routed.run({ mode: 'agent' })).source, 'standard', 'Standard profile must not route agent mode to Dev');
  settings.agentProfile = AGENT_PROFILE.DEV;
  const devResult = await routed.run({ mode: 'agent', question: 'q' });
  assert.equal(devResult.source, 'dev');
  assert.equal(devResult.thisIsDev, true);
  assert.deepEqual(devEngine.calls, [{ mode: 'agent', question: 'q' }]);
  assert.equal((await routed.run({ mode: 'chat' })).source, 'standard', 'Dev profile must keep chat mode on the standard engine');
}

{
  const standardEngine = fixedOwn({}, 'run', async () => ({ source: 'standard' }));
  const devEngine = devStub();
  const routed = createAgentProfileEngine({
    standardEngine,
    settings: { agentProfile: AGENT_PROFILE.DEV },
    devEngine,
  });
  for (const capability of ['prepare', 'activateAtSafeBoundary', 'invoke', 'sessionFor', 'createCheckpoint', 'restore', 'runProof']) {
    assert.equal(typeof routed.devBootstrap[capability], 'function', `devBootstrap.${capability} must remain exposed`);
  }
  assert.equal(Object.isFrozen(routed.devBootstrap), true, 'the devBootstrap surface must stay frozen');
  assert.deepEqual(await routed.devBootstrap.prepare(), { capability: 'prepare', thisIsDev: true });
  assert.deepEqual(routed.devBootstrap.activateAtSafeBoundary({ checkpoint: 'cp-1' }), { capability: 'activate', options: { checkpoint: 'cp-1' } });
  assert.deepEqual(routed.devBootstrap.invoke('dev.bootstrap.cap'), { capability: 'invoke', name: 'dev.bootstrap.cap' });
  assert.deepEqual(routed.devBootstrap.sessionFor('conv-1'), { capability: 'sessionFor', conversationId: 'conv-1' });
  assert.deepEqual(routed.devBootstrap.createCheckpoint({ reason: 'r' }), { capability: 'checkpoint', options: { reason: 'r' } });
  assert.deepEqual(routed.devBootstrap.restore({ handoff: 'h' }), { capability: 'restore', handoff: { handoff: 'h' } });
  assert.deepEqual(await routed.devBootstrap.runProof({ proof: 'p' }), { capability: 'proof', options: { proof: 'p' } });
}

{
  class StandardEngine {
    constructor() {
      this.field = 'instance-field';
    }

    async run(input = {}) {
      return { source: 'class', thisIsEngine: this instanceof StandardEngine, field: this.field, mode: input.mode };
    }

    marker() { return `marker:${this.field}`; }
  }

  const standardEngine = new StandardEngine();
  const routed = createAgentProfileEngine({
    standardEngine,
    settings: { agentProfile: AGENT_PROFILE.STANDARD },
    devEngine: devStub(),
  });
  assert.ok(routed instanceof StandardEngine, 'a class instance engine must keep its prototype identity through the router');
  assert.equal(routed.field, 'instance-field');
  assert.equal(routed.marker(), 'marker:instance-field', 'prototype methods must stay bound to the original engine');
  assert.deepEqual(await routed.run({ mode: 'agent' }), { source: 'class', thisIsEngine: true, field: 'instance-field', mode: 'agent' });
}

{
  assert.throws(() => createAgentProfileEngine({ settings: { agentProfile: AGENT_PROFILE.STANDARD } }), /standardEngine.run is required/);
  assert.throws(() => createAgentProfileEngine({ standardEngine: {}, settings: { agentProfile: AGENT_PROFILE.STANDARD } }), /standardEngine.run is required/);
  assert.throws(() => createAgentProfileEngine({ standardEngine: { run: async () => ({}) } }), /DevAgentUiSettings is required/);
}

console.log('issue #4617 engine-router descriptor-invariant regressions passed');
