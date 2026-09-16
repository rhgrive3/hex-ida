import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CROSS_LANE_ROUTES,
  validateCrossLaneInventory,
} from '../../../tools/validation/phase7/cross-lane-inventory.mjs';

const branch = 'codex/lane5-6633-abi-a8b2';
const phase7Files = [
  'tests/phase7/integration/analysis-query-app-wiring.test.mjs',
  'tests/phase7/integration/analysis-query-production-cutover.test.mjs',
  'tests/phase7/ownership/cross-lane-routing.test.mjs',
  'tools/validation/phase7/cross-lane-inventory.mjs',
];
const foreignFiles = CROSS_LANE_ROUTES[branch];
const inventory = [...phase7Files, ...foreignFiles];

assert.deepEqual(
  validateCrossLaneInventory(branch, inventory),
  [...phase7Files].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  'the exact #6975 route must return only Phase 7-owned files',
);
assert.throws(
  () => validateCrossLaneInventory(branch, [...inventory, 'tests/phase6/elf/unrelated.test.mjs']),
  /unexpected foreign paths/,
  'the route must reject an unlisted foreign path instead of waiving ownership',
);
assert.throws(
  () => validateCrossLaneInventory('codex/lane5-6633-abi-a8b2-similar', inventory),
  /no exact Phase 7 cross-lane route/,
  'a similar branch name must not activate the route',
);
assert.throws(
  () => validateCrossLaneInventory(branch, foreignFiles),
  /no Phase 7-owned paths/,
  'a route without Phase 7 evidence must fail closed',
);

for (const file of ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml']) {
  const workflow = readFileSync(file, 'utf8');
  assert.match(workflow, /codex\/lane5-6633-abi-a8b2/);
  assert.match(workflow, /tools\/validation\/phase7\/cross-lane-inventory\.mjs/);
}

const objcBranch = 'fix/objc-protocol-class-properties-3979';
const objcOwnedFiles = [
  'tests/phase7/metadata/objc-protocol-class-properties-3979.test.mjs',
  'tests/phase7/ownership/cross-lane-routing.test.mjs',
  'tools/validation/phase7/cross-lane-inventory.mjs',
  '.github/workflows/phase7-ownership.yml',
];
const objcForeignFiles = CROSS_LANE_ROUTES[objcBranch];
const objcInventory = [...objcOwnedFiles, ...objcForeignFiles];

for (const file of ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml']) {
  const workflow = readFileSync(file, 'utf8');
  assert.match(workflow, /fix\/objc-protocol-class-properties-3979/);
  assert.match(workflow, /tools\/validation\/phase7\/cross-lane-inventory\.mjs/);
}

assert.deepEqual(
  validateCrossLaneInventory(objcBranch, objcInventory),
  [...objcOwnedFiles].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  'the exact #6817 route must accept its three product files and policy files while returning only Phase 7-owned files',
);
assert.throws(
  () => validateCrossLaneInventory(objcBranch, [...objcInventory, 'tests/phase6/elf/unrelated.test.mjs']),
  /unexpected foreign paths/,
  'the #6817 route must reject an unlisted foreign path instead of waiving ownership',
);
assert.throws(
  () => validateCrossLaneInventory('fix/objc-protocol-class-properties-3979-similar', objcInventory),
  /no exact Phase 7 cross-lane route/,
  'a similar ObjC branch name must not activate the route',
);

const analysisBatchBranch = 'fix/analysis-batch-20260907-l62';
const analysisBatchOwnedFiles = [
  'js/analysis/alias/canonical-address-v2-core.js',
  'js/analysis/types/graph.js',
  'tests/phase7/alias/issue-5802-canonical-root-conflict.test.mjs',
  'tests/phase7/integration/issue-5800-search-unsupported-region-completeness.test.mjs',
  'tests/phase7/ownership/cross-lane-routing.test.mjs',
  'tests/phase7/types/issue-5781-type-entity-identity.test.mjs',
  'tools/validation/phase7/cross-lane-inventory.mjs',
  '.github/workflows/phase7-ownership.yml',
];
const analysisBatchForeignFiles = CROSS_LANE_ROUTES[analysisBatchBranch];
assert.deepEqual(
  [...analysisBatchForeignFiles],
  [
    '.circleci/config.yml',
    'js/ai/ui/hex-context-query-base.js',
    'js/semantics/ir/function.js',
    'tests/semantic-v2/issue-5765-locale-free-serialization.test.mjs',
  ],
  'the #7079 foreign allowlist must remain the exact four-file contract',
);
const analysisBatchInventory = [...analysisBatchOwnedFiles, ...analysisBatchForeignFiles];
assert.deepEqual(
  validateCrossLaneInventory(analysisBatchBranch, analysisBatchInventory),
  [...analysisBatchOwnedFiles].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  'the exact #7079 route must return only Phase 7-owned files',
);
assert.throws(
  () => validateCrossLaneInventory(analysisBatchBranch, [...analysisBatchInventory, 'js/semantics/ir/nodes.js']),
  /unexpected foreign paths/,
  'the #7079 route must reject a frozen semantic IR path outside its exact allowlist',
);
assert.throws(
  () => validateCrossLaneInventory('fix/analysis-batch-20260907-l62-similar', analysisBatchInventory),
  /no exact Phase 7 cross-lane route/,
  'a similar analysis batch branch name must not activate the route',
);

for (const file of ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml']) {
  const workflow = readFileSync(file, 'utf8');
  assert.match(workflow, /fix\/analysis-batch-20260907-l62/);
  assert.match(workflow, /tools\/validation\/phase7\/cross-lane-inventory\.mjs/);
}

