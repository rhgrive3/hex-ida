import { createHash } from 'node:crypto';
const hash = (value) => createHash('sha256').update(value).digest('hex');
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
export function assertStandardGraph(metafile, label) {
  if (!metafile?.inputs || Array.isArray(metafile.inputs) || Object.keys(metafile.inputs).length === 0) throw new Error(`${label} has no verifiable input graph.`);
  const forbidden = Object.keys(metafile.inputs || {}).filter((path) => {
    const normalized = path.replaceAll('\\', '/');
    return /(?:^|\/)js\/(?:ai|userscript)\/dev\//.test(normalized)
      || /(?:^|\/)js\/auth\/(?:privileged|server)\//.test(normalized)
      || /(?:^|\/)js\/auth\/admin-app\.js$/.test(normalized);
  });
  if (forbidden.length) throw new Error(`${label} leaks privileged implementation: ${forbidden.join(', ')}`);
}
export function assertPrivilegedGraph(metafile, kind) {
  const inputs = Object.keys(metafile.inputs || {}).map((value) => value.replaceAll('\\', '/'));
  const required = kind === 'parent'
    ? ['js/userscript/dev/parent-worker-runtime.js', 'js/userscript/dev/parent-rpc.js', 'js/userscript/dev/bootstrap-host.js']
    : ['js/ai/dev/supervisor/dev-supervisor-v0.js', 'js/ai/dev/ui/settings.js', 'js/ai/dev/ui/engine-router.js', 'js/ai/dev/ui/controls.js'];
  for (const path of required) if (!inputs.some((input) => input === path || input.endsWith(`/${path}`))) throw new Error(`${kind} bundle omits ${path}`);
}
