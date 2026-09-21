import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const DEFAULT_REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url))).replaceAll('\\', '/');

function normalizeInputPath(rawPath, repoRoot = DEFAULT_REPO_ROOT, { caseInsensitive = false } = {}) {
  const normalized = String(rawPath ?? '').replaceAll('\\', '/');
  if (!repoRoot) return normalized;
  if (repoRoot === '/') return normalized.startsWith('/') ? normalized.slice(1) : normalized;
  const comparablePath = caseInsensitive ? normalized.toLowerCase() : normalized;
  const comparableRoot = caseInsensitive ? repoRoot.toLowerCase() : repoRoot;
  if (comparablePath === comparableRoot) return '';
  if (comparablePath.startsWith(`${comparableRoot}/`)) {
    return normalized.slice(repoRoot.length + 1);
  }
  return normalized;
}

export function privilegedIdentity(runtimeBuildId, parent, child, admin) {
  if (!/^[0-9a-f]{24}$/.test(runtimeBuildId)) throw new Error('Invalid runtime build identity.');
  const parentHash = hash(parent), childHash = hash(child), adminHash = hash(admin);
  return Object.freeze({ buildId: `${runtimeBuildId}.${hash(`${parentHash}:${childHash}:${adminHash}`).slice(0, 24)}`, parentHash, childHash, adminHash });
}
export function releaseIdentityFor(inputs) {
  // Length-delimited digests avoid ambiguous concatenation and circular inputs.
  // No privileged bundle embeds the final identity.
  return hash(inputs.map((value) => hash(value)).join(':'));
}
function isForbiddenStandardInput(inputPath, { caseInsensitive = false } = {}) {
  const normalized = String(inputPath ?? '').replaceAll('\\', '/');
  const policyPath = caseInsensitive ? normalized.toLowerCase() : normalized;
  return /(?:^|\/)js\/(?:ai|userscript)\/dev\//.test(policyPath)
    || /(?:^|\/)js\/auth\/(?:privileged|server)\//.test(policyPath)
    || /(?:^|\/)js\/auth\/admin-app\.js$/.test(policyPath);
}

function effectiveInputPath(inputPath, repoRoot, { realpathSync = fs.realpathSync } = {}) {
  const raw = String(inputPath ?? '');
  if (!raw || raw.startsWith('<') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null;
  const candidate = path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
  try {
    return realpathSync(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

export function assertStandardGraph(metafile, label, options = {}) {
  if (!metafile?.inputs || Array.isArray(metafile.inputs) || Object.keys(metafile.inputs).length === 0) throw new Error(`${label} has no verifiable input graph.`);
  const caseInsensitive = (options?.platform ?? process.platform) === 'win32';
  const repoRoot = path.resolve(options?.repoRoot ?? DEFAULT_REPO_ROOT);
  const forbidden = [];
  for (const inputPath of Object.keys(metafile.inputs || {})) {
    if (isForbiddenStandardInput(inputPath, { caseInsensitive })) {
      forbidden.push(inputPath);
      continue;
    }
    const effective = effectiveInputPath(inputPath, repoRoot, { realpathSync: options?.realpathSync ?? fs.realpathSync });
    if (effective && isForbiddenStandardInput(effective, { caseInsensitive })) {
      forbidden.push(`${inputPath} -> ${effective}`);
    }
  }
  if (forbidden.length) throw new Error(`${label} leaks privileged implementation: ${forbidden.join(', ')}`);
}
export function assertPrivilegedGraph(metafile, kind, options = {}) {
  if (kind !== 'parent' && kind !== 'child') throw new Error(`Unsupported privileged bundle kind: ${String(kind)}`);
  const repoRoot = options?.repoRoot != null
    ? (() => {
        const normalized = String(options.repoRoot).replaceAll('\\', '/');
        return /^\/+$/u.test(normalized) ? '/' : normalized.replace(/\/+$/, '');
      })()
    : DEFAULT_REPO_ROOT;
  const rawInputs = Object.keys(metafile?.inputs || {});
  const caseInsensitive = (options?.platform ?? process.platform) === 'win32';
  const inputSet = new Set(rawInputs.map((val) => normalizeInputPath(val, repoRoot, { caseInsensitive })));
  const required = kind === 'parent'
    ? ['js/userscript/dev/parent-worker-runtime.js', 'js/userscript/dev/parent-rpc.js', 'js/userscript/dev/bootstrap-host.js']
    : ['js/ai/dev/supervisor/dev-supervisor-v0.js', 'js/ai/dev/ui/settings.js', 'js/ai/dev/ui/engine-router.js', 'js/ai/dev/ui/controls.js'];
  for (const path of required) if (!inputSet.has(path)) throw new Error(`${kind} bundle omits ${path}`);
}