const integrationBatchBranch = 'dev-agent-hardening/integration/issue-batch-20260909';
const integrationBatchOwnedFiles = [
  '.github/workflows/phase7-ownership.yml',
  'js/analysis/summary/local-core.js',
  'js/analysis/types/graph.js',
  'js/knowledge/index.js',
  'tests/phase7/issue-5719-schema-recovery-strings-progress.mjs',
  'tests/phase7/summary/issue-6151-structured-call-arguments.test.mjs',
  'tests/phase7/types/issue-4503-structural-array-claims.test.mjs',
  'tests/phase7/ownership/cross-lane-routing.test.mjs',
  'tools/validation/phase7/cross-lane-inventory.mjs',
  'userscript/hex.user.template.js',
  'userscript/release-version.json',
];
const integrationBatchForeignFiles = CROSS_LANE_ROUTES[integrationBatchBranch];
assert.deepEqual(
  [...integrationBatchForeignFiles],
  [
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
  ],
  'the #7535 route must enumerate the exact seven-component foreign union plus CircleCI config',
);
const integrationBatchInventory = [...integrationBatchOwnedFiles, ...integrationBatchForeignFiles];
assert.deepEqual(
  validateCrossLaneInventory(integrationBatchBranch, integrationBatchInventory),
  [...integrationBatchOwnedFiles].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  'the #7535 route must return only the Phase 7-owned subset',
);
assert.throws(
  () => validateCrossLaneInventory(integrationBatchBranch, [...integrationBatchInventory, 'js/ui/unrelated.js']),
  /unexpected foreign paths/,
  'the #7535 route must reject an unknown foreign path',
);
assert.throws(
  () => validateCrossLaneInventory(integrationBatchBranch, [...integrationBatchInventory, 'js/semantics/ir/nodes.js']),
  /unexpected foreign paths/,
  'the #7535 route must reject a forbidden semantic IR path',
);
assert.throws(
  () => validateCrossLaneInventory(`${integrationBatchBranch}-similar`, integrationBatchInventory),
  /no exact Phase 7 cross-lane route/,
  'a similar integration branch name must not activate the route',
);
assert.throws(
  () => validateCrossLaneInventory(integrationBatchBranch, integrationBatchForeignFiles),
  /no Phase 7-owned paths/,
  'the #7535 route must fail closed when no Phase 7 evidence is present',
);

function routeBlock(workflow, startMarker, endMarker) {
  const start = workflow.indexOf(startMarker);
  assert.ok(start >= 0, `workflow must contain exact route marker ${startMarker}`);
  const end = workflow.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `workflow route ${startMarker} must end at the next case`);
  return workflow.slice(start, end);
}

const circleciWorkflow = readFileSync('.circleci/config.yml', 'utf8');
const circleciIntegrationRoute = routeBlock(
  circleciWorkflow,
  `              ${integrationBatchBranch})`,
  '              *)',
);
assert.ok(circleciIntegrationRoute.includes('node tools/validation/phase7/cross-lane-inventory.mjs'));
assert.ok(circleciIntegrationRoute.includes('--branch "$CIRCLE_BRANCH"'));
assert.ok(circleciIntegrationRoute.includes('node tools/validation/phase7-ownership.mjs --files-json "$FILES_JSON"'));
assert.ok(
  circleciIntegrationRoute.indexOf('cross-lane-inventory.mjs')
    < circleciIntegrationRoute.indexOf('phase7-ownership.mjs --files-json'),
  'CircleCI must derive the subset with the cross-lane helper before validating it',
);

const githubWorkflow = readFileSync('.github/workflows/phase7-ownership.yml', 'utf8');
const githubIntegrationRoute = routeBlock(
  githubWorkflow,
  `          elif [[ "$HEAD_REF" == "${integrationBatchBranch}" ]]; then`,
  '          elif [[',
);
assert.ok(githubIntegrationRoute.includes('node tools/validation/phase7/cross-lane-inventory.mjs'));
assert.ok(githubIntegrationRoute.includes('--branch "$HEAD_REF"'));
assert.ok(githubIntegrationRoute.includes('node tools/validation/phase7-ownership.mjs --files-json "$FILES_JSON"'));
assert.ok(
  githubIntegrationRoute.indexOf('cross-lane-inventory.mjs')
    < githubIntegrationRoute.indexOf('phase7-ownership.mjs --files-json'),
  'GitHub manual fallback must derive the subset with the cross-lane helper before validating it',
);

const mainGateBranch = 'fix/main-gate-recovery-20260913';
const mainGateOwnedFiles = [
  '.github/workflows/phase7-ownership.yml',
  'js/analysis/debug/dwarf.js',
  'tests/phase7/corpus/fixtures.mjs',
  'tests/phase7/debug/issue-4657-dwarf-pointer-completeness.test.mjs',
  'tests/phase7/helpers/fixtures.mjs',
  'tests/phase7/summary/issue-5851-call-fallback-replacement.test.mjs',
  'tests/phase7/summary/issue-6069-provenance-strict-index.test.mjs',
  'tests/phase7/types/consolidated-source-regressions.test.mjs',
  'tests/phase7/ownership/cross-lane-routing.test.mjs',
  'tools/validation/phase7/cross-lane-inventory.mjs',
  'userscript/hex.user.template.js',
  'userscript/release-version.json',
];
const mainGateInventory = [...mainGateOwnedFiles, ...CROSS_LANE_ROUTES[mainGateBranch]];
assert.deepEqual(
  validateCrossLaneInventory(mainGateBranch, mainGateInventory),
  [...mainGateOwnedFiles].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  'the exact gate-repair route must return only Phase 7-owned files',
);
assert.throws(
  () => validateCrossLaneInventory(mainGateBranch, [...mainGateInventory, 'js/semantics/ir/nodes.js']),
  /unexpected foreign paths/,
  'the gate-repair route must reject an unlisted foreign path',
);
assert.throws(
  () => validateCrossLaneInventory(`${mainGateBranch}-similar`, mainGateInventory),
  /no exact Phase 7 cross-lane route/,
  'a similar gate-repair branch name must not activate the route',
);
assert.throws(
  () => validateCrossLaneInventory(mainGateBranch, CROSS_LANE_ROUTES[mainGateBranch]),
  /no Phase 7-owned paths/,
  'the gate-repair route must fail closed without Phase 7 evidence',
);

