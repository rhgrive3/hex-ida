import assert from 'node:assert/strict';
import test from 'node:test';

import { main, runProductionDeploy, SubprocessSignalError } from '../scripts/deploy-production.mjs';

function result(status, signal = null, error = undefined) {
  return { status, signal, error, stdout:null, stderr:null, output:[null,null,null] };
}

test('#9303 validator signal termination preserves signal identity and stops before Wrangler', () => {
  let calls = 0;
  assert.throws(
    () => runProductionDeploy({ run() { calls += 1; return result(null, 'SIGTERM'); } }),
    (error) => error instanceof SubprocessSignalError && error.signal === 'SIGTERM' && /SIGTERM/.test(error.message),
  );
  assert.equal(calls, 1);
});

test('#9303 Wrangler signal termination preserves signal identity', () => {
  let calls = 0;
  assert.throws(
    () => runProductionDeploy({
      run() {
        calls += 1;
        return calls === 1 ? result(0) : result(null, 'SIGKILL');
      },
    }),
    (error) => error instanceof SubprocessSignalError && error.signal === 'SIGKILL' && /SIGKILL/.test(error.message),
  );
  assert.equal(calls, 2);
});

test('#9303 ordinary exit codes, spawn errors, and success retain their contracts', () => {
  let calls = 0;
  assert.equal(runProductionDeploy({ run() { calls += 1; return result(7); } }), 7);
  assert.equal(calls, 1);

  calls = 0;
  assert.equal(runProductionDeploy({ run() { calls += 1; return calls === 1 ? result(0) : result(9); } }), 9);
  assert.equal(calls, 2);

  const spawnError = Object.assign(new Error('spawn failed'), { code:'ENOENT' });
  assert.throws(() => runProductionDeploy({ run() { return result(null, null, spawnError); } }), (error) => error === spawnError);

  calls = 0;
  assert.equal(runProductionDeploy({ run() { calls += 1; return result(0); } }), 0);
  assert.equal(calls, 2);
});

test('#9303 top-level deploy diagnostic reports the terminating signal', () => {
  const reported = [];
  const code = main([], {
    run() { return result(null, 'SIGTERM'); },
    reportError(message) { reported.push(message); },
  });
  assert.equal(code, 1);
  assert.deepEqual(reported, ['Production auth validator terminated by signal SIGTERM']);
});
