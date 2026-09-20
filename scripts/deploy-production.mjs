import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const validatorPath = resolve(repoRoot, 'scripts/validate-auth-config.mjs');
const wranglerPath = resolve(repoRoot, 'node_modules/wrangler/bin/wrangler.js');
const productionConfigPath = resolve(repoRoot, 'wrangler.jsonc');

export class SubprocessSignalError extends Error {
  constructor(label, signal) {
    super(`${label} terminated by signal ${signal}`);
    this.name = 'SubprocessSignalError';
    this.signal = signal;
  }
}

export function subprocessStatus(result, label) {
  if (result?.error) throw result.error;
  if (result?.signal) throw new SubprocessSignalError(label, result.signal);
  if (!Number.isInteger(result?.status)) throw new Error(`${label} returned no exit status`);
  return result.status;
}

export function runProductionDeploy({
  run = spawnSync,
  args = [],
  configPath = productionConfigPath,
  readFileSync = fs.readFileSync,
  openSync = fs.openSync,
  writeFileSync = fs.writeFileSync,
  closeSync = fs.closeSync,
  readSnapshotSync = fs.readFileSync,
  lstatSync = fs.lstatSync,
  rmSync = fs.rmSync,
  randomUUIDImpl = randomUUID,
  snapshotDirectory = repoRoot,
} = {}) {
  if (args.length) throw new Error('Production deploy does not accept Wrangler config or environment overrides; edit wrangler.jsonc and retry.');
  const approvedBytes = Buffer.from(readFileSync(configPath));
  const snapshotPath = resolve(snapshotDirectory, `.wrangler.production-snapshot-${process.pid}-${randomUUIDImpl()}.jsonc`);
  let ownsSnapshot = false;
  try {
    const snapshotFd = openSync(snapshotPath, 'wx', 0o400);
    ownsSnapshot = true;
    try {
      writeFileSync(snapshotFd, approvedBytes);
    } finally {
      closeSync(snapshotFd);
    }

    const snapshotEntry = lstatSync(snapshotPath);
    if (snapshotEntry.isSymbolicLink() || !snapshotEntry.isFile()) throw new Error('Production config snapshot is not a regular file.');

    const validation = run(process.execPath, [validatorPath, `--config=${snapshotPath}`], { cwd: repoRoot, stdio: 'inherit' });
    const validationStatus = subprocessStatus(validation, 'Production auth validator');
    if (validationStatus !== 0) return validationStatus;

    const beforeDeploy = Buffer.from(readSnapshotSync(snapshotPath));
    if (!beforeDeploy.equals(approvedBytes)) throw new Error('Production config snapshot changed after validation.');
    const deployment = run(process.execPath, [wranglerPath, 'deploy', '--config', snapshotPath], { cwd: repoRoot, stdio: 'inherit' });
    return subprocessStatus(deployment, 'Wrangler deployment');
  } finally {
    if (ownsSnapshot) rmSync(snapshotPath, { force: true });
  }
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