const mainGateCircleciRoute = routeBlock(
  circleciWorkflow,
  `              ${mainGateBranch})`,
  '              *)',
);
assert.ok(mainGateCircleciRoute.includes('node tools/validation/phase7/cross-lane-inventory.mjs'));
assert.ok(mainGateCircleciRoute.includes('--branch "$CIRCLE_BRANCH"'));
assert.ok(mainGateCircleciRoute.includes('node tools/validation/phase7-ownership.mjs --files-json "$FILES_JSON"'));
assert.ok(
  mainGateCircleciRoute.indexOf('cross-lane-inventory.mjs')
    < mainGateCircleciRoute.indexOf('phase7-ownership.mjs --files-json'),
  'CircleCI must validate the exact gate-repair subset after routing it',
);

const mainGateGithubRoute = routeBlock(
  githubWorkflow,
  `          elif [[ "$HEAD_REF" == "${mainGateBranch}" ]]; then`,
  '          elif [[',
);
assert.ok(mainGateGithubRoute.includes('node tools/validation/phase7/cross-lane-inventory.mjs'));
assert.ok(mainGateGithubRoute.includes('--branch "$HEAD_REF"'));
assert.ok(mainGateGithubRoute.includes('node tools/validation/phase7-ownership.mjs --files-json "$FILES_JSON"'));
assert.ok(
  mainGateGithubRoute.indexOf('cross-lane-inventory.mjs')
    < mainGateGithubRoute.indexOf('phase7-ownership.mjs --files-json'),
  'GitHub manual fallback must validate the exact gate-repair subset after routing it',
);

const consolidatedOwner3Branch = 'consolidated-owner3';
const consolidatedOwner3OwnedFiles = [
  '.github/workflows/phase7-ownership.yml',
  'js/analysis/summary/contract-core.js',
  'js/analysis/summary/interprocedural.js',
  'js/analysis/summary/local-core.js',
  'tests/phase7/corpus/summaries.mjs',
  'tests/phase7/ownership/cross-lane-routing.test.mjs',
  'tests/phase7/summary/contract.test.mjs',
  'tests/phase7/summary/interprocedural.test.mjs',
  'tests/phase7/summary/issue-4064-overlapping-memory-effects.test.mjs',
  'tests/phase7/summary/issue-4772-unknown-call-broad-read.test.mjs',
  'tests/phase7/summary/issue-5346-exhaustive-indirect-candidates.test.mjs',
  'tests/phase7/summary/issue-5752-intrinsic-scope-completeness.test.mjs',
  'tools/validation/phase7/cross-lane-inventory.mjs',
];
const consolidatedOwner3ForeignFiles = CROSS_LANE_ROUTES[consolidatedOwner3Branch];
assert.deepEqual(
  [...consolidatedOwner3ForeignFiles],
  [
    '.circleci/config.yml',
    'js/dynamic/experiments.js',
    'js/managed/shared/bridge-v2.js',
    'js/managed/shared/bridge.js',
    'tests/issue-4772-unknown-call-broad-read.mjs',
    'tests/issue-6249-unknown-target-dedupe.mjs',
    'tests/phase10/issue-4310-compile-experiment-input-coercion.test.mjs',
    'tests/phase10/issue-4312-observed-offset-coercion.test.mjs',
    'tests/phase10/issue-4313-compare-expected-bits-coercion.test.mjs',
  ],
);
const consolidatedOwner3Inventory = [...consolidatedOwner3OwnedFiles, ...consolidatedOwner3ForeignFiles];
assert.deepEqual(
  validateCrossLaneInventory(consolidatedOwner3Branch, consolidatedOwner3Inventory),
  [...consolidatedOwner3OwnedFiles].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
);
assert.throws(
  () => validateCrossLaneInventory(consolidatedOwner3Branch, [...consolidatedOwner3Inventory, 'js/semantics/ir/nodes.js']),
  /unexpected foreign paths/,
);
assert.throws(
  () => validateCrossLaneInventory(`${consolidatedOwner3Branch}-suffix`, consolidatedOwner3Inventory),
  /no exact Phase 7 cross-lane route/,
);
assert.throws(
  () => validateCrossLaneInventory(consolidatedOwner3Branch, consolidatedOwner3ForeignFiles),
  /no Phase 7-owned paths/,
);
for (const file of ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml']) {
  const workflow = readFileSync(file, 'utf8');
  assert.ok(workflow.includes(consolidatedOwner3Branch));
  assert.ok(workflow.includes('tools/validation/phase7/cross-lane-inventory.mjs'));
}

console.log('phase7 cross-lane ownership routing: PASS');


const actionsGroupBranch = "dependabot/github_actions/github-actions-436ea2ae3a";
const actionsGroupOwned = [
  '.github/workflows/phase7-ownership.yml',
  '.github/workflows/phase7-release-validation.yml',
  'tests/phase7/ownership/cross-lane-routing.test.mjs',
  'tools/validation/phase7/cross-lane-inventory.mjs',
];
const actionsGroupInventory = [...actionsGroupOwned, ...CROSS_LANE_ROUTES[actionsGroupBranch]];
assert.deepEqual(
  validateCrossLaneInventory(actionsGroupBranch, actionsGroupInventory),
  [...actionsGroupOwned].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))),
  'Dependabot workflow group returns only the exact Phase 7-owned subset',
);
assert.throws(
  () => validateCrossLaneInventory(actionsGroupBranch, [...actionsGroupInventory, 'js/ui/unrelated.js']),
  /unexpected foreign paths|outside-lane|forbidden/,
  'Dependabot workflow route must reject undeclared expansion',
);
for (const file of ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml']) {
  const workflow = readFileSync(file, 'utf8');
  assert.ok(workflow.includes(actionsGroupBranch));
}


