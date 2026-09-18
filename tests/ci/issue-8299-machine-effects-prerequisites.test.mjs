import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MACHINE_EFFECTS_BASELINE,
  auditMachineEffectsPrerequisites,
  assertMachineEffectsPrerequisites,
} from '../../tools/validation/machine-effects/prerequisites.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fakeRunner(command, args) {
  if (command === 'git') {
    if (args[0] === 'cat-file') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') {
      const spec = args[1];
      const entry = MACHINE_EFFECTS_BASELINE.blobs.find(({ path: ref }) => spec === `${MACHINE_EFFECTS_BASELINE.commit}:${ref}`);
      return { status: entry ? 0 : 1, stdout: entry ? `${entry.sha}\n` : '', stderr: '' };
    }
  }
  const name = path.basename(command);
  const version = name.startsWith('clang') ? 'Debian clang version 18.1.8' : 'Debian LLVM version 18.1.8';
  const targets = /(?:llvm-mc|clang)/.test(name) ? '\nRegistered Targets:\n  aarch64 - AArch64 (little endian)' : '';
  return { status: 0, stdout: `${version}${targets}\n`, stderr: '' };
}

const audit = auditMachineEffectsPrerequisites({ env: {}, runner: fakeRunner });
assert.equal(audit.ok, true);
assert.equal(audit.schemaVersion, 'machine-effects-prerequisites/v1');
assert.deepEqual(audit.tools.map(({ id }) => id), ['llvm-mc', 'clang', 'llvm-objdump', 'llvm-objcopy']);
assert.equal(audit.history.commit, MACHINE_EFFECTS_BASELINE.commit);
assert.deepEqual(audit.history.blobs.map(({ sha }) => sha), MACHINE_EFFECTS_BASELINE.blobs.map(({ sha }) => sha));

assert.throws(() => assertMachineEffectsPrerequisites({
  env: {},
  runner(command, args) {
    if (command === 'git' && args[0] === 'cat-file' && args[2]?.endsWith('^{commit}')) return { status: 1, stdout: '', stderr: 'missing' };
    return fakeRunner(command, args);
  },
}), /missing historical commit 3f3778e5.*git fetch --no-tags origin 3f3778e5/s);

const invariant = fs.readFileSync(path.join(ROOT, '.github/workflows/invariant-gates.yml'), 'utf8');
for (const lane of ['analysis-proof', 'repo-regression']) {
  const start = invariant.indexOf(`name: '${lane}'`);
  assert.notEqual(start, -1, `missing ${lane} lane`);
  const block = invariant.slice(start, invariant.indexOf('\n            },', start) + 15);
  assert.match(block, /frozenToolchain: 'true'/, `${lane} must provision LLVM 18`);
  assert.match(block, /machineEffectsPrereqs: 'true'/, `${lane} must run MachineEffects preflight`);
}
assert.match(invariant, /fetch-depth: 0/);
assert.match(invariant, /node tools\/validation\/machine-effects\/prerequisites\.mjs/);

for (const workflow of ['stage2-nonphysical-closure.yml', 'stage2-release-validation.yml']) {
  const source = fs.readFileSync(path.join(ROOT, '.github/workflows', workflow), 'utf8');
  assert.match(source, /fetch-depth: 0/, `${workflow} must keep full Git history`);
  assert.match(source, /apt-get install -y clang-18 lld-18 llvm-18/, `${workflow} must provision LLVM 18`);
  assert.match(source, /node tools\/validation\/machine-effects\/prerequisites\.mjs/, `${workflow} must validate MachineEffects prerequisites`);
}

const runner = fs.readFileSync(path.join(ROOT, 'tests/machine-effects/run.mjs'), 'utf8');
assert.match(runner, /assertMachineEffectsPrerequisites\(\);/);
const a2 = fs.readFileSync(path.join(ROOT, 'tools/validation/machine-effects/a2-denominator.mjs'), 'utf8');
assert.match(a2, /auditMachineEffectsHistory\(\{ cwd: ROOT \}\);/);

console.log('issue #8299 MachineEffects prerequisite contract: PASS');
