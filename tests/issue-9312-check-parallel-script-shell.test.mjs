import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { runCheckParallel, shellInvocation } from '../scripts/run-check-parallel.mjs';

function sink() { return { write() {} }; }

test('#9312 configured POSIX npm script shell is used without splitting paths', () => {
  assert.deepEqual(
    shellInvocation('printf ok', { env:{ npm_config_script_shell:'/opt/My Shell/bin/bash' }, platform:'linux' }),
    { command:'/opt/My Shell/bin/bash', args:['-c', 'printf ok'] },
  );
});

test('#9312 default POSIX and Windows shell behavior remains platform-correct', () => {
  assert.deepEqual(shellInvocation('echo ok', { env:{}, platform:'linux' }), { command:'/bin/sh', args:['-c', 'echo ok'] });
  assert.deepEqual(
    shellInvocation('echo ok', { env:{ ComSpec:'C:\\Windows\\System32\\cmd.exe' }, platform:'win32' }),
    { command:'C:\\Windows\\System32\\cmd.exe', args:['/d', '/s', '/c', 'echo ok'] },
  );
  assert.deepEqual(
    shellInvocation('echo ok', { env:{ npm_config_script_shell:'C:\\Program Files\\Git\\bin\\bash.exe' }, platform:'win32' }),
    { command:'C:\\Program Files\\Git\\bin\\bash.exe', args:['-c', 'echo ok'] },
  );
});

test('#9312 Bash-only canonical step succeeds when npm_config_script_shell selects Bash', { skip:!fs.existsSync('/bin/bash') }, async () => {
  const env = { ...process.env, npm_config_script_shell:'/bin/bash' };
  const result = await runCheckParallel({
    checkScript:'[[ -n "$BASH_VERSION" ]]',
    env,
    platform:process.platform,
    stdout:sink(), stderr:sink(),
  });
  assert.equal(result.failures.length, 0);
  assert.equal(result.results[0]?.ok, true);
});