const pr8519Branch = "fix/batch-3-5621-5900-8428-8366-7689";
const pr8519Inventory = [
  "js/analysis/query/scoped-app.js",
  "js/binary/elf-core.js",
  "js/binary/elf-dynamic.js",
  "js/managed/cil/frontend.js",
  "js/managed/cil/metadata-definitions.js",
  "js/managed/cil/metadata-manifest-security.js",
  "js/managed/cil/parser-base.js",
  "js/managed/cil/parser-overlay.js",
  "js/script.js",
  "js/targets/abi/aapcs64-core.js",
  "js/targets/abi/aapcs64.js",
  "js/targets/abi/index.js",
  "js/targets/abi/registry.js",
  "js/targets/abi/riscv-lp64.js",
  "js/tools-base.js",
  "package.json",
  "tests/issue-5900-findstrings-cancellation.test.mjs",
  "tests/issues-explorer-script-optimizations-2627-2629.mjs",
  "tests/phase-runner-contract.mjs",
  "tests/phase11/cil/cil-module-identity-7689.test.mjs",
  "tests/phase11/cil/issue-4145-valid-mask-reserved-bits.test.mjs",
  "tests/phase11/cil/issue-7578-typeref-assemblyref-identity.test.mjs",
  "tests/phase6/abi/aapcs64-scalar-provenance.test.mjs",
  "tests/phase6/abi/issue-5598-aapcs64-hfa-whole-aggregate-stack.test.mjs",
  "tests/phase6/abi/issue-5621-riscv-stack-aggregate-alignment.test.mjs",
  "tests/phase6/abi/issue-6012-aapcs64-pointer-heuristic-token-boundary.test.mjs",
  "tests/phase6/abi/issue-8366-aarch64-variant-pcs.test.mjs",
  "tests/phase6/abi/issue-8428-aarch64-ilp32.test.mjs",
  "tests/scpa/abi-candidates.test.mjs",
  "tests/scpa/abi-range-host.test.mjs",
  "tools/validation/phase7/cross-lane-inventory.mjs",
  "tests/phase7/ownership/cross-lane-routing.test.mjs",
  ".github/workflows/phase7-ownership.yml",
  ".circleci/config.yml"
];
const pr8519Owned = validateCrossLaneInventory(pr8519Branch, pr8519Inventory);
assert.ok(pr8519Owned.length > 0, 'PR #8519 exact route must retain Phase 7-owned evidence');
assert.throws(
  () => validateCrossLaneInventory(pr8519Branch, [...pr8519Inventory, 'js/ui/__undeclared_pr_8519.js']),
  /unexpected foreign paths/,
  'PR #8519 route must reject an undeclared foreign path',
);
assert.throws(
  () => validateCrossLaneInventory(`${pr8519Branch}-similar`, pr8519Inventory),
  /no exact Phase 7 cross-lane route/,
  'PR #8519 route must be branch-exact',
);
for (const file of ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml']) {
  const workflow = readFileSync(file, 'utf8');
  assert.ok(workflow.includes(pr8519Branch), 'PR #8519 workflow route must be wired');
}


const pr8510Branch = "fix/batch-4126-owner8";
const pr8510Inventory = [
  "js/backend.js",
  "tests/phase7/issue-4179-macho-asm-search-arch-routing.test.mjs",
  "tests/phase7/issue-4235-macho-function-discovery-arch-routing.test.mjs",
  "tools/validation/phase7/cross-lane-inventory.mjs",
  "tests/phase7/ownership/cross-lane-routing.test.mjs",
  ".github/workflows/phase7-ownership.yml",
  ".circleci/config.yml"
];
const pr8510Owned = validateCrossLaneInventory(pr8510Branch, pr8510Inventory);
assert.ok(pr8510Owned.length > 0, 'PR #8510 exact route must retain Phase 7-owned evidence');
assert.throws(
  () => validateCrossLaneInventory(pr8510Branch, [...pr8510Inventory, 'js/ui/__undeclared_pr_8510.js']),
  /unexpected foreign paths/,
  'PR #8510 route must reject an undeclared foreign path',
);
assert.throws(
  () => validateCrossLaneInventory(`${pr8510Branch}-similar`, pr8510Inventory),
  /no exact Phase 7 cross-lane route/,
  'PR #8510 route must be branch-exact',
);
for (const file of ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml']) {
  const workflow = readFileSync(file, 'utf8');
  assert.ok(workflow.includes(pr8510Branch), 'PR #8510 workflow route must be wired');
}


const pr8420Branch = "batch-20260912-owner4";
const pr8420Inventory = [
  "js/adapters/index.js",
  "js/ai/budget/wire.js",
  "js/ai/control/turn-executor.js",
  "js/managed/wasm/parser-core.js",
  "js/metadata/go.js",
  "js/metadata/objc.js",
  "js/metadata/rust.js",
  "js/metadata/swift.js",
  "js/symbolic/verify/global-reachability.js",
  "js/userscript/chatgpt-sandbox-host.js",
  "js/userscript/dev/single-tab/single-conversation-worker-coordinator.js",
  "js/userscript/dev/skills/dom-skill-registry.js",
  "js/userscript/embed-bootstrap.js",
  "js/userscript/embed-child.js",
  "tests/dev-agent/round2-browser.mjs",
  "tests/dev-agent/supervisor-conversation-continuity.mjs",
  "tests/issue-4688-remote-connect-disconnect-race.mjs",
  "tests/issue-4846-provider-identity-binding-authority.mjs",
  "tests/issue-4870-structured-handshake-identity.mjs",
  "tests/issue-4912-global-reachability-path-set.mjs",
  "tests/issue-4944-wasm-memory64-limits.mjs",
  "tests/issue-5055-single-tab-claim-identity.mjs",
  "tests/issue-5098-turn-capability-authority.mjs",
  "tests/issue-5182-validate-candidate-stale-writeback.mjs",
  "tests/issues-unlinked-batch-20260901.mjs",
  "tests/metadata-provider-contract.test.mjs",
  "tests/phase11/wasm/issue-3829-wasm-shared-memory-limits.test.mjs",
  "tests/phase11/wasm/issue-4944-wasm-memory64-limits.test.mjs",
  "tests/phase11/wasm/wasm-shared-table-profile-7614.test.mjs",
  "tests/phase12/adversarial/issue-4870-structured-handshake-identity.test.mjs",
  "tests/phase12/adversarial/issue-5182-validate-candidate-stale-writeback.test.mjs",
  "tests/phase7/metadata/rust-legacy-trailing-bytes-3703.test.mjs",
  "tests/userscript-dev-worker-runtime.mjs",
  "tools/validation/phase7/cross-lane-inventory.mjs",
  "tests/phase7/ownership/cross-lane-routing.test.mjs",
  ".github/workflows/phase7-ownership.yml",
  ".circleci/config.yml"
];
const pr8420Owned = validateCrossLaneInventory(pr8420Branch, pr8420Inventory);
assert.ok(pr8420Owned.length > 0, 'PR #8420 exact route must retain Phase 7-owned evidence');
assert.throws(
  () => validateCrossLaneInventory(pr8420Branch, [...pr8420Inventory, 'js/ui/__undeclared_pr_8420.js']),
  /unexpected foreign paths/,
  'PR #8420 route must reject an undeclared foreign path',
);
assert.throws(
  () => validateCrossLaneInventory(`${pr8420Branch}-similar`, pr8420Inventory),
  /no exact Phase 7 cross-lane route/,
  'PR #8420 route must be branch-exact',
);
for (const file of ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml']) {
  const workflow = readFileSync(file, 'utf8');
  assert.ok(workflow.includes(pr8420Branch), 'PR #8420 workflow route must be wired');
}


