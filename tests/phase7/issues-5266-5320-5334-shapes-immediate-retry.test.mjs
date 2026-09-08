import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('#5266/#5320/#5334 last-waiter abort does not poison an immediate retry', async () => {
  const first = deferred();
  const second = deferred();
  const gates = [first, second];
  let calls = 0;
  let cancels = 0;
  const app = {
    backend: {
      gen: 0,
      valueShapes() {
        const gate = gates[calls++];
        assert.ok(gate, 'retry must not start more than one fresh replacement');
        const request = gate.promise;
        request.cancel = () => { cancels++; };
        return request;
      },
    },
    programRegions: () => [{ id:'r1', exec:true, size:10n }],
  };
  installDemandDrivenAnalysis(app);

  const controller = new AbortController();
  const p1 = app.ensureShapes({ signal:controller.signal });
  assert.equal(calls, 1);
  controller.abort();

  const p2 = app.ensureShapes({});
  assert.equal(calls, 2, 'same-turn retry must start a fresh producer instead of reusing the dead entry');
  await assert.rejects(p1, (error) => error?.name === 'AbortError');
  assert.ok(cancels >= 1, 'the abandoned producer must be cancelled');

  second.resolve({ count:0 });
  const result = await p2;
  assert.ok(result instanceof Map, 'fresh retry must complete independently');
});
