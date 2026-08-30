import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryDigest, inventoryFromGit } from './phase5-ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(ROOT, 'tools/validation/phase-ownership/c3-02.json');

function loadManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const featurePaths = Array.isArray(manifest.featurePaths) ? manifest.featurePaths : [];
  const generatedPaths = Array.isArray(manifest.generatedPaths) ? manifest.generatedPaths : [];
  const governancePaths = Array.isArray(manifest.governancePaths) ? manifest.governancePaths : [];
  const owners = manifest.owners && typeof manifest.owners === 'object' ? manifest.owners : {};
  const owned = Object.values(owners).flat();
  const errors = [];
  if (manifest.feature !== 'HEX-C3-02') errors.push('feature must be HEX-C3-02');
  if (!Number.isSafeInteger(manifest.version) || manifest.version < 1) errors.push('version must be positive');
  if (new Set(featurePaths).size !== featurePaths.length || featurePaths.length !== 38) errors.push('featurePaths must contain exactly 38 unique paths');
  if (new Set(generatedPaths).size !== generatedPaths.length || generatedPaths.length !== 2) errors.push('generatedPaths must contain exactly two unique paths');
  if (new Set(governancePaths).size !== governancePaths.length || governancePaths.length !== 2) errors.push('governancePaths must contain exactly two unique paths');
  const all = [...featurePaths, ...generatedPaths, ...governancePaths];
  if (new Set(all).size !== all.length) errors.push('feature, generated, and governance paths must be disjoint');
  const missingOwners = featurePaths.filter((file) => !owned.includes(file));
  const duplicateOwners = owned.filter((file, index) => owned.indexOf(file) !== index && featurePaths.includes(file));
  if (missingOwners.length) errors.push(`unowned feature paths: ${missingOwners.join(', ')}`);
  if (duplicateOwners.length) errors.push(`multiply-owned feature paths: ${[...new Set(duplicateOwners)].join(', ')}`);
  return { manifest, errors };
}

export function validateManifest(manifest = loadManifest().manifest) {
  const featurePaths = Array.isArray(manifest?.featurePaths) ? manifest.featurePaths : [];
  const generatedPaths = Array.isArray(manifest?.generatedPaths) ? manifest.generatedPaths : [];
  const governancePaths = Array.isArray(manifest?.governancePaths) ? manifest.governancePaths : [];
  const owners = manifest?.owners && typeof manifest.owners === 'object' ? manifest.owners : {};
  const owned = Object.values(owners).flat();
  return Object.freeze([
    ...(manifest?.feature === 'HEX-C3-02' ? [] : ['feature must be HEX-C3-02']),
    ...(featurePaths.length === 38 && new Set(featurePaths).size === 38 ? [] : ['featurePaths must contain exactly 38 unique paths']),
    ...(generatedPaths.length === 2 && new Set(generatedPaths).size === 2 ? [] : ['generatedPaths must contain exactly two unique paths']),
    ...(governancePaths.length === 2 && new Set(governancePaths).size === 2 ? [] : ['governancePaths must contain exactly two unique paths']),
    ...featurePaths.filter((file) => !owned.includes(file)).map((file) => `unowned feature path: ${file}`),
    ...featurePaths.filter((file, index) => featurePaths.indexOf(file) !== index).map((file) => `duplicate feature path: ${file}`),
  ]);
}

export function validateFiles(manifest, files, { allowGenerated = true, allowGovernance = true } = {}) {
  if (!Array.isArray(files)) throw new TypeError('changed files must be an array');
  const feature = new Set(manifest.featurePaths);
  const generated = new Set(manifest.generatedPaths);
  const governance = new Set(manifest.governancePaths);
  const allowed = new Set([
    ...feature,
    ...(allowGenerated ? generated : []),
    ...(allowGovernance ? governance : []),
  ]);
  const unique = [...new Set(files)].sort();
  const violations = unique.filter((file) => !allowed.has(file));
  return Object.freeze({
    featureCount:unique.filter((file) => feature.has(file)).length,
    generatedCount:unique.filter((file) => generated.has(file)).length,
    governanceCount:unique.filter((file) => governance.has(file)).length,
    files:Object.freeze(unique),
    violations:Object.freeze(violations),
    valid:violations.length === 0,
  });
}

function parseArgs(argv) {
  const out = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--check-manifest') out.set(token, true);
    else if (token === '--files-json' || token === '--base-sha' || token === '--head-sha') {
      if (out.has(token) || argv[index + 1] == null) throw new TypeError(`invalid ${token}`);
      out.set(token, argv[++index]);
    } else throw new TypeError(`unknown argument: ${token}`);
  }
  return out;
}

export function runCli(argv = process.argv.slice(2), { root = ROOT, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { manifest, errors:loadErrors } = loadManifest();
    const errors = [...loadErrors, ...validateManifest(manifest)];
    if (errors.length) throw new TypeError(errors.join('; '));
    const args = parseArgs(argv);
    if (args.has('--check-manifest')) {
      if (args.size !== 1) throw new TypeError('--check-manifest cannot be combined with inventory arguments');
      stdout.write(`${JSON.stringify({ feature:manifest.feature, version:manifest.version, featurePaths:manifest.featurePaths.length, generatedPaths:manifest.generatedPaths.length, valid:true })}\n`);
      return 0;
    }
    let files;
    let baseSha = null;
    let headSha = null;
    if (args.has('--files-json')) {
      files = JSON.parse(args.get('--files-json'));
    } else if (args.has('--base-sha') && args.has('--head-sha')) {
      ({ files, baseSha, headSha } = inventoryFromGit(root, args.get('--base-sha'), args.get('--head-sha')));
    } else throw new TypeError('provide --files-json or both --base-sha and --head-sha');
    const result = validateFiles(manifest, files);
    if (!result.valid) {
      for (const file of result.violations) stderr.write(`c3-02 ownership: outside inventory: ${JSON.stringify(file)}\n`);
      return 1;
    }
    stdout.write(`${JSON.stringify({ feature:manifest.feature, version:manifest.version, baseSha, headSha, ...result, inventoryDigest:inventoryDigest(result.files) })}\n`);
    return 0;
  } catch (error) {
    stderr.write(`c3-02 ownership: ${error.message}\n`);
    return 2;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = runCli();
