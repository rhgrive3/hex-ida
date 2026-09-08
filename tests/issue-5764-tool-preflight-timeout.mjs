import assert from 'node:assert/strict';
import { ToolRegistry } from '../js/ai/tools/index.js';

function never() {
  return new Promise(() => {});
}

{
  let bodyRuns = 0;
  let validatorSignal = null;
  const registry = new ToolRegistry({
    context: {
      addressExists(_address, options) {
        validatorSignal = options?.signal ?? null;
        return never();
      },
    },
  });
  registry.register({
    name:'preflight_timeout',
    inputSchema:{ type:'object' },
    execute:async () => { bodyRuns++; return { ok:true }; },
  });

  const started = Date.now();
  await assert.rejects(
    () => registry.execute('preflight_timeout', { address:'0x1000' }, { toolTimeoutMs:20 }),
    (error) => error?.type === 'tool_failed' && /preflight_timeout timed out/i.test(error.message),
  );
  assert.ok(Date.now() - started < 1000, 'address validation must honor the tool deadline');
  assert.equal(bodyRuns, 0, 'tool body must not run after a timed-out preflight');
  assert.ok(validatorSignal?.aborted, 'the validator must receive the execution signal');
  assert.equal(registry.executionSignal, null, 'preflight timeout must restore registry signal state');
}

{
  const registry = new ToolRegistry({
    context: {
      addressExists:() => true,
      scopeContainsAddress:() => never(),
    },
  });
  registry.register({
    name:'scope_preflight_timeout',
    scopeSupport:['binary'],
    inputSchema:{ type:'object' },
    execute:async () => ({ ok:true }),
  });
  await assert.rejects(
    () => registry.execute('scope_preflight_timeout', { address:'0x1000' }, { scope:'binary', toolTimeoutMs:20 }),
    (error) => error?.type === 'tool_failed' && /scope_preflight_timeout timed out/i.test(error.message),
  );
}

{
  const controller = new AbortController();
  const registry = new ToolRegistry({ context:{ addressExists:() => never() } });
  registry.register({ name:'preflight_cancel', inputSchema:{ type:'object' }, execute:async () => ({ ok:true }) });
  const pending = registry.execute('preflight_cancel', { address:'0x1000' }, { signal:controller.signal, toolTimeoutMs:1000 });
  setTimeout(() => controller.abort('test-cancel'), 5);
  await assert.rejects(pending, (error) => error?.type === 'cancelled');
}

console.log('issue-5764-tool-preflight-timeout: PASS');
