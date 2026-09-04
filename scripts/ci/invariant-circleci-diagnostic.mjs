import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const mode = process.argv[2];

function planContract() {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const parts = String(pkg.scripts?.check || '')
    .split(/\s+&&\s+/)
    .map((command) => command.trim())
    .filter(Boolean);
  if (parts.length < 2) throw new Error('npm check must contain at least two independent top-level commands');

  const required = [
    'npm run invariants:test',
    'npm run semantic-v2:test',
    'npm run phase4:test',
    'npm run phase5:test',
    'npm run phase6:test',
    'npm run phase8:test',
    'npm test',
    'npm run benchmark:baseline',
  ];
  for (const command of required) {
    if (!parts.includes(command)) throw new Error(`npm check layout changed; missing ${command}`);
  }

  const reserved = new Set(required);
  const coreContracts = parts.filter((command) => !reserved.has(command));
  if (!coreContracts.length) throw new Error('npm check must contain core contract commands');
  const lanes = [
    ['npm run phase8:test'],
    ['npm run phase4:test', 'npm run phase5:test'],
    ['npm run invariants:test', 'npm run semantic-v2:test', 'npm run benchmark:baseline'],
    [...coreContracts, 'npm run phase6:test', 'npm test'],
  ];
  const scheduled = lanes.flat();
  const counts = new Map();
  for (const command of scheduled) counts.set(command, (counts.get(command) || 0) + 1);
  if (
    scheduled.length !== parts.length ||
    parts.some((command) => counts.get(command) !== 1) ||
    scheduled.some((command) => !parts.includes(command))
  ) {
    throw new Error(`npm-check shard plan mismatch expected=${JSON.stringify(parts)} actual=${JSON.stringify(scheduled)}`);
  }
  console.log('invariant plan contract: PASS');
}

function runCommands(commands) {
  const failures = [];
  for (const command of commands) {
    console.log(`--- ${command}`);
    const result = spawnSync(command, {
      shell: true,
      stdio: 'inherit',
      env: process.env,
    });
    if (result.error || result.status !== 0) {
      failures.push({ command, status: result.status, error: result.error?.message ?? null });
    }
  }
  if (failures.length) {
    console.error(`Invariant diagnostic failures: ${JSON.stringify(failures)}`);
    process.exit(1);
  }
}

switch (mode) {
  case 'plan':
    planContract();
    break;
  case 'phase45':
    runCommands(['npm run phase4:test', 'npm run phase5:test']);
    break;
  case 'analysis-proof-tail':
    runCommands(['npm run semantic-v2:test', 'npm run benchmark:baseline']);
    break;
  case 'repo-regression':
    runCommands([
      'npm run lint',
      'npm run migration:test',
      'npm run module-boundaries:test',
      'npm run evidence-writers:test',
      'npm run phase7:test',
      'npm run phase9:test',
      'npm run phase10:test',
      'npm run phase11:test',
      'npm run phase12:test',
      'npm run phase6:test',
      'npm test',
    ]);
    break;
  default:
    throw new Error(`unknown invariant diagnostic mode: ${mode}`);
}
