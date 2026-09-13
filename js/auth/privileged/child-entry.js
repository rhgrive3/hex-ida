import { SessionAdminAuthProvider } from '../client.js';
import { DevAgentUiSettings } from '../../ai/dev/ui/settings.js';
import { createAgentProfileEngine } from '../../ai/dev/ui/engine-router.js';
import { installDevAgentControls } from '../../ai/dev/ui/controls.js';
import { DevSupervisorV0 } from '../../ai/dev/supervisor/dev-supervisor-v0.js';
import { runProductionDevBootstrap } from '../../ai/dev/bootstrap/production-bootstrap.js';
import { createDevWorkerParentRpcClient } from '../../userscript/dev/parent-rpc.js';
import { setUiRoot } from '../../ui-root.js';

export async function installChildExtension({ auth, port, workerClient: suppliedClient = null } = {}) {
  await auth.authorize('normal');
  const workerClient = suppliedClient || (port ? createDevWorkerParentRpcClient({ port }) : null);
  if (workerClient) globalThis.__HEX_DEV_WORKER_CLIENT__ = workerClient;
  const mounts = new Set(); let closed = false;
  return Object.freeze({
    workerClient,
    mountAssistant({ standardEngine, panel, session }) {
      if (closed || !auth.getIdentity().capabilities.canUseDevAgent) throw new Error('Dev authorization denied.');
      // Privileged bundles have their own module instances: bind their UI root
      // to the actual production panel, rather than a duplicate app/store.
      setUiRoot(panel.root.closest?.('#hex-userscript-host') || document.documentElement);
      const settings = new DevAgentUiSettings({ authProvider: new SessionAdminAuthProvider(auth) });
      let supervisor, engine, controls;
      try {
        supervisor = new DevSupervisorV0({ workerClient });
        engine = createAgentProfileEngine({ standardEngine, settings, supervisor });
        controls = installDevAgentControls({ panel, session, settings });
      } catch (error) {
        // A missing/partially mounted panel must not retain auth subscriptions.
        controls?.destroy(); settings.destroy(); throw error;
      }
      let destroyed = false;
      const mount = {
        engine, settings, supervisor,
        destroy() {
          if (destroyed) return; destroyed = true;
          if (settings.agentProfile === 'dev' || session.current?.agentProfile === 'dev') session.cancel();
          settings.agentProfile = 'standard'; settings.decisionPolicy = 'normal';
          settings.persist(); settings.emit(); controls.destroy(); settings.destroy(); mounts.delete(mount);
        },
      };
      mounts.add(mount);
      queueMicrotask(() => { if (!closed && !destroyed) void auth.authorize('normal').then(() => { if (!closed && !destroyed) return runProductionDevBootstrap({ engine, session }); }).catch(() => {}); });
      return mount;
    },
    close() {
      if (closed) return; closed = true;
      for (const mount of mounts) mount.destroy(); mounts.clear(); if (!suppliedClient) workerClient?.close?.();
      if (globalThis.__HEX_DEV_WORKER_CLIENT__ === workerClient) delete globalThis.__HEX_DEV_WORKER_CLIENT__;
    },
  });
}
