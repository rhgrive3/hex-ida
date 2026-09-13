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
const MAIN_GATE_BATCH_LANE = 'fix/main-gate-recovery-20260913';
const CONSOLIDATED_OWNER3_LANE = 'consolidated-owner3';

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
  [MAIN_GATE_BATCH_LANE]: Object.freeze([
    '.circleci/config.yml',
    '.github/workflows/phase8-ownership.yml',
    'js/binary/macho-dyld.js',
    'js/semantics/memoryssa/build.js',
    'js/targets/abi/aapcs64-core.js',
    'js/targets/architecture/riscv64/decoded-instruction.js',
    'tests/machine-effects/issue-5566-x86-setssbsy-routing.test.mjs',
    'tests/machine-effects/issue-5999-riscv64-compressed-capability-conflict.test.mjs',
    'tests/machine-effects/issue-6133-x87-trusted-terminal-domain.test.mjs',
    'tests/machine-effects/x86-long64-integer-denominator.test.mjs',
    'tests/machine-effects/a2-denominator-inventory.json',
    'tests/phase11/cil/cil-parser.test.mjs',
    'tests/phase11/dex/dex-class-data-field-index-3729.test.mjs',
    'tests/phase11/dex/dex-validation-1143.test.mjs',
    'tests/phase12/run.mjs',
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
    'tests/phase8/abi/hex-c3-02-boundaries.test.mjs',
    'tests/phase8/corpus/explicit-compiler-abi.test.mjs',
    'tests/phase8/ownership/cross-lane-routing.test.mjs',
    'tests/phase9/foundation/preflight.test.mjs',
    'tests/phase9/verify/equivalence.test.mjs',
    'tests/scpa/native-reference-navigation.test.mjs',
    'tests/scpa/native-retained-async-integration.test.mjs',
    'tests/scpa/native-retained-async.test.mjs',
    'tests/scpa/store-producer.test.mjs',
    'tests/scpa/transform-native.test.mjs',
    'tests/semantic-v2/issue-4534-ssa-definition-binding.test.mjs',
    'tests/semantic-v2/issue-5414-5865-ssa-link-budget.test.mjs',
    'tests/semantic-v2/memoryssa-cfg.test.mjs',
    'tools/validation/machine-effects/x86-long64-integer-denominator.mjs',
    'tools/validation/phase12/denominator-inventory.json',
    'tools/validation/stage2/profile-denominators.lock.json',
    'tools/validation/phase8/cross-lane-inventory.mjs',
    'tools/validation/phase8/decoded-function-adapter.mjs',
    'tools/validation/phase8/decompile-corpus.mjs',
    'tools/validation/phase8/metrics.mjs',
    'tools/validation/phase8/verify.mjs',
  ]),
  // This is an exact, short-lived integration route for the owner3 EP-013
  // consolidation (#8436 + #8487). It carries the Phase 7 analysis/summary
  // fix for #4772 alongside the managed-bridge consumer edits and the
  // Phase 10 dynamic-experiment coercion slice (#4310, #4312, #4313).
  // Foreign paths are enumerated so adding an unrelated file cannot silently
  // turn this into a general Phase 7 ownership exemption.
  [CONSOLIDATED_OWNER3_LANE]: Object.freeze([
    '.circleci/config.yml',
    'js/dynamic/experiments.js',
    'js/managed/shared/bridge-v2.js',
    'js/managed/shared/bridge.js',
    'tests/issue-4772-unknown-call-broad-read.mjs',
    'tests/issue-6249-unknown-target-dedupe.mjs',
    'tests/phase10/issue-4310-compile-experiment-input-coercion.test.mjs',
    'tests/phase10/issue-4312-observed-offset-coercion.test.mjs',
    'tests/phase10/issue-4313-compare-expected-bits-coercion.test.mjs',
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
