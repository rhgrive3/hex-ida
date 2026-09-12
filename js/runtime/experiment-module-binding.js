/** Borrow the canonical provider module-generation owner. Never manufacture a
 * relocation or accept a caller's address/hash as a replacement for that owner.
 */
import { RuntimeModuleBindingTable } from './provider-identity.js';
import { deepFreeze, stableStringify, lossyTypeWitness } from '../core/identity/index.js';
import { snapshotContractData, recordFields, exactString, contractFail } from '../core/identity/structured.js';
const ISSUED = new WeakMap();
const typed = v => stableStringify([v, lossyTypeWitness(v)]);
const copy = v => snapshotContractData(v, { allowBigInt: true, maxNodes: 4096, maxBytes: 131072 });
export function captureExperimentModuleBinding(context, { world, assumptions, snapshotId, debugBinding, target }) {
  if (!(context?.modules instanceof RuntimeModuleBindingTable) || typeof context.isCurrent !== 'function'
    || context.isCurrent() !== true) contractFail('experiment-module-owner-required');
  const binding = copy(context.binding);
  recordFields(binding, ['worldId', 'assumptionsId', 'snapshotId', 'runtimeSessionId', 'debugSessionId',
    'providerId', 'providerVersion', 'sessionEpoch'], 'experiment-provider-binding-fields');
  if (binding.worldId !== world.id || binding.assumptionsId !== assumptions.id || binding.snapshotId !== snapshotId
    || binding.debugSessionId !== debugBinding.sessionId || binding.sessionEpoch !== debugBinding.epoch
    || binding.runtimeSessionId !== context.modules.runtimeSessionId) contractFail('experiment-provider-binding-mismatch');
  for (const k of ['runtimeSessionId', 'providerId', 'providerVersion']) exactString(binding[k], 'experiment-provider-identity');
  const modules = context.modules, active = modules.active();
  if (active.length > 4096) contractFail('experiment-provider-module-budget');
  // Resolve without a binary filter: overlapping modules must remain ambiguous.
  const resolution = modules.resolve(target);
  if (resolution.state !== 'exact' || !resolution.moduleBindingKey) contractFail('experiment-target-module-unbound');
  const module = modules.get(resolution.moduleBindingKey);
  if (resolution.state !== 'exact' || !module || module.generation !== resolution.moduleGeneration
    || !module.identityEvidenceIds.length || module.identityEvidenceIds.length > 64 || !world.binarySet.some(b => b.binaryId === resolution.binaryId
      && b.sliceId === resolution.sliceId && b.sourceIdentity.kind === 'complete-content'
      && b.sourceIdentity.sha256 === debugBinding.binaryHash)) contractFail('experiment-target-module-unbound');
  const data = deepFreeze({ schema: 'scoped-experiment-module-binding/v1', ...binding,
    moduleBindingKey: module.bindingKey, moduleGeneration: module.generation,
    runtimeAddress: String(resolution.runtimeAddress), staticAddress: String(resolution.staticAddress),
    binaryId: resolution.binaryId, sliceId: resolution.sliceId,
    identityEvidenceIds: copy(module.identityEvidenceIds), authority: 'current-provider-owner-premise' });
  ISSUED.set(data, { context, modules, runtimeSessionId: modules.runtimeSessionId, bindingData: typed(binding),
    active: new Map(active.map(m => [m.bindingKey, m])) });
  assertExperimentModuleBinding(data); return data;
}
export function assertExperimentModuleBinding(data, work = null) {
  const owner = ISSUED.get(data);
  if (!owner) contractFail('experiment-module-binding-not-issued');
  work?.checkpoint();
  const { context, modules } = owner;
  if (context.isCurrent() !== true || context.modules !== modules || modules.runtimeSessionId !== owner.runtimeSessionId
    || typed(copy(context.binding)) !== owner.bindingData) contractFail('experiment-provider-owner-stale');
  const active = modules.active();
  if (active.length !== owner.active.size) contractFail('experiment-module-membership-changed');
  for (const module of active) {
    work?.charge('workUnits');
    if (owner.active.get(module.bindingKey) !== module) contractFail('experiment-module-generation-changed');
  }
  return true;
}
