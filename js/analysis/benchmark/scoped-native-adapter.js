/** Model-free Hex native-best lane. A real ScopedAnalysisService executes all
 * analysis; this adapter only pins a case, bounds orchestration and exports
 * native answer/evidence/cost. It NEVER emits an oracle receipt or victory.
 */
import { ScopedAnalysisService } from '../query/scoped-service.js';
import { ScopedAnalysisWork, workStopStatus } from '../../core/budgets/scoped-work.js';
import { snapshotContractData, recordFields, exactString, exactInteger, contractFail } from '../../core/identity/structured.js';
import { stableDigest } from '../../core/identity/index.js';
export const SCOPED_NATIVE_ADAPTER_VERSION = '1.0.0';
export class ScopedNativeBestAdapter {
  #service; #binding; #cursor = null; #active = null; #lastArtifact = null;
  constructor(service, binding) {
    if (!(service instanceof ScopedAnalysisService) || service.closed) contractFail('native-best-service-owner-required');
    const input = snapshotContractData(binding);
    recordFields(input, ['caseId', 'snapshotId', 'worldId', 'baselineCommit'], 'native-best-case-fields');
    for (const key of ['caseId', 'snapshotId', 'worldId']) exactString(input[key], 'native-best-' + key);
    if (!/^[a-f0-9]{40}$/.test(input.baselineCommit) || input.worldId !== service.worldId) contractFail('native-best-world-binding');
    this.#service = service; this.#binding = Object.freeze(input);
  }
  #check(value) {
    if (this.#service.closed || this.#service.worldId !== this.#binding.worldId) contractFail('native-best-service-stale');
    if (value?.snapshotId != null && value.snapshotId !== this.#binding.snapshotId) contractFail('native-best-snapshot-mismatch');
    if (value?.worldId != null && value.worldId !== this.#binding.worldId) contractFail('native-best-world-mismatch');
  }
  async capabilities(options = {}) {
    this.#check();
    const native = await this.#service.invoke('scopedCapabilities', {}, { ...options, limits: { deadlineMs: 1000 } });
    this.#check(native.value);
    return { schema: 'scpa-native-best-capabilities/v1', participant: 'hex-astra', mode: 'T0-model-free',
      version: SCOPED_NATIVE_ADAPTER_VERSION, binding: this.#binding, native: native.value,
      methods: ['capabilities', 'query', 'explain', 'cancel'], oracleAuthority: false,
      measuredAstra: false, competitorAvailability: 'UNMEASURED', defaultRolloutEligible: false };
  }
  async query(request, { signal = null, deadlineMs = 10000, maximumSteps = 64, limits = {} } = {}) {
    if (this.#active) contractFail('native-best-query-already-active');
    exactInteger(maximumSteps, 'native-best-step-cap', { min: 1, max: 256 });
    exactInteger(deadlineMs, 'native-best-deadline', { min: 1, max: 120000 });
    const input = snapshotContractData(request, { maxBytes: 65536, maxNodes: 8192 });
    recordFields(input, ['kind', 'request'], 'native-best-request-fields');
    if (!['demand', 'investigation'].includes(input.kind)) contractFail('native-best-query-kind');
    this.#check(); this.#lastArtifact = null;
    const controller = new AbortController(); this.#active = controller;
    const abort = () => controller.abort(signal.reason); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const work = new ScopedAnalysisWork({ limits: { deadlineMs, workUnits: 256, calls: 256 }, signal: controller.signal, name: 'native-best-adapter' });
    let result = null, steps = 0, status = 'partial';
    try {
      for (; steps < maximumSteps; steps++) {
        work.charge('workUnits'); this.#check();
        const cursor = this.#cursor;
        const method = cursor ? 'resumeDemandQuery' : input.kind === 'demand' ? 'demandQuery' : 'investigateDemand';
        // Service owns aggregate deterministic budgets. A fresh step never
        // resets them; wall deadline is shared across this entire adapter run.
        const envelope = await work.await(child => this.#service.invoke(method, cursor ? { cursor } : input.request,
          { signal: child, limits: { ...limits, deadlineMs: Math.max(1, Math.floor(deadlineMs - work.cost().elapsedMs)) } }));
        result = envelope.value; this.#check(result);
        this.#cursor = result?.continuation?.cursor ?? null;
        if (!this.#cursor) { status = result.executionStatus ?? result.status ?? 'unknown'; steps++; break; }
      }
      if (result?.publication?.status === 'published') this.#lastArtifact = result.publication.artifactId;
      // Bounded, owned output only. No score, exact error count or correctness
      // measurement is inferred from successful completion or a feature hash.
      return snapshotContractData({ schema: 'scpa-native-best-execution/v1', version: SCOPED_NATIVE_ADAPTER_VERSION,
        binding: this.#binding, requestDigest: stableDigest(input), mode: 'T0-model-free', status, steps,
        result, continuationRetained: false,
        continuationDisposition: this.#cursor ? 'cancelled-at-adapter-boundary' : 'none', measurements: { wallMs: work.cost().elapsedMs, nativeCost: result?.cost ?? null,
          correctness: 'UNMEASURED', peakMemory: 'UNMEASURED', sameAstra: 'UNMEASURED' },
        independentOracleRequired: true, exact: false }, { allowBigInt: true, maxBytes: 4194304, maxNodes: 100000 });
    } finally {
      // Never leave an abandoned cursor when the harness times out or reaches
      // its smaller step cap. Cancellation itself has a separate finite bound.
      work.dispose(); signal?.removeEventListener('abort', abort);
      try { if (this.#cursor) {
        const cursor = this.#cursor; this.#cursor = null;
        const cleanup = new ScopedAnalysisWork({ limits: { deadlineMs: 1000 }, name: 'native-best-cleanup' });
        try { await cleanup.yieldIfNeeded(true); await cleanup.await(child => this.#service.invoke('cancelScopedQuery', { cursor }, { signal: child, limits: { deadlineMs: 1000 } })); }
        catch (error) { if (!workStopStatus(error, cleanup.signal) && !this.#service.closed) throw error; }
        finally { cleanup.dispose(); }
      } } finally { this.#active = null; }
    }
  }
  async explain({ level = 'owners' } = {}, options = {}) {
    this.#check(); if (!this.#lastArtifact) contractFail('native-best-no-published-result');
    const artifactId = this.#lastArtifact;
    const result = await this.#service.invoke('replayDemandResult', { artifactId, level }, {
      ...options, limits: { ...options.limits, deadlineMs: Math.min(options.limits?.deadlineMs ?? 10000, 120000) } });
    this.#check(result.value); return { binding: this.#binding, artifactId, replay: result.value, oracleAuthority: false };
  }
  cancel() { const active = this.#active; active?.abort(new Error('native-best-harness-cancelled')); return { requested: !!active, exact: false }; }
}
