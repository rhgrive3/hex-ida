// Canonical unchanged-assertion command corpus used by the Phase 3 v1/v2
// differential proof. Keep this independent from package.json orchestration so
// changing a suite runner cannot accidentally shrink the proof denominator.

export const SEMANTIC_ASSERTION_FILES = Object.freeze([
  'tests/issue-425-planner-budget.mjs',
  'tests/issues-426-427-semantic-facts.mjs',
  'tests/issue-430-memory-escape.mjs',
  'tests/ir-dataflow.mjs',
  'tests/ir-alias.mjs',
  'tests/ir-pinpoint-path.mjs',
  'tests/ir-pinpoint-location.mjs',
  'tests/ir-comparisons.mjs',
  'tests/semantic-core.mjs',
  'tests/semantic-nullability.mjs',
  'tests/integration-review.mjs',
]);

export const DECOMPILER_ASSERTION_FILES = Object.freeze([
  'tests/issue-142-multi-return.mjs',
  'tests/issue-429-range-domain.mjs',
  'tests/issues-400-405.mjs',
  'tests/decompile-cfg.mjs',
  'tests/decompiler-semantic.mjs',
  'tests/decompiler-switch.mjs',
  'tests/decompiler-rewrite.mjs',
  'tests/decompiler-pipeline.mjs',
  'tests/compiler-truth/run.mjs',
  'tests/objc-metadata.mjs',
  'tests/objc-runtime.mjs',
  'tests/issue-529-objc-integration.mjs',
  'tests/swift-runtime.mjs',
  'tests/issues-471-472-legacy-types.mjs',
]);

export function nodeCommandsFor(files) {
  return Object.freeze(files.map((file) => `node ${file}`));
}

export const SEMANTIC_ASSERTION_COMMANDS = nodeCommandsFor(SEMANTIC_ASSERTION_FILES);
export const DECOMPILER_ASSERTION_COMMANDS = nodeCommandsFor(DECOMPILER_ASSERTION_FILES);

export const PHASE3_ASSERTION_COMMAND_COUNT =
  SEMANTIC_ASSERTION_COMMANDS.length + DECOMPILER_ASSERTION_COMMANDS.length;

if (PHASE3_ASSERTION_COMMAND_COUNT !== 25) {
  throw new Error(`phase3 assertion corpus denominator drift: ${PHASE3_ASSERTION_COMMAND_COUNT} != 25`);
}
