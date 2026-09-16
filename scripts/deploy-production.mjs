import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const validatorPath = resolve(repoRoot, 'scripts/validate-auth-config.mjs');
const wranglerPath = resolve(repoRoot, 'node_modules/wrangler/bin/wrangler.js');

export function runProductionDeploy({ run = spawnSync, args = [] } = {}) {
  if (args.length) throw new Error('Production deploy does not accept Wrangler config or environment overrides; edit wrangler.jsonc and retry.');
  const validation = run(process.execPath, [validatorPath], { cwd: repoRoot, stdio: 'inherit' });
  if (validation.error) throw validation.error;
  if (validation.status !== 0) return validation.status ?? 1;

  const deployment = run(process.execPath, [wranglerPath, 'deploy'], { cwd: repoRoot, stdio: 'inherit' });
  if (deployment.error) throw deployment.error;
  return deployment.status ?? 1;
}

export function main(args = process.argv.slice(2), { run = spawnSync, reportError = console.error } = {}) {
  try {
    return runProductionDeploy({ args, run });
  } catch (error) {
    reportError(error instanceof Error ? error.message : 'Production deploy failed.');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