const pr8419Branch = "batch-20260912-owner6";
const pr8419Inventory = [
  "js/ai/budget/wire.js",
  "js/ai/control/tool-window.js",
  "js/ai/control/turn-executor.js",
  "js/ai/provider/worker-adapters.js",
  "js/ai/provider/worker-protocol.js",
  "js/ai/provider/worker-turn.js",
  "js/ai/session-core/index.js",
  "js/analysis/discovery/fusion.js",
  "js/collaboration/remote-authority.js",
  "js/collaboration/remote-transport.js",
  "js/diff/symmetric-workspace-runtime.js",
  "js/managed/shared/bridge-v2.js",
  "js/managed/shared/bridge-wasm-select-overlay-v2.js",
  "js/project/index.js",
  "js/symbolic/evidence/symbolic-evidence.js",
  "js/userscript/embed-protocol.js",
  "js/workspace.js",
  "package.json",
  "tests/issue-4591-provider-tool-limit.mjs",
  "tests/issue-4663-symbolic-evidence-scope-metadata.mjs",
  "tests/issue-4818-hexproj-annotation-address-coercion.mjs",
  "tests/issue-4964-raw-binary-egress-classification.mjs",
  "tests/issue-5023-embed-error-details-accessor.mjs",
  "tests/issue-5105-discovery-cap-cardinality.test.mjs",
  "tests/issue-5124-symmetric-diff-consumer-cancel.mjs",
  "tests/issue-5138-authoritative-partial-not-exact-extent.mjs",
  "tests/issue-5556-session-save-ordering.test.mjs",
  "tests/issue-5558-discovery-budget-dedupe.test.mjs",
  "tests/phase-runner-contract.mjs",
  "tests/phase11/wasm/issue-4843-wasm-select-semantic-kind.test.mjs",
  "tests/phase12/adversarial/issue-4564-semantic-token-budget.test.mjs",
  "tests/phase12/adversarial/issue-4586-session-memory-concurrency.test.mjs",
  "tests/phase12/adversarial/issue-4591-provider-tool-limit.test.mjs",
  "tests/phase12/adversarial/issue-5023-embed-error-details-accessor.test.mjs",
  "tests/phase12/collaboration/remote-shared-memory-ingress.test.mjs",
  "tests/phase12/integration/issue-4079-ai-worker-single-tool-call.test.mjs",
  "tests/phase7/discovery/fusion.test.mjs",
  "tests/phase7/discovery/issue-5105-discovery-cap-cardinality.test.mjs",
  "tools/validation/phase7/cross-lane-inventory.mjs",
  "tests/phase7/ownership/cross-lane-routing.test.mjs",
  ".github/workflows/phase7-ownership.yml",
  ".circleci/config.yml"
];
const pr8419Owned = validateCrossLaneInventory(pr8419Branch, pr8419Inventory);
assert.ok(pr8419Owned.length > 0, 'PR #8419 exact route must retain Phase 7-owned evidence');
assert.throws(
  () => validateCrossLaneInventory(pr8419Branch, [...pr8419Inventory, 'js/ui/__undeclared_pr_8419.js']),
  /unexpected foreign paths/,
  'PR #8419 route must reject an undeclared foreign path',
);
assert.throws(
  () => validateCrossLaneInventory(`${pr8419Branch}-similar`, pr8419Inventory),
  /no exact Phase 7 cross-lane route/,
  'PR #8419 route must be branch-exact',
);
for (const file of ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml']) {
  const workflow = readFileSync(file, 'utf8');
  assert.ok(workflow.includes(pr8419Branch), 'PR #8419 workflow route must be wired');
}


