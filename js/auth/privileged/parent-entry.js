import { startParentDevWorkerRuntime } from '../../userscript/dev/parent-worker-runtime.js';
import { createDevWorkerParentRpc } from '../../userscript/dev/parent-rpc.js';
import { installDevBootstrapHost } from '../../userscript/dev/bootstrap-host.js';
export async function installParentExtension({ auth, runtimeIdentity, devWorkerOptions = {} } = {}) {
  await auth.authorize('normal');
  const runtime = await startParentDevWorkerRuntime({ ...devWorkerOptions, runtimeIdentity });
  let closed = false; const attached = new Set(), ports = new WeakSet();
  return Object.freeze({
    runtime,
    attach(port) {
      if (closed || ports.has(port)) throw new Error('Privileged parent port is unavailable.');
      ports.add(port);
      const rpc = createDevWorkerParentRpc({ port, runtime, authorize: () => auth.authorize('normal') }); attached.add(rpc);
      return { close() { rpc.close(); attached.delete(rpc); ports.delete(port); } };
    },
    bootstrap(host, identity) {
      if (closed) throw new Error('Privileged parent is closed.');
      const bootstrap = installDevBootstrapHost({ host, runtimeIdentity: identity, authorize: () => auth.authorize('normal') }); attached.add(bootstrap);
      return bootstrap;
    },
    close() { if (closed) return; closed = true; for (const item of attached) item.close(); attached.clear(); runtime.close(); },
  });
}
