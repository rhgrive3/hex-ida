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

function effectiveStandardInputPath(inputPath, repoRoot, { realpathSync = fs.realpathSync, platform = process.platform } = {}) {
  if (platform !== process.platform && realpathSync === fs.realpathSync) return null;
  const candidate = path.isAbsolute(inputPath) ? inputPath : path.resolve(repoRoot, inputPath);
  try {
    const realRoot = realpathSync(repoRoot);
    const realInput = realpathSync(candidate);
    const relative = path.relative(realRoot, realInput);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`standard graph input escapes repository: ${inputPath}`);
    }
    return relative.replaceAll('\\', '/');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

export function assertStandardGraph(metafile, label, options = {}) {
  if (!metafile?.inputs || Array.isArray(metafile.inputs) || Object.keys(metafile.inputs).length === 0) throw new Error(`${label} has no verifiable input graph.`);
  const platform = options?.platform ?? process.platform;
  const caseInsensitive = platform === 'win32';
  const repoRoot = options?.repoRoot != null ? path.resolve(String(options.repoRoot)) : DEFAULT_REPO_ROOT;
  const resolver = options?.realpathSync ?? fs.realpathSync;
  const forbidden = [];
  for (const inputPath of Object.keys(metafile.inputs || {})) {
    if (isForbiddenStandardInput(inputPath, { caseInsensitive })) {
      forbidden.push(inputPath);
      continue;
    }
    const effective = effectiveStandardInputPath(inputPath, repoRoot, { realpathSync: resolver, platform });
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
  const normalizedInputs = rawInputs.map((rawPath) => ({
    rawPath,
    normalized: normalizeInputPath(rawPath, repoRoot, { caseInsensitive }),
  }));
  const inputSet = new Set(normalizedInputs.map(({ normalized }) => normalized));
  const required = kind === 'parent'
    ? ['js/userscript/dev/parent-worker-runtime.js', 'js/userscript/dev/parent-rpc.js', 'js/userscript/dev/bootstrap-host.js']
    : ['js/ai/dev/supervisor/dev-supervisor-v0.js', 'js/ai/dev/ui/settings.js', 'js/ai/dev/ui/engine-router.js', 'js/ai/dev/ui/controls.js'];
  const realpathSync = options?.realpathSync ?? fs.realpathSync;
  let realRoot;
  try {
    realRoot = realpathSync(repoRoot);
  } catch (error) {
    throw new Error(`${kind} bundle cannot establish repository identity`, { cause: error });
  }
  for (const requiredPath of required) {
    if (!inputSet.has(requiredPath)) throw new Error(`${kind} bundle omits ${requiredPath}`);
    const matches = normalizedInputs.filter(({ normalized }) => normalized === requiredPath);
    for (const { rawPath } of matches) {
      const candidate = path.isAbsolute(rawPath) ? rawPath : path.resolve(repoRoot, rawPath);
      let realInput;
      try {
        realInput = realpathSync(candidate);
      } catch (error) {
        throw new Error(`${kind} bundle cannot establish source identity for ${requiredPath}`, { cause: error });
      }
      const relative = path.relative(realRoot, realInput);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`${kind} bundle required input escapes repository: ${requiredPath}`);
      }
    }
  }
}
