/** First-party opt-in switch and host capabilities. Never an AI/tool argument. */
const HOSTS = new WeakMap();
let revision = 0;
const CALLBACKS = ['loadPipeline', 'getEvidenceGraph', 'getPhase8Context', 'describeObjectTarget',
  'getExternalModels', 'resolveCanonicalEvidence', 'getProofCheckers', 'qualifyDispatch',
  'getInvestigationContext', 'resolveInvestigationDischarge', 'getFunctionFlowInterface', 'getAbiPlacementContext', 'resolveTransformReceipt',
  'getConditionalModelContext', 'getLoopModelContext', 'getAsyncEventContext', 'getRuntimeEvidenceContext', 'getRuntimeTargetEnvelope', 'qualifyRuntimeObservation', 'getMachOPointerContext', 'getObjcDispatchContext', 'getSwiftDispatchContext', 'getObjcBlockContext', 'resolveFunctionIdentity', 'getKnowledgeContext'];
export function configureScopedAnalysisHost(app, configuration = {}) {
  if (!app || typeof app !== 'object') throw new TypeError('scoped-host-app-required');
  if (!configuration || Object.getPrototypeOf(configuration) !== Object.prototype) throw new TypeError('scoped-host-config-required');
  const descriptors = Object.getOwnPropertyDescriptors(configuration);
  if (Reflect.ownKeys(configuration).some((key) => typeof key !== 'string')
    || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)) {
    throw new TypeError('scoped-host-config-data-fields');
  }
  configuration = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
  for (const key of Object.keys(configuration)) if (!['enabled', 'maximumSessions', 'sessionTtlMs', ...CALLBACKS].includes(key)) throw new TypeError('scoped-host-config-field');
  for (const name of CALLBACKS) if (configuration[name] != null && typeof configuration[name] !== 'function') throw new TypeError(`scoped-host-capability:${name}`);
  if (configuration.enabled !== undefined && typeof configuration.enabled !== 'boolean') throw new TypeError('scoped-host-enabled');
  const maximumSessions = configuration.maximumSessions ?? 2, sessionTtlMs = configuration.sessionTtlMs ?? 120000;
  if (!Number.isSafeInteger(maximumSessions) || maximumSessions < 1 || maximumSessions > 4) throw new TypeError('scoped-host-session-cap');
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1000 || sessionTtlMs > 900000) throw new TypeError('scoped-host-session-ttl');
  const prior = HOSTS.get(app);
  // Retire all borrowed identities and jobs BEFORE changing any capability.
  prior?.service?.close('host-reconfigured');
  const entry = { configuration: Object.freeze({ ...configuration, enabled: configuration.enabled === true, maximumSessions, sessionTtlMs }), revision: ++revision, service: null, binding: null };
  HOSTS.set(app, entry);
  return Object.freeze({ enabled: entry.configuration.enabled, revision: entry.revision, experimental: true, testQualified: false });
}
export function scopedAnalysisHost(app) { return HOSTS.get(app) ?? null; }
/** Canonical owners must call this synchronously before membership mutation. */
export function invalidateScopedAnalysis(app, selectors = null) {
  const entry = HOSTS.get(app); if (!entry) return;
  if (selectors !== null) entry.service?.dependencies.advance(selectors);
  else entry.service?.dependencies.reset('unclassified-owner-change');
  entry.service?.close('owner-change'); entry.service = null; entry.binding = null;
  entry.revision = ++revision;
}
export function disableScopedAnalysisHost(app) { return configureScopedAnalysisHost(app, { enabled: false }); }

// Local immutable source identity avoids hashing/materializing the whole file
// merely to ask a focused query. It is explicitly NOT a cross-device content ID.
const SOURCE_IDENTITIES = new WeakMap();
export function scopedImmutableSourceIdentity(app, file) {
  if (!scopedAnalysisHost(app)?.configuration.enabled || typeof Blob === 'undefined' || !(file instanceof Blob)) return null;
  let id = SOURCE_IDENTITIES.get(file);
  if (!id) {
    if (!globalThis.crypto?.getRandomValues) return null;
    const nonce = [...globalThis.crypto.getRandomValues(new Uint32Array(4))].map((n) => n.toString(16).padStart(8, '0')).join('');
    id = `local_immutable_${nonce}`; SOURCE_IDENTITIES.set(file, id);
  }
  return id;
}
