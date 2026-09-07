import { spawnSync } from 'node:child_process';

/**
 * Run one package-script command from the selected semantic-v2 checkout.
 *
 * Login shells source the host profile, which can change directory before the
 * command starts. Keep this runner non-login so the explicit checkout cwd is
 * the cwd observed by compilers and every descendant process.
 */
export function spawnSemanticRunnerCommand(command, {
  cwd,
  env,
  maxBuffer = 64 * 1024 * 1024,
  timeout = 600_000,
} = {}) {
  if (typeof command !== 'string' || !command.trim()) {
    throw new TypeError('semantic-v2 runner command must be a non-empty string');
  }
  if (typeof cwd !== 'string' || !cwd) {
    throw new TypeError('semantic-v2 runner cwd must be an explicit path');
  }
  return spawnSync('bash', ['-c', command], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer,
    timeout,
  });
}
