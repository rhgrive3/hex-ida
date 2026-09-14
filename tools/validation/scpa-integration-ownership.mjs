import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inventoryFromGit } from './phase5-ownership.mjs';
import { loadManifest as loadPhase7, validateFiles as validatePhase7, regexFor } from './phase7-ownership.mjs';
import { loadManifest as loadPhase8, validateFiles as validatePhase8 } from './phase8-ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST = path.join(ROOT, 'tools/validation/phase-ownership/scpa-integration.json');
export const SCPA_INTEGRATION_BRANCH = 'feat/scpa-functional-acceptance-20260912';
const OWNER_IDS = Object.freeze([
  'phase7', 'phase8', 'core', 'application-runtime', 'binary-apple-recognition',
  'semantic-compatibility', 'scpa-verification', 'documentation', 'integration',
]);
const PHASES = Object.freeze({
  7: { load: loadPhase7, validate: validatePhase7, lane: 'p7' },
  8: { load: loadPhase8, validate: validatePhase8, lane: 'p8' },
});

function ownerAccepts(owner, file) {
  // These boundaries describe owner responsibility, not wildcard write grants:
  // every admitted file must still appear exactly once in the reviewed manifest.
  // Shared Phase 7 paths with narrower phase-specific constraints keep their
  // actual integration owner when this lane changes ABI or knowledge storage.
  if (owner === 'phase7') return file !== 'js/semantics/compat/index.js' && file !== 'js/knowledge/index.js';
  if (owner === 'phase8') return true; // Checked against the unchanged phase manifest below.
  if (owner === 'core') return file.startsWith('js/core/');
  if (owner === 'application-runtime') return /^(js\/(ai|cache|platform|runtime|runtime-evidence)\/|js\/(backend|worker-legacy)\.js$)/.test(file);
  if (owner === 'binary-apple-recognition') return /^(js\/(binary|fingerprint|knowledge|recognition)\/|js\/swift(?:-context)?\.js$)/.test(file);
  if (owner === 'semantic-compatibility') return file.startsWith('js/semantics/compat/');
  if (owner === 'scpa-verification') return /^(tests\/|tools\/(competitive-arm64|lib|portable-checker|validation\/competitive)\/)/.test(file);
  if (owner === 'documentation') return file.startsWith('docs/');
  if (owner === 'integration') return file.startsWith('reports/scpa/') || [
    '.circleci/config.yml', '.github/workflows/phase7-ownership.yml', '.github/workflows/phase8-ownership.yml',
    '.github/workflows/ghidra-differential.yml',
    'package.json', 'tests/ci/scpa-integration-ownership.test.mjs',
    'tools/validation/phase-ownership/scpa-integration.json', 'tools/validation/scpa-integration-ownership.mjs',
    'tools/validation/phase5-ownership.mjs',
    'userscript/hex.user.template.js', 'userscript/release-version.json',
  ].includes(file);
  return false;
}

function exactPath(file) {
  return typeof file === 'string' && file.length > 0
    && !/[\\\x00-\x20\x7f*?\[\]]/.test(file)
    && !file.startsWith('/') && !/^[A-Za-z]:/.test(file)
    && !file.split('/').some((part) => part === '' || part === '.' || part === '..');
}

export function validateScpaManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 'hex-scpa-integration-ownership/v1'
      || manifest.branch !== SCPA_INTEGRATION_BRANCH
      || !manifest.owners || typeof manifest.owners !== 'object' || Array.isArray(manifest.owners)) {
    throw new TypeError('invalid SCPA integration ownership manifest');
  }
  const owners = Object.keys(manifest.owners);
  if (owners.length !== OWNER_IDS.length || owners.some((owner) => !OWNER_IDS.includes(owner))) {
    throw new TypeError('SCPA integration ownership has an unknown or missing owner');
  }
  if (!manifest.ownerResponsibilities || Object.keys(manifest.ownerResponsibilities).length !== OWNER_IDS.length
      || OWNER_IDS.some((owner) => typeof manifest.ownerResponsibilities[owner] !== 'string'
        || manifest.ownerResponsibilities[owner].trim().length === 0)) {
    throw new TypeError('SCPA integration must document every owner responsibility');
  }
  const registered = new Map();
  for (const owner of OWNER_IDS) {
    const paths = manifest.owners[owner];
    if (!Array.isArray(paths) || paths.length === 0) throw new TypeError(`empty SCPA owner: ${owner}`);
    for (const file of paths) {
      if (!exactPath(file)) throw new TypeError(`SCPA ownership requires exact repository paths: ${JSON.stringify(file)}`);
      if (registered.has(file)) throw new TypeError(`duplicate SCPA ownership: ${file}`);
      if (!ownerAccepts(owner, file)) throw new TypeError(`SCPA owner responsibility mismatch: ${owner}: ${file}`);
      registered.set(file, owner);
    }
  }
  // A path assigned to a phase must also satisfy that phase's unchanged
  // ownership contract. Other owner slices are admitted only by exact path;
  // they never gain write permission within either phase's manifest.
  for (const phase of Object.keys(PHASES)) {
    const definition = PHASES[phase];
    const result = definition.validate(definition.load(), manifest.owners[`phase${phase}`]);
    if (!result.valid) throw new TypeError(`SCPA phase${phase} owner contradicts its phase contract`);
  }
  return registered;
}

export function loadScpaManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  validateScpaManifest(manifest);
  return manifest;
}

export function validateScpaInventory(branch, phase, files, { manifest = loadScpaManifest() } = {}) {
  if (branch !== SCPA_INTEGRATION_BRANCH) throw new TypeError(`no SCPA integration route for branch ${JSON.stringify(branch)}`);
  if (phase !== 7 && phase !== 8) throw new TypeError('SCPA ownership phase must be 7 or 8');
  const registered = validateScpaManifest(manifest);
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => !exactPath(file))) {
    throw new TypeError('SCPA changed-file inventory must contain exact repository paths');
  }
  const unique = [...new Set(files)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const unexpected = unique.filter((file) => !registered.has(file));
  if (unexpected.length) throw new TypeError(`SCPA integration has unregistered paths: ${unexpected.join(', ')}`);
  const definition = PHASES[phase];
  const phaseManifest = definition.load();
  const owned = unique.filter((file) => phaseManifest.lanes[definition.lane].some((pattern) => regexFor(pattern).test(file)));
  if (!owned.length) throw new TypeError(`SCPA integration has no Phase ${phase}-owned paths`);
  const result = definition.validate(phaseManifest, owned);
  if (!result.valid) throw new TypeError(`SCPA Phase ${phase} subset violates its phase contract`);
  return Object.freeze(owned);
}

export function runCli(argv = process.argv.slice(2), { root = ROOT, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const values = new Map();
    for (let index = 0; index < argv.length; index += 2) {
      const key = argv[index], value = argv[index + 1];
      if (!['--branch', '--phase', '--base-sha', '--head-sha'].includes(key)
          || values.has(key) || typeof value !== 'string' || value.startsWith('--')) {
        throw new TypeError(`invalid SCPA ownership argument: ${key}`);
      }
      values.set(key, value);
    }
    if (values.size !== 4 || !['7', '8'].includes(values.get('--phase'))) {
      throw new TypeError('SCPA ownership requires branch, phase (7 or 8), exact base SHA and exact head SHA');
    }
    const inventory = inventoryFromGit(root, values.get('--base-sha'), values.get('--head-sha'));
    const owned = validateScpaInventory(values.get('--branch'), Number(values.get('--phase')), inventory.files);
    stdout.write(`${JSON.stringify(owned)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`SCPA integration ownership: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = runCli();
