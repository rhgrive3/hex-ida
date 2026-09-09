import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inventoryFromGit,
  loadManifest,
  regexFor,
} from '../phase7-ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LANE = 'codex/lane5-6633-abi-a8b2';
const OBJC_PROTOCOL_LANE = 'fix/objc-protocol-class-properties-3979';
const ANALYSIS_BATCH_LANE = 'fix/analysis-batch-20260907-l62';
const INTEGRATION_BATCH_LANE = 'dev-agent-hardening/integration/issue-batch-20260909';

// This is an exact, short-lived integration route for #6975. The PR carries a
// Phase 7 production-path regression alongside the ABI/Phase 6 owner slice.
// Foreign paths are enumerated so adding an unrelated file cannot silently
// turn this into a general Phase 7 ownership exemption.
export const CROSS_LANE_ROUTES = Object.freeze({
  [LANE]: Object.freeze([
    '.circleci/config.yml',
    'js/targets/abi/registry.js',
    'tests/phase6/abi/issue-6052-riscv-abi-ambiguity.test.mjs',
    'tests/phase6/abi/riscv-psabi.test.mjs',
  ]),
  [OBJC_PROTOCOL_LANE]: Object.freeze([
    '.circleci/config.yml',
    'js/apple/objc-metadata.js',
    'tests/issue-6270-objc-methodlist-cancellation.mjs',
  ]),
  [ANALYSIS_BATCH_LANE]: Object.freeze([
    '.circleci/config.yml',
    'js/ai/ui/hex-context-query-base.js',
    'js/semantics/ir/function.js',
    'tests/semantic-v2/issue-5765-locale-free-serialization.test.mjs',
  ]),
  [INTEGRATION_BATCH_LANE]: Object.freeze([
    '.circleci/config.yml',
    'js/ai/control/runtime-support.js',
    'js/ai/control/turn-executor.js',
    'js/ai/runtime.js',
    'js/ai/tools/registry-core.js',
    'js/ai/tools/storage/observation-store.js',
    'js/binary/macho-source-cache.js',
    'js/diff/runtime.js',
    'js/diff/symmetric-function-set.js',
    'js/diff/symmetric-workspace-runtime.js',
    'js/managed/jvm/parser-core.js',
    'js/platform/plugin-api-core.js',
    'js/workspace.js',
    'tests/ai-control-plane.mjs',
    'tests/diff-platform.mjs',
    'tests/issue-4512-diff-abort-registration-race.mjs',
    'tests/issue-6086-agent-monotonic-clock.mjs',
    'tests/issue-6095-turn-monotonic-clock.mjs',
    'tests/issue-7198-jvm-member-name-grammar.mjs',
    'tests/knowledge-platform.mjs',
    'tests/phase11/jvm/jvm-parser.test.mjs',
    'tests/phase4/binary/issue-5536-source-cache-mutable-input.test.mjs',
    'tests/phase4/integration/issues-2502-2522-demand-analysis.test.mjs',
    'tests/phase4/issue-4510-macho-source-cache-result-ownership.test.mjs',
    'tests/plugin-platform-invocation-lifetime-4511.mjs',
    'tests/project-roundtrip.mjs',
  ]),
});

function phase7Owned(file, patterns) {
  return patterns.some((pattern) => regexFor(pattern).test(file));
}

export function validateCrossLaneInventory(branch, files, { manifest = loadManifest() } = {}) {
  if (typeof branch !== 'string' || !Object.hasOwn(CROSS_LANE_ROUTES, branch)) {
    throw new TypeError(`no exact Phase 7 cross-lane route for branch ${JSON.stringify(branch)}`);
  }
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string' || file.length === 0)) {
    throw new TypeError('cross-lane changed-file inventory must contain non-empty strings');
  }

  const unique = [...new Set(files)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const owned = unique.filter((file) => phase7Owned(file, manifest.lanes.p7));
  const foreign = unique.filter((file) => !phase7Owned(file, manifest.lanes.p7));
  const allowedForeign = new Set(CROSS_LANE_ROUTES[branch]);
  const unexpected = foreign.filter((file) => !allowedForeign.has(file));
  if (unexpected.length) {
    throw new TypeError(`cross-lane route has unexpected foreign paths: ${unexpected.join(', ')}`);
  }
  if (owned.length === 0) {
    throw new TypeError('cross-lane route has no Phase 7-owned paths');
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
    const branch = args.get('--branch');
    const inventory = inventoryFromGit(root, args.get('--base-sha'), args.get('--head-sha'));
    const owned = validateCrossLaneInventory(branch, inventory.files);
    stdout.write(`${JSON.stringify(owned)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`phase7 cross-lane inventory: ${error.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = runCli();