const pr8418Branch = "batch-20260912-owner8";
const pr8418Inventory = [
  "js/ai/ui/hex-context-legacy.js",
  "js/analysis/query/app-adapter.js",
  "js/analyze.js",
  "js/app.js",
  "js/panels-base.js",
  "js/rebuild/index.js",
  "js/rebuild/transaction-v2.js",
  "js/recognition/matcher.js",
  "js/semantic-evidence.js",
  "js/semantics/ir/common.js",
  "js/userscript/chatgpt-bridge.js",
  "js/userscript/chatgpt-iframe-host.js",
  "js/userscript/chatgpt-sandbox-host.js",
  "js/userscript/embed-protocol.js",
  "tests/issue-4651-runtime-identity-canonical.mjs",
  "tests/issue-4831-aggregate-match-ambiguity.mjs",
  "tests/issue-4840-semantic-ir-budget-zero.mjs",
  "tests/issue-4861-timeout-number-coercion.mjs",
  "tests/issue-4973-arm64-32-pointer-width.mjs",
  "tests/issue-4980-legacy-rebuild-plan-array-byte-validation.mjs",
  "tests/issue-5186-atomic-publication-trusted-provider.test.mjs",
  "tests/issue-5438-versioned-apple-framework-paths.mjs",
  "tests/phase12/rebuild/f6-macho-layout-cell.test.mjs",
  "tests/phase12/rebuild/f6-pe-layout-cell.test.mjs",
  "tests/phase12/rebuild/f6-real-fixtures.test.mjs",
  "tests/stage2/issue-4970-phase12-rebuild-format-denominator.test.mjs",
  "tools/validation/phase7/cross-lane-inventory.mjs",
  "tests/phase7/ownership/cross-lane-routing.test.mjs",
  ".github/workflows/phase7-ownership.yml",
  ".circleci/config.yml"
];
const pr8418Owned = validateCrossLaneInventory(pr8418Branch, pr8418Inventory);
assert.ok(pr8418Owned.length > 0, 'PR #8418 exact route must retain Phase 7-owned evidence');
assert.throws(
  () => validateCrossLaneInventory(pr8418Branch, [...pr8418Inventory, 'js/ui/__undeclared_pr_8418.js']),
  /unexpected foreign paths/,
  'PR #8418 route must reject an undeclared foreign path',
);
assert.throws(
  () => validateCrossLaneInventory(`${pr8418Branch}-similar`, pr8418Inventory),
  /no exact Phase 7 cross-lane route/,
  'PR #8418 route must be branch-exact',
);
for (const file of ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml']) {
  const workflow = readFileSync(file, 'utf8');
  assert.ok(workflow.includes(pr8418Branch), 'PR #8418 workflow route must be wired');
}


const pr8417Branch = "batch-20260912-owner5";
const pr8417Inventory = [
  "js/ai/capabilities/catalog.js",
  "js/ai/dev/supervisor/dev-supervisor-engine-v0.js",
  "js/analysis/types/constraints.js",
  "js/binary/fingerprint.js",
  "js/binary/macho-core.js",
  "js/goals.js",
  "js/managed/jvm/lifter-core.js",
  "js/semantics/ir/from-machine-effects.js",
  "js/semantics/ssa/build.js",
  "js/userscript/dev/parent-worker-runtime.js",
  "package.json",
  "tests/dev-agent/supervisor-tool-error-recovery.mjs",
  "tests/issue-4624-ambiguous-claim-explicit-release-double-release.mjs",
  "tests/issue-4637-parse-goal-avoid-preset.mjs",
  "tests/issue-4672-fingerprint-range-union.mjs",
  "tests/issue-4893-jvm-pop2-category-consume.mjs",
  "tests/issue-4994-macho-crypt-range.mjs",
  "tests/issue-5090-parent-runtime-init-rollback.mjs",
  "tests/issue-5104-capability-catalog-runtime-availability.mjs",
  "tests/issue-5239-function-level-state-unknown-ssa.mjs",
  "tests/phase4/binary/issue-4672-fingerprint-range-union.test.mjs",
  "tests/phase4/binary/issue-4994-macho-crypt-range.test.mjs",
  "tests/phase4/binary/issue-4994-macho-encryption-info.test.mjs",
  "tests/phase7/types/issue-4705-soft-evidence-weight-type-authority.test.mjs",
  "tests/scpa/native-flow-ports.test.mjs",
  "tests/semantic-v2/ssa-build.test.mjs",
  "tools/validation/phase7/cross-lane-inventory.mjs",
  "tests/phase7/ownership/cross-lane-routing.test.mjs",
  ".github/workflows/phase7-ownership.yml",
  ".circleci/config.yml"
];
const pr8417Owned = validateCrossLaneInventory(pr8417Branch, pr8417Inventory);
assert.ok(pr8417Owned.length > 0, 'PR #8417 exact route must retain Phase 7-owned evidence');
assert.throws(
  () => validateCrossLaneInventory(pr8417Branch, [...pr8417Inventory, 'js/ui/__undeclared_pr_8417.js']),
  /unexpected foreign paths/,
  'PR #8417 route must reject an undeclared foreign path',
);
assert.throws(
  () => validateCrossLaneInventory(`${pr8417Branch}-similar`, pr8417Inventory),
  /no exact Phase 7 cross-lane route/,
  'PR #8417 route must be branch-exact',
);
for (const file of ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml']) {
  const workflow = readFileSync(file, 'utf8');
  assert.ok(workflow.includes(pr8417Branch), 'PR #8417 workflow route must be wired');
}


