import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeAnalysisPlatform } from '../../../js/runtime/index.js';

function platformWith(adapter) {
  const platform = new RuntimeAnalysisPlatform({ symbolic:false });
  const controllers = new Set();
  const session = {
    id:'debug:fixture',
    adapter,
    backend:adapter.kind || 'fixture',
    binaryHash:'fixture:4138',
    controller() {
      const controller = new AbortController();
      controllers.add(controller);
      return controller;
    },
    releaseController(controller) { controllers.delete(controller); },
    acceptEvent() { return true; },
  };
  platform.currentSession = () => session;
  return platform;
}

function adapterWith(capabilities, methods = {}) {
  return {
    kind:'fixture',
    capabilities:{
      launch:false,
      attach:false,
      resume:false,
      traceFunction:false,
      replay:false,
      ...capabilities,
    },
    ...methods,
  };
}

test('P10 runtime attach-only adapter rejects missing target before resume (#4138)', async () => {
  let resumeCalls = 0;
  const adapter = adapterWith({ attach:true, resume:true }, {
    async resume() {
      resumeCalls++;
      throw new Error('resume-called');
    },
  });
  const platform = platformWith(adapter);

  await assert.rejects(
    platform.traceFunction(0x1000n, {}),
    (error) => error?.code === 'attach-target-required',
  );
  assert.equal(resumeCalls, 0, 'missing attach target must fail before resume side effects');
});

test('P10 runtime attach-only adapter attaches before resume when target is supplied (#4138)', async () => {
  const calls = [];
  const sentinel = new Error('resume-stop');
  const adapter = adapterWith({ attach:true, resume:true }, {
    async attach(target) { calls.push(['attach', target]); },
    async resume() { calls.push(['resume']); throw sentinel; },
  });
  const platform = platformWith(adapter);
  const target = { pid:4138 };

  await assert.rejects(platform.traceFunction(0x1000n, { attach:target }), (error) => error === sentinel);
  assert.deepEqual(calls, [['attach', target], ['resume']]);
});

test('P10 runtime launch path remains authoritative over attach (#4138)', async () => {
  const calls = [];
  const sentinel = new Error('resume-stop');
  const adapter = adapterWith({ launch:true, attach:true, resume:true }, {
    async launch() { calls.push('launch'); },
    async attach() { calls.push('attach'); },
    async resume() { calls.push('resume'); throw sentinel; },
  });
  const platform = platformWith(adapter);

  await assert.rejects(platform.traceFunction(0x1000n, { attach:{ pid:1 } }), (error) => error === sentinel);
  assert.deepEqual(calls, ['launch', 'resume']);
});

test('P10 runtime direct trace path does not require an attach target (#4138)', async () => {
  const calls = [];
  const sentinel = new Error('trace-stop');
  const adapter = adapterWith({ attach:true, traceFunction:true }, {
    async attach() { calls.push('attach'); },
    async trace() { calls.push('trace'); throw sentinel; },
  });
  const platform = platformWith(adapter);

  await assert.rejects(platform.traceFunction(0x1000n, {}), (error) => error === sentinel);
  assert.deepEqual(calls, ['trace']);
});
