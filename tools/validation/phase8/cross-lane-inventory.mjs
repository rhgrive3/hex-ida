import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inventoryFromGit,
  loadManifest,
  regexFor,
} from '../phase8-ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MAIN_GATE_BATCH_LANE = 'fix/main-gate-recovery-20260913';

// This is an exact, short-lived integration route for the current gate-repair
// candidate. Phase 8 validates only its own subset; every foreign path is
// enumerated so this route cannot become a general ownership exemption.
export const CROSS_LANE_ROUTES = Object.freeze({
  [MAIN_GATE_BATCH_LANE]: Object.freeze([
    '.circleci/config.yml',
    '.github/workflows/phase7-ownership.yml',
    'js/analysis/debug/dwarf.js',
    'js/binary/macho-dyld.js',
    'js/semantics/memoryssa/build.js',
    'js/targets/abi/aapcs64-core.js',
    'js/targets/architecture/riscv64/decoded-instruction.js',
    'tests/machine-effects/a2-denominator-inventory.json',
    'tests/machine-effects/issue-5566-x86-setssbsy-routing.test.mjs',
    'tests/machine-effects/issue-5999-riscv64-compressed-capability-conflict.test.mjs',
    'tests/machine-effects/issue-6133-x87-trusted-terminal-domain.test.mjs',
    'tests/machine-effects/x86-long64-integer-denominator.test.mjs',
    'tests/phase11/cil/cil-parser.test.mjs',
    'tests/phase11/dex/dex-class-data-field-index-3729.test.mjs',
    'tests/phase11/dex/dex-validation-1143.test.mjs',
    'tests/phase12/run.mjs',
    'tests/scpa/native-reference-navigation.test.mjs',
    'tests/scpa/native-retained-async-integration.test.mjs',
    'tests/scpa/native-retained-async.test.mjs',
    'tests/scpa/store-producer.test.mjs',
    'tests/scpa/transform-native.test.mjs',
    'tests/phase4/binary/issue-3787-chained-stub-section-containment.test.mjs',
    'tests/phase4/binary/issue-3904-pe-delay-import-malformed-thunk.test.mjs',
    'tests/phase4/binary/issue-4155-macho-source-cache-metadata-limits.test.mjs',
    'tests/phase4/binary/issue-4746-pe-delay-import-reserved-attrs.test.mjs',
    'tests/phase4/binary/issue-5584-elf-signal-dynamic.test.mjs',
    'tests/phase4/binary/pe-utf8-cstring-budget-6286.test.mjs',
    'tests/phase4/foundation/runner-completion.test.mjs',
    'tests/phase4/integration/issues-2502-2522-demand-analysis.test.mjs',
    'tests/phase4/issue-3695-pe-import-descriptor-termination.test.mjs',
    'tests/phase4/run.mjs',
    'tests/phase7/ownership/cross-lane-routing.test.mjs',
    'tests/phase7/corpus/fixtures.mjs',
    'tests/phase7/debug/issue-4657-dwarf-pointer-completeness.test.mjs',
    'tests/phase7/helpers/fixtures.mjs',
    'tests/phase7/summary/issue-5851-call-fallback-replacement.test.mjs',
    'tests/phase7/summary/issue-6069-provenance-strict-index.test.mjs',
    'tests/phase7/types/consolidated-source-regressions.test.mjs',
    'tests/phase9/foundation/preflight.test.mjs',
    'tests/phase9/verify/equivalence.test.mjs',
    'tests/semantic-v2/issue-4534-ssa-definition-binding.test.mjs',
    'tests/semantic-v2/issue-5414-5865-ssa-link-budget.test.mjs',
    'tests/semantic-v2/memoryssa-cfg.test.mjs',
    'tools/validation/machine-effects/x86-long64-integer-denominator.mjs',
    'tools/validation/phase12/denominator-inventory.json',
    'tools/validation/phase7/cross-lane-inventory.mjs',
    'tools/validation/stage2/profile-denominators.lock.json',
  ]),
});

function phase8Owned(file, patterns) {
  return patterns.some((pattern) => regexFor(pattern).test(file));
}

export function validateCrossLaneInventory(branch, files, { manifest = loadManifest() } = {}) {
  if (typeof branch !== 'string' || !Object.hasOwn(CROSS_LANE_ROUTES, branch)) {
    throw new TypeError(`no exact Phase 8 cross-lane route for branch ${JSON.stringify(branch)}`);
  }
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string' || file.length === 0)) {
    throw new TypeError('cross-lane changed-file inventory must contain non-empty strings');
  }

  const unique = [...new Set(files)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const owned = unique.filter((file) => phase8Owned(file, manifest.lanes.p8));
  const foreign = unique.filter((file) => !phase8Owned(file, manifest.lanes.p8));
  const allowedForeign = new Set(CROSS_LANE_ROUTES[branch]);
  const unexpected = foreign.filter((file) => !allowedForeign.has(file));
  if (unexpected.length) {
    throw new TypeError(`cross-lane route has unexpected foreign paths: ${unexpected.join(', ')}`);
  }
  if (owned.length === 0) {
    throw new TypeError('cross-lane route has no Phase 8-owned paths');
  }
  return Object.freeze(owned);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!['--branch', '--base-sha', '--head-sha'].includes(token) || values.has(token)) {
      throw new TypeError(`invalid cross-lane argument: ${token}`);
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) throw new TypeError(`missing value for ${token}`);
    values.set(token, value);
    index += 1;
  }
  if (values.size !== 3) throw new TypeError('branch, base SHA, and head SHA are required');
  return values;
}

export function runCli(argv = process.argv.slice(2), { root = ROOT, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const args = parseArguments(argv);
    const inventory = inventoryFromGit(root, args.get('--base-sha'), args.get('--head-sha'));
    const owned = validateCrossLaneInventory(args.get('--branch'), inventory.files);
    stdout.write(`${JSON.stringify(owned)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`phase8 cross-lane inventory: ${error.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = runCli();