const pr8415Branch = "batch-20260912-owner3";
const pr8415Inventory = [
  "js/adapters/index.js",
  "js/ai/dev/supervisor/dev-supervisor-progress-budget.js",
  "js/analysis/discovery/fusion.js",
  "js/app.js",
  "js/collaboration/remote-authority.js",
  "js/emu.js",
  "js/managed/wasm/lifter-core.js",
  "js/symbolic/translate/semantic-ir.js",
  "js/trace/ring-buffer.js",
  "js/viewer.js",
  "package.json",
  "tests/issue-4614-progress-budget-repeated-observation.mjs",
  "tests/issue-4692-semantic-ir-constant-canonical.mjs",
  "tests/issue-4701-emu-memory-size-coercion.mjs",
  "tests/issue-4894-wasm-if-without-else-implicit-else.mjs",
  "tests/issue-4955-transport-verifier-oracle-binding.mjs",
  "tests/issue-4981-trace-ring-buffer-binary-bytes.mjs",
  "tests/issue-5019-viewer-bigint-row-identity.mjs",
  "tests/issue-5148-fusion-cancel-build.test.mjs",
  "tests/phase10/debugger/issue-4909-local-evaluate-expression-type.test.mjs",
  "tests/stage2/capability-promotion.test.mjs",
  "tests/stage2/remote-collaboration.test.mjs",
  "tools/validation/phase7/cross-lane-inventory.mjs",
  "tests/phase7/ownership/cross-lane-routing.test.mjs",
  ".github/workflows/phase7-ownership.yml",
  ".circleci/config.yml"
];
const pr8415Owned = validateCrossLaneInventory(pr8415Branch, pr8415Inventory);
assert.ok(pr8415Owned.length > 0, 'PR #8415 exact route must retain Phase 7-owned evidence');
assert.throws(
  () => validateCrossLaneInventory(pr8415Branch, [...pr8415Inventory, 'js/ui/__undeclared_pr_8415.js']),
  /unexpected foreign paths/,
  'PR #8415 route must reject an undeclared foreign path',
);
assert.throws(
  () => validateCrossLaneInventory(`${pr8415Branch}-similar`, pr8415Inventory),
  /no exact Phase 7 cross-lane route/,
  'PR #8415 route must be branch-exact',
);
for (const file of ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml']) {
  const workflow = readFileSync(file, 'utf8');
  assert.ok(workflow.includes(pr8415Branch), 'PR #8415 workflow route must be wired');
}


const pr8414Branch = "batch-20260912-owner2";
const pr8414Inventory = [
  "js/adapters/index.js",
  "js/ai/control/scope.js",
  "js/ai/tools/registry-core.js",
  "js/ai/ui/bridge.js",
  "js/analysis/alias/legacy-safety-floor.js",
  "js/analysis/alias/regions-v2.js",
  "js/apple/objc-runtime.js",
  "js/auto.js",
  "js/binary/pe.js",
  "js/core/identity/index.js",
  "js/diff/compact-function-set.js",
  "js/linkage.js",
  "js/managed/jvm/parser-core.js",
  "js/managed/wasm/parser-core.js",
  "js/managed/wasm/parser.js",
  "js/rebuild/format-safe.js",
  "js/semantics/memoryssa/contract.js",
  "js/symbolic/expr/factory.js",
  "js/symbolic/verify/preconditions.js",
  "tests/issue-4638-compact-snapshot-mutation-isolation.mjs",
  "tests/issue-4666-unknown-semantic-detail-deep-freeze.mjs",
  "tests/issue-4677-standalone-provider-capabilities.mjs",
  "tests/issue-4698-step-into-after-pause.mjs",
  "tests/issue-4823-linkage-budget-coercion.mjs",
  "tests/issue-4860-jvm-super-class-zero-invariant.mjs",
  "tests/issue-4908-precondition-sat-missing-model.mjs",
  "tests/issue-4978-objc-class-metadata-dispatch.mjs",
  "tests/issue-5000-memory-origins-budget-strict.mjs",
  "tests/issue-5001-macho-segment-vm-range.mjs",
  "tests/issue-5045-wasm-element-expr-vector-forms.mjs",
  "tests/issue-5109-pinpoint-cancel-unexamined.mjs",
  "tests/issue-5126-functions-address-array-scope.mjs",
  "tests/issue-5164-root-identity-lossy-collision.mjs",
  "tests/phase10/debugger/issue-4698-step-into-after-pause.test.mjs",
  "tests/phase11/jvm/jvm-class-version-3903.test.mjs",
  "tests/phase11/jvm/jvm-code-attribute-cardinality-3902.test.mjs",
  "tests/phase11/jvm/jvm-exception-table-range-3860.test.mjs",
  "tests/phase11/jvm/jvm-local-frame-boundary-5394.test.mjs",
  "tests/phase11/jvm/jvm-parser.test.mjs",
  "tests/phase11/jvm/jvm-type-opcode-stack-5243.test.mjs",
  "tests/phase12/adversarial/issue-5126-functions-address-array-scope.test.mjs",
  "tests/phase4/binary/issue-4281-pe-section-virtual-address-alignment.test.mjs",
  "tests/phase7/alias/issue-5000-memory-origins-budget-strict.test.mjs",
  "tests/phase7/alias/issue-5164-root-identity-lossy-collision.test.mjs",
  "tools/validation/phase7/cross-lane-inventory.mjs",
  "tests/phase7/ownership/cross-lane-routing.test.mjs",
  ".github/workflows/phase7-ownership.yml",
  ".circleci/config.yml"
];
const pr8414Owned = validateCrossLaneInventory(pr8414Branch, pr8414Inventory);
assert.ok(pr8414Owned.length > 0, 'PR #8414 exact route must retain Phase 7-owned evidence');
assert.throws(
  () => validateCrossLaneInventory(pr8414Branch, [...pr8414Inventory, 'js/ui/__undeclared_pr_8414.js']),
  /unexpected foreign paths/,
  'PR #8414 route must reject an undeclared foreign path',
);
assert.throws(
  () => validateCrossLaneInventory(`${pr8414Branch}-similar`, pr8414Inventory),
  /no exact Phase 7 cross-lane route/,
  'PR #8414 route must be branch-exact',
);
for (const file of ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml']) {
  const workflow = readFileSync(file, 'utf8');
  assert.ok(workflow.includes(pr8414Branch), 'PR #8414 workflow route must be wired');
}


