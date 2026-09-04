import { spawnSync } from 'node:child_process';

const groups = Object.freeze({
  'repo-a': ['npm run lint', 'npm run migration:test', 'npm run module-boundaries:test'],
  'repo-b': ['npm run evidence-writers:test', 'npm run phase7:test', 'npm run phase9:test'],
  'repo-c': ['npm run phase10:test', 'npm run phase11:test', 'npm run phase12:test'],
  'repo-d': ['npm run phase6:test', 'npm test'],
});

const group = process.argv[2];
const commands = groups[group];
if (!commands) throw new Error(`unknown invariant probe group: ${group}`);

const failures = [];
for (const command of commands) {
  console.log(`--- ${command}`);
  const result = spawnSync(command, { shell: true, stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0) {
    failures.push({ command, status: result.status, error: result.error?.message ?? null });
  }
}
if (failures.length) {
  console.error(`Invariant command probe failures: ${JSON.stringify(failures)}`);
  process.exit(1);
}
console.log(`invariant command probe ${group}: PASS`);
