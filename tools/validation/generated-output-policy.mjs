/*
 * Generated userscript ownership is a transaction boundary. Component lanes
 * build the outputs ephemerally; PRs into release branches and explicit
 * integration lanes own the committed projection. Keep this decision in one
 * small, testable policy so workflows cannot bypass protected-branch rules.
 */

export const GENERATED_OUTPUT_MODE = Object.freeze({
  ENFORCE: 'enforce',
  EPHEMERAL: 'ephemeral',
});

export const CANONICAL_GENERATED_OUTPUT_PATHS = Object.freeze([
  'userscript/hex.user.template.js',
  'userscript/release-version.json',
]);

const RELEASE_CONTEXTS = Object.freeze(['main', 'release']);
const WRITE_CONTEXTS = Object.freeze(['release']);
const CANONICAL_OUTPUT_PATH_SET = new Set(CANONICAL_GENERATED_OUTPUT_PATHS);

function normalizeRepoPath(value) {
  let normalized = String(value).replaceAll('\\', '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

/*
 * Direct generated-output commits are never permitted on protected main.
 * The legacy publisher remains available only for an explicit release branch,
 * while main receives canonical outputs through its pull-request transaction.
 */
export function resolveCanonicalGeneratedOutputCommit({
  eventName = '',
  refName = '',
  changedPaths = [],
  deletedPaths = [],
} = {}) {
  const event = String(eventName || '');
  const branch = String(refName || '');
  const permitted = WRITE_CONTEXTS.includes(branch)
    && (event === 'push' || event === 'workflow_dispatch');
  const changed = Object.freeze([
    ...new Set((Array.isArray(changedPaths) ? changedPaths : [])
      .map(normalizeRepoPath)
      .filter(Boolean)),
  ]);
  const deletions = Object.freeze([
    ...new Set((Array.isArray(deletedPaths) ? deletedPaths : [])
      .map(normalizeRepoPath)
      .filter((file) => CANONICAL_OUTPUT_PATH_SET.has(file))),
  ]);
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

export function generatedOutputMode({ eventName = '', headRef = '', baseRef = '', ref = '' } = {}) {
  const event = String(eventName || '');
  const branch = String(headRef || '');
  const base = String(baseRef || '');
  const refName = String(ref || '');

  if (event === 'pull_request' && isValidBranchName(branch)) {
    if (RELEASE_CONTEXTS.includes(base)) return GENERATED_OUTPUT_MODE.ENFORCE;
    if (INTEGRATION_PREFIXES.some((prefix) => branch.startsWith(prefix))) {
      return GENERATED_OUTPUT_MODE.ENFORCE;
    }
    return GENERATED_OUTPUT_MODE.EPHEMERAL;
  }

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
    baseRef: process.env.GITHUB_BASE_REF,
    ref: process.env.GITHUB_REF,
  });
  process.stdout.write(`${mode}\n`);
}
