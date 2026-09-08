import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryFromGit, loadManifest as loadPhase7, validateFiles as validatePhase7 } from '../phase7-ownership.mjs';
import { loadManifest as loadPhase8, validateFiles as validatePhase8 } from '../phase8-ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const BRANCH = 'feat/analysis-roadmap-v8-current-main-20260907';
const SPECIAL_PATHS = Object.freeze({
  semanticCompat: ['js/ir-core.js', 'js/semantics/compat/semantic-ir-v2-to-v1-memory.js'],
  integration: ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml', '.github/workflows/phase8-ownership.yml',
    'docs/symbolic-proof-optimizer-v8.md', 'docs/analysis-roadmap-v8-integration-checkpoint.md', 'js/decompile.js',
    'tests/issue-5498-eligibility-result-status-authority.mjs',
    'js/targets/architecture/arm64e/effects.js', 'tests/machine-effects/arm64e-retained-provider-union.test.mjs',
    'js/targets/architecture/arm64/effects/memory.js', 'tests/machine-effects/arm64-literal-target-coherence.test.mjs',
    'tests/machine-effects/arm64-direct-branch-coherence.test.mjs',
    'tools/validation/analysis-roadmap/ownership.mjs', 'tools/validation/analysis-roadmap/ownership.json',
    'userscript/hex.user.template.js', 'userscript/release-version.json'],
});

export function loadRoadmapManifest() {
  return JSON.parse(fs.readFileSync(new URL('./ownership.json', import.meta.url), 'utf8'));
}

export function validateRoadmapManifest(manifest) {
  if (manifest?.version !== 1 || manifest.branch !== BRANCH) throw new TypeError('invalid roadmap manifest identity');
  const ownerNames = ['phase7', 'phase8', 'symbolic', 'semanticCompat', 'integration'];
  if (!manifest.owners || Object.keys(manifest.owners).length !== ownerNames.length
      || ownerNames.some(owner => !Object.hasOwn(manifest.owners, owner))) throw new TypeError('invalid roadmap owners');
  const assignment = new Map();
  for (const owner of ownerNames) {
    const files = manifest.owners[owner];
    if (!Array.isArray(files) || !files.length) throw new TypeError('empty roadmap owner');
    for (const file of files) {
      if (typeof file !== 'string' || !file || file.startsWith('/') || file.includes('\\')
          || file.includes('\0') || /[*?\[\]]/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new TypeError('roadmap ownership requires exact repository paths');
      }
      if (assignment.has(file)) throw new TypeError(`duplicate roadmap owner: ${file}`);
      if (owner === 'symbolic' && !file.startsWith('js/symbolic/') && !file.startsWith('tests/phase9/')) {
        throw new TypeError(`outside symbolic owner: ${file}`);
      }
      if (SPECIAL_PATHS[owner] && !SPECIAL_PATHS[owner].includes(file)) throw new TypeError(`outside ${owner} owner: ${file}`);
      assignment.set(file, owner);
    }
  }
  // The existing phase manifests remain authoritative for their own slices.
  // Relabeling a frozen semantic contract as Phase 7/8 cannot bypass them.
  for (const [owner, load, validate] of [['phase7', loadPhase7, validatePhase7], ['phase8', loadPhase8, validatePhase8]]) {
    const result = validate(load(), manifest.owners[owner]);
    if (!result.valid) throw new TypeError(`${owner} contract violations: ${JSON.stringify(result.violations)}`);
  }
  return assignment;
}

export function validateRoadmapInventory(branch, phase, files, manifest = loadRoadmapManifest()) {
  if (branch !== BRANCH || !['phase7', 'phase8'].includes(phase)) throw new TypeError('no exact roadmap integration route');
  const assignment = validateRoadmapManifest(manifest);
  if (!Array.isArray(files) || !files.length) throw new TypeError('empty roadmap inventory');
  for (const file of files) if (!assignment.has(file)) throw new TypeError(`undeclared roadmap path: ${JSON.stringify(file)}`);
  const selected = [...new Set(files.filter(file => assignment.get(file) === phase))].sort();
  if (!selected.length) throw new TypeError(`no ${phase} changes in roadmap inventory`);
  return selected;
}

export function runCli(argv = process.argv.slice(2), { root = ROOT, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const args = new Map();
    for (let i = 0; i < argv.length; i += 2) {
      if (!['--branch', '--phase', '--base-sha', '--head-sha'].includes(argv[i]) || args.has(argv[i])
          || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new TypeError('invalid roadmap inventory arguments');
      args.set(argv[i], argv[i + 1]);
    }
    if (args.size !== 4) throw new TypeError('branch, phase, exact base and head are required');
    const inventory = inventoryFromGit(root, args.get('--base-sha'), args.get('--head-sha'));
    const selected = validateRoadmapInventory(args.get('--branch'), args.get('--phase'), inventory.files);
    stdout.write(`${JSON.stringify(selected)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`roadmap ownership: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = runCli();
