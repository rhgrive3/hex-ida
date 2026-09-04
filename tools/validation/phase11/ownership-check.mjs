import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase11/ownership.json'), 'utf8'));
const CROSS_LANE_LABEL = 'cross-lane-integration';
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function git(args, root = ROOT) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

export function parsePhase11NameStatus(output) {
  if (!Buffer.isBuffer(output)) throw new TypeError('phase11 ownership: git diff output must be bytes');
  if (output.length === 0) return [];
  const tokens = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    tokens.push(output.subarray(start, index));
    start = index + 1;
  }
  if (start !== output.length) throw new Error('phase11 ownership: git diff output is not NUL terminated');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const decode = (token) => {
    if (!Buffer.isBuffer(token)) throw new Error('phase11 ownership: incomplete git diff record');
    let value;
    try { value = decoder.decode(token); }
    catch { throw new Error('phase11 ownership: git diff path is not UTF-8'); }
    if (value.includes('\ufeff')) throw new Error('phase11 ownership: git diff path is not canonical');
    return value;
  };
  const decodePath = (token) => {
    const value = decode(token);
    if (value === '' || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)
      || value.startsWith('/') || value.split('/').some((part) => part === '.' || part === '..')) {
      throw new Error('phase11 ownership: git diff path is not canonical');
    }
    return value;
  };
  const files = [];
  for (let index = 0; index < tokens.length;) {
    const status = decode(tokens[index++]);
    if (!/^(?:[ACDMRTUXB]|[RC][0-9]{1,3})$/.test(status)) {
      throw new Error(`phase11 ownership: invalid git diff status: ${status}`);
    }
    if (/^[RC]/.test(status)) files.push(decodePath(tokens[index++]), decodePath(tokens[index++]));
    else files.push(decodePath(tokens[index++]));
  }
  return [...new Set(files)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

export function phase11InventoryFromGit(baseSha, headSha, root = ROOT) {
  const result = spawnSync(
    'git',
    ['diff', '--name-status', '-z', '--find-renames', '--find-copies', baseSha, headSha],
    { cwd: root, encoding: null, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error('phase11 ownership: git diff failed');
  return parsePhase11NameStatus(result.stdout);
}

export function githubEvent({
  env = process.env,
  readFile = (eventPath) => fs.readFileSync(eventPath, 'utf8'),
} = {}) {
  const eventPath = env?.GITHUB_EVENT_PATH;
  if (!eventPath) return null;
  try { return JSON.parse(readFile(eventPath)); }
  catch { return null; }
}

export function phase11CrossLaneIntegration(event) {
  const pullRequest = event?.pull_request;
  const labels = pullRequest?.labels;
  const repository = event?.repository?.full_name;
  const headRef = pullRequest?.head?.ref;
  const baseRef = pullRequest?.base?.ref;
  const integrationHead = /^(?:recovery|analysis)\/final-closure-[a-z0-9][a-z0-9._/-]*$/.test(
    String(headRef || ''),
  ) && !String(headRef).includes('..')
    && !String(headRef).includes('@{')
    && !String(headRef).endsWith('/');
  return baseRef === 'main'
    && integrationHead
    && typeof repository === 'string'
    && REPOSITORY_NAME.test(repository)
    && pullRequest?.head?.repo?.full_name === repository
    && pullRequest?.base?.repo?.full_name === repository
    && Array.isArray(labels)
    && labels.some((label) => label?.name === CROSS_LANE_LABEL);
}

export function phase11OwnershipViolation(file, input = manifest, { allowUnowned = false } = {}) {
  const exact = new Set(input.allowedExact || []);
  const prefixes = input.allowedPrefixes || [];
  const forbidden = input.forbiddenPrefixes || [];
  if (exact.has(file)) return null;
  if (forbidden.some((prefix) => file.startsWith(prefix))) return `forbidden:${file}`;
  if (!prefixes.some((prefix) => file.startsWith(prefix))) return allowUnowned ? null : `unowned:${file}`;
  return null;
}

export function checkPhase11Ownership({ event, env = process.env, readFile, root = ROOT } = {}) {
  const mainRef = git(['rev-parse', '--verify', 'origin/main'], root) ? 'origin/main' : null;
  if (!mainRef) throw new Error('phase11 ownership: origin/main unavailable');
  const base = git(['merge-base', 'HEAD', mainRef], root);
  if (!base) throw new Error('phase11 ownership: merge-base unavailable');
  const files = phase11InventoryFromGit(base, 'HEAD', root);
  const crossLaneIntegration = phase11CrossLaneIntegration(
    event === undefined ? githubEvent({ env, readFile }) : event,
  );
  const violations = files.map((file) => phase11OwnershipViolation(file, manifest, {
    allowUnowned: crossLaneIntegration,
  })).filter(Boolean);
  if (violations.length) throw new Error(`phase11 ownership violations: ${violations.join(', ')}`);
  console.log(`phase11 ownership: PASS (${files.length} files, base ${base}${crossLaneIntegration ? ', cross-lane integration' : ''})`);
  return Object.freeze({ base, files, crossLaneIntegration });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { checkPhase11Ownership(); }
  catch (error) { console.error(error); process.exit(1); }
}
