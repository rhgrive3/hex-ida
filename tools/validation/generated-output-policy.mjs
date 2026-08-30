/*
 * Generated userscript ownership is a transaction boundary. Component lanes
 * build the outputs ephemerally; only the main/integration lane may publish
 * the committed projection. Keep this decision in one small, testable policy
 * so workflow jobs cannot accidentally turn a component into a release lane.
 */

export const GENERATED_OUTPUT_MODE = Object.freeze({
  ENFORCE: 'enforce',
  EPHEMERAL: 'ephemeral',
});

// Generated files the main integration lane may keep canonical on its own.
// Everything else stays out of automatic commits (EP-003/EP-008 boundaries).
export const CANONICAL_GENERATED_OUTPUT_PATHS = Object.freeze([
  'userscript/hex.user.template.js',
  'userscript/release-version.json',
]);

const RELEASE_CONTEXTS = Object.freeze(['main', 'release']);
const CANONICAL_OUTPUT_PATH_SET = new Set(CANONICAL_GENERATED_OUTPUT_PATHS);

function normalizeRepoPath(value) {
  return String(value).replaceAll('\\', '/');
}

/*
 * Who may commit regenerated userscript output without a human PR: only a
 * push into a release context (the merge just landed; the committed outputs
 * cannot have embedded their own content hash) or a manual dispatch that
 * lists the changed paths explicitly. Off-list changed files veto the whole
 * commit so source edits can never ride along, and deleted outputs fail
 * closed because a build that stops emitting them is a real regression.
 */
export function resolveCanonicalGeneratedOutputCommit({ eventName = '', refName = '', changedPaths = [], deletedPaths = [] } = {}) {
  const event = String(eventName || '');
  const branch = String(refName || '');
  const permitted = (event === 'push' && RELEASE_CONTEXTS.includes(branch)) || event === 'workflow_dispatch';
  const changed = Object.freeze([...new Set((Array.isArray(changedPaths) ? changedPaths : []).map(normalizeRepoPath).filter(Boolean))]);
  const deletions = Object.freeze([...new Set((Array.isArray(deletedPaths) ? deletedPaths : []).map(normalizeRepoPath).filter((file) => CANONICAL_OUTPUT_PATH_SET.has(file)))]);
  const offList = Object.freeze(changed.filter((file) => !CANONICAL_OUTPUT_PATH_SET.has(file)));
  return Object.freeze({
    permitted,
    canCommit: permitted && offList.length === 0 && deletions.length === 0 && changed.length > 0,
    offList,
    deletions,
    paths: Object.freeze(changed.filter((file) => CANONICAL_OUTPUT_PATH_SET.has(file))),
  });
}

const INTEGRATION_PREFIXES = Object.freeze([
  'dev-agent-hardening/integration/',
]);

function isValidBranchName(branch) {
  if (typeof branch !== 'string' || !branch) return false;
  if (branch.includes('..') || branch.includes('@{') || branch.includes('\\') || /[\x00-\x20\x7f ~^:?*[]/.test(branch)) return false;
  if (branch.startsWith('/') || branch.endsWith('.lock') || branch.includes('//')) return false;
  return true;
}

export function generatedOutputMode({ eventName = '', headRef = '', ref = '' } = {}) {
  const event = String(eventName || '');
  const branch = String(headRef || '');
  const refName = String(ref || '');

  if (event === 'pull_request' && isValidBranchName(branch)) {
    if (INTEGRATION_PREFIXES.some((prefix) => branch.startsWith(prefix))) {
      return GENERATED_OUTPUT_MODE.ENFORCE;
    }
    return GENERATED_OUTPUT_MODE.EPHEMERAL;
  }

  // Pushes to main/release contexts, workflow dispatch, and malformed or
  // unknown contexts fail closed to canonical generated-output enforcement.
  void refName;
  return GENERATED_OUTPUT_MODE.ENFORCE;
}

export function shouldEnforceGeneratedOutput(context = {}) {
  return generatedOutputMode(context) === GENERATED_OUTPUT_MODE.ENFORCE;
}

const isMain = process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname;
if (isMain) {
  const mode = generatedOutputMode({
    eventName: process.env.GITHUB_EVENT_NAME,
    headRef: process.env.GITHUB_HEAD_REF,
    ref: process.env.GITHUB_REF,
  });
  process.stdout.write(`${mode}\n`);
}