const analysisQueryBranch = 'fix/batch-4075-owner12';
const analysisQueryOwnedFiles = [
  'js/analysis/query/app-adapter.js',
  'js/app.js',
  'tests/phase7/analysis-query/issue-4185-query-presentation-selection-guard.test.mjs',
  'tests/phase7/integration/issue-4075-instructions-short-read-completeness.test.mjs',
  'tests/phase7/issue-4185-late-analysis-presentation-race.test.mjs',
  'tests/phase7/ownership/cross-lane-routing.test.mjs',
  'tools/validation/phase7/cross-lane-inventory.mjs',
  '.github/workflows/phase7-ownership.yml',
];
const analysisQueryForeignFiles = CROSS_LANE_ROUTES[analysisQueryBranch];
assert.deepEqual(
  [...analysisQueryForeignFiles],
  ['.circleci/config.yml', 'js/backend.js'],
  '#8536 must allow only its exact foreign Backend integration surface plus CircleCI routing',
);
const analysisQueryInventory = [...analysisQueryOwnedFiles, ...analysisQueryForeignFiles];
assert.deepEqual(
  validateCrossLaneInventory(analysisQueryBranch, analysisQueryInventory),
  [...analysisQueryOwnedFiles].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  '#8536 route must return only Phase 7-owned files',
);
assert.throws(
  () => validateCrossLaneInventory(analysisQueryBranch, [...analysisQueryInventory, 'js/ui/unrelated.js']),
  /unexpected foreign paths/,
  '#8536 route must reject any undeclared foreign path',
);
assert.throws(
  () => validateCrossLaneInventory(`${analysisQueryBranch}-similar`, analysisQueryInventory),
  /no exact Phase 7 cross-lane route/,
  'a similar branch name must not activate #8536 routing',
);
for (const file of ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml']) {
  const workflow = readFileSync(file, 'utf8');
  assert.match(workflow, /fix\/batch-4075-owner12/);
  assert.match(workflow, /tools\/validation\/phase7\/cross-lane-inventory\.mjs/);
}


const batch8936Branch = 'fix/batch-10-issues-20260915';
const batch8936OwnedFiles = [
  '.github/workflows/phase7-ownership.yml',
  'js/analysis/semantic-function-base.js',
  'js/semantics/compat/index.js',
  'tests/phase7/ownership/cross-lane-routing.test.mjs',
  'tools/validation/phase7/cross-lane-inventory.mjs',
];
const batch8936ForeignFiles = CROSS_LANE_ROUTES[batch8936Branch];
const batch8936Inventory = [...batch8936OwnedFiles, ...batch8936ForeignFiles];
assert.deepEqual(
  validateCrossLaneInventory(batch8936Branch, batch8936Inventory),
  [...batch8936OwnedFiles].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  'the #8936 route must return only the Phase 7-owned analysis/semantic subset',
);
assert.throws(
  () => validateCrossLaneInventory(batch8936Branch, [...batch8936Inventory, 'js/ui/__undeclared_8936.js']),
  /unexpected foreign paths/,
  'the #8936 route must reject an undeclared foreign path instead of waiving ownership',
);
assert.throws(
  () => validateCrossLaneInventory(`${batch8936Branch}-similar`, batch8936Inventory),
  /no exact Phase 7 cross-lane route/,
  'a similar batch branch name must not activate the #8936 route',
);
assert.throws(
  () => validateCrossLaneInventory(batch8936Branch, batch8936ForeignFiles),
  /no Phase 7-owned paths/,
  'the #8936 route must fail closed without Phase 7 evidence',
);
for (const file of ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml']) {
  const workflow = readFileSync(file, 'utf8');
  assert.ok(workflow.includes(batch8936Branch), 'the #8936 workflow route must be wired');
  assert.match(workflow, /tools\/validation\/phase7\/cross-lane-inventory\.mjs/);
}
console.log('phase7 #8936 cross-lane ownership routing: PASS');


const lane02Batch04Branch = 'codex/issue-campaign-20260914-lane-02-batch-04';
const lane02Batch04OwnedFiles = [
  '.github/workflows/phase7-ownership.yml',
  'js/analysis/discovery/producers.js',
  'tests/phase7/discovery/issue-4050-debug-authority-laundering.test.mjs',
  'tests/phase7/discovery/issue-8833-debug-start-mapping-authority.test.mjs',
  'tests/phase7/ownership/cross-lane-routing.test.mjs',
  'tools/validation/phase7/cross-lane-inventory.mjs',
];
const lane02Batch04ForeignFiles = CROSS_LANE_ROUTES[lane02Batch04Branch];
assert.deepEqual(
  [...lane02Batch04ForeignFiles],
  [
    '.circleci/config.yml',
    'tests/phase4/binary/issue-4358-elf-dynamic-xindex-common.test.mjs',
    'tests/phase4/issue-3630-elf-dynamic-section-authority.test.mjs',
    'tests/phase6/generic-core/issues-889-897.test.mjs',
    'tests/phase6/generic-core/issues-907-909-910-913.test.mjs',
  ],
  'the PR #9006 route must enumerate exactly its Phase 4/6 fixture files plus CircleCI routing',
);
const lane02Batch04Inventory = [...lane02Batch04OwnedFiles, ...lane02Batch04ForeignFiles];
assert.deepEqual(
  validateCrossLaneInventory(lane02Batch04Branch, lane02Batch04Inventory),
  [...lane02Batch04OwnedFiles].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  'the PR #9006 route must return only the Phase 7-owned discovery subset',
);
assert.throws(
  () => validateCrossLaneInventory(lane02Batch04Branch, [...lane02Batch04Inventory, 'js/semantics/ir/nodes.js']),
  /unexpected foreign paths/,
  'the PR #9006 route must reject an undeclared foreign path instead of waiving ownership',
);
assert.throws(
  () => validateCrossLaneInventory(`${lane02Batch04Branch}-similar`, lane02Batch04Inventory),
  /no exact Phase 7 cross-lane route/,
  'a similar lane-02 batch branch name must not activate the PR #9006 route',
);
assert.throws(
  () => validateCrossLaneInventory(lane02Batch04Branch, lane02Batch04ForeignFiles),
  /no Phase 7-owned paths/,
  'the PR #9006 route must fail closed without Phase 7 evidence',
);
for (const file of ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml']) {
  const workflow = readFileSync(file, 'utf8');
  assert.ok(workflow.includes(lane02Batch04Branch), 'the PR #9006 workflow route must be wired');
  assert.match(workflow, /tools\/validation\/phase7\/cross-lane-inventory\.mjs/);
}
console.log('phase7 PR #9006 cross-lane ownership routing: PASS');
