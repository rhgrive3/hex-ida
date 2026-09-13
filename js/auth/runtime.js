import { createSessionClient } from './client.js';
import { createAuthRpcClient } from './rpc.js';
import { createUserscriptLogin } from './userscript-login.js';
import { loadParentModule, loadChildModule } from './extension-loader.js';
import { setAuthContext } from './runtime-context.js';

export async function startParentAuth({ apiOrigin, privilegedManifest, manager, runtimeIdentity, devWorkerOptions, loadModule = loadParentModule, createClient = createSessionClient, createLogin = createUserscriptLogin, refreshMs = 60000 } = {}) {
  const auth = createClient({ apiOrigin, privilegedManifest, manager });
  const login = createLogin({ auth, apiOrigin });
  let extension = null, closed = false, epoch = 0;
  const unsubscribe = auth.subscribe((identity) => {
    if (!identity.capabilities.canUseDevAgent) { epoch++; extension?.close(); extension = null; }
  });
  await auth.initialize();
  if (auth.getIdentity().capabilities.canFetchPrivilegedDevSource) {
    const current = epoch;
    try {
      const module = await loadModule(await auth.source('parent'));
      if (current !== epoch) throw new Error('Authorization changed.');
      const installed = await module.installParentExtension({ auth, runtimeIdentity, devWorkerOptions });
      if (closed || current !== epoch || !auth.getIdentity().capabilities.canUseDevAgent) installed.close();
      else extension = installed;
    } catch { extension?.close(); extension = null; }
  }
  const timer = setInterval(() => { void auth.refresh(); }, Math.max(1000, refreshMs));
  return Object.freeze({
    auth, login: login.show,
    get extension() { return extension; },
    close() { if (closed) return; closed = true; epoch++; clearInterval(timer); unsubscribe(); login.close(); extension?.close(); extension = null; auth.close(); },
  });
}
export async function startChildAuth({ port, apiOrigin, privilegedManifest, loadModule = loadChildModule, suppliedAuth, showLogin, workerClient, createClient = createSessionClient, createRpcClient = createAuthRpcClient, refreshMs = 60000 } = {}) {
  const auth = suppliedAuth || (port ? createRpcClient({ port }) : createClient({ apiOrigin, privilegedManifest, web: true }));
  let extension = null, closed = false, epoch = 0, timer = null, unsubscribe = () => {}, release = () => {};
  const context = {
    auth,
    get childExtension() { return extension; },
    login: showLogin || (port ? () => { void auth.login().catch(() => {}); } : () => globalThis.location.assign(new URL('/auth/discord/start?return_to=%2F', apiOrigin).href)),
    logout: () => auth.logout(),
    close() {
      if (closed) return;
      closed = true; epoch++; clearInterval(timer); unsubscribe(); extension?.close?.(); extension = null;
      if (!suppliedAuth) auth.close();
      release();
    },
  };
  release = setAuthContext(context);
  unsubscribe = auth.subscribe((identity) => {
    if (!identity.capabilities.canUseDevAgent) { epoch++; extension?.close?.(); extension = null; }
  });
  if (!suppliedAuth) timer = setInterval(() => { void auth.refresh(); }, Math.max(1000, refreshMs));
  try { await (port || suppliedAuth ? auth.refresh() : auth.initialize()); } catch { /* Standard has no login prerequisite. */ }
  if (!closed && auth.getIdentity().capabilities.canFetchPrivilegedDevSource) {
    const current = epoch;
    try {
      const module = await loadModule(await auth.source('child'));
      if (closed || current !== epoch) throw new Error('Authorization changed.');
      const installed = await module.installChildExtension({ auth, port, workerClient });
      if (closed || current !== epoch || !auth.getIdentity().capabilities.canUseDevAgent) installed.close();
      else extension = installed;
    } catch { extension?.close?.(); extension = null; }
  }
  return context;
}
