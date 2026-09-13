/** In-process publication fence for an existing runtime session. Module lists
 * are full type-preserving snapshots, not hashes used as semantic evidence.
 * This captures ownership/lifecycle only; a listed module is not proof of a
 * loader relocation, ISA profile, or natural execution.
 */
import { DebugAdapterError } from '../debug/adapter.js';
import { snapshotContractData } from '../core/identity/structured.js';
import { stableStringify, lossyTypeWitness, deepFreeze } from '../core/identity/index.js';
const BINDINGS = new WeakMap();
function moduleSnapshot(session) {
  if (!Array.isArray(session.modules) || session.modules.length > 4096) throw new DebugAdapterError('experiment-module-budget', 'runtime module snapshot must be a bounded array');
  return snapshotContractData(session.modules, { allowBigInt: true, maxNodes: 32768, maxBytes: 1048576 });
}
const typed = value => stableStringify([value, lossyTypeWitness(value)]);
export function captureExperimentBinding(session, currentSession) {
  if (!session || session.closed || currentSession() !== session) throw new DebugAdapterError('experiment-session-stale', 'runtime session is not current');
  const modules = moduleSnapshot(session);
  const binding = deepFreeze({ sessionId: session.id, epoch: session.epoch, binaryHash: session.binaryHash,
    backend: session.backend, moduleSnapshot: modules });
  BINDINGS.set(binding, { session, currentSession, adapter: session.adapter, moduleArray: session.modules, moduleRefs: [...session.modules], moduleData: typed(modules) });
  return binding;
}
export function assertExperimentBinding(binding, signal = null) {
  const owner = BINDINGS.get(binding);
  if (!owner) throw new DebugAdapterError('experiment-binding-authority', 'an issued runtime binding is required');
  if (signal?.aborted) {
    const reason = signal.reason;
    const code = reason === 'timeout' ? 'timeout' : reason === 'session-epoch-changed' ? reason : 'cancelled';
    throw new DebugAdapterError(code, `runtime experiment ${code}`);
  }
  const session = owner.session;
  if (session.closed) throw new DebugAdapterError('session-closed', 'runtime experiment session closed');
  if (session.epoch !== binding.epoch) throw new DebugAdapterError('session-epoch-changed', 'runtime experiment epoch changed');
  if (owner.currentSession() !== session || session.adapter !== owner.adapter || session.id !== binding.sessionId
    || session.binaryHash !== binding.binaryHash || session.backend !== binding.backend) {
    throw new DebugAdapterError('experiment-session-stale', 'runtime experiment ownership or build changed');
  }
  if (session.modules !== owner.moduleArray || session.modules.length !== owner.moduleRefs.length
    || session.modules.some((module, i) => module !== owner.moduleRefs[i]) || typed(moduleSnapshot(session)) !== owner.moduleData) throw new DebugAdapterError('experiment-modules-changed', 'runtime experiment module generation changed');
  return true;
}
