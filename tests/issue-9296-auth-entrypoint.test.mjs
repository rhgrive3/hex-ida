import assert from 'node:assert/strict';
import test from 'node:test';

import { validateAuthConfig } from '../scripts/validate-auth-config.mjs';

function validConfig(main = './worker-entry.js') {
  return {
    main,
    d1_databases: [{
      binding: 'AUTH_DB',
      database_name: 'hex-auth',
      database_id: '11111111-2222-3333-4444-555555555555',
      migrations_dir: 'migrations/auth',
    }],
    assets: { run_worker_first: true },
  };
}

test('#9296 production auth config pins the authenticated worker entrypoint', () => {
  assert.equal(validateAuthConfig(validConfig('./worker-entry.js')), true);
  assert.equal(validateAuthConfig(validConfig('worker-entry.js')), true);

  for (const main of ['./worker.js', 'worker.js', './scripts/other.js', '', null, 42, undefined]) {
    const config = validConfig(main);
    if (main === undefined) delete config.main;
    assert.throws(
      () => validateAuthConfig(config),
      /Production worker entrypoint must be worker-entry\.js/,
      `must reject main=${String(main)}`,
    );
  }
});

test('#9296 local validation remains focused on local D1/runtime policy', () => {
  const config = validConfig('./worker.js');
  config.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000000';
  assert.equal(validateAuthConfig(config, { local: true }), true);
});
