import { DebugAdapterError, boundedInteger } from '../debug/adapter.js';
import { deepFreeze } from '../core/identity/index.js';
import { RuntimeProviderSession, createRuntimeProviderDescriptor } from './provider.js';
import { createRuntimeEvent, createRuntimeEventBatch } from './events.js';
import { RuntimeEvidenceBridge } from './evidence-bridge.js';

const TERMINATIONS = Object.freeze(['return', 'halted', 'paused', 'fault', 'unsupported', 'timeout', 'cancelled', 'exception']);
const ABORTED_EXECUTION = Symbol('aborted-execution');

function terminationAlias(raw) {
  switch (raw) {
    case 'limit': return 'timeout';
    case 'cancel': return 'cancelled';
    case 'crash':
    case 'oob':
    case 'unmapped': return 'fault';
    case 'complete':
    case 'success': return 'return';
    default: return null;
  }
}

function ownedClone(value) {
  if (typeof value === 'function' || typeof value === 'symbol') throw new TypeError('value is not replay-recordable');
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(ownedClone);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) return new value.constructor(value);
  if (value instanceof Date) return new Date(value.getTime());
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(out, key, { value: ownedClone(item), enumerable: true, configurable: true, writable: true });
  }
  return out;
}

function recordableClone(value) {
  try {
    return ownedClone(value);
  } catch (error) {
    throw new DebugAdapterError('emulator-replay-options-invalid', `replay options are not recordable: ${String(error?.message || error)}`);
  }
}

function terminationOf(result = {}) {
  const value = result.termination ?? result.stop?.kind ?? result.status ?? 'paused';
  if (typeof value !== 'string') return 'exception';
  const raw = value.trim().toLowerCase();
  if (TERMINATIONS.includes(raw)) return raw;
  return terminationAlias(raw) ?? 'exception';
}

function completenessFor(termination) {
  if (termination === 'unsupported') return 'unsupported';
  if (termination === 'timeout' || termination === 'cancelled' || termination === 'exception') return 'truncated';
  return 'bounded';
}

function engineText(value, fallback, code) {
  const resolved = value ?? fallback;
  if (typeof resolved !== 'string' || !resolved.trim()) {
    throw new DebugAdapterError(code, code === 'emulator-engine-id-invalid'
      ? 'emulator engine id must be a non-empty string'
      : 'emulator engine version must be a non-empty string');
  }
  return resolved;
}

function deterministicFlag(value) {
  // Determinism is a positive capability: an engine that never declared it is
  // unknown, not deterministic, and must not gain the replay capability (#5983).
  if (value == null) return false;
  if (typeof value !== 'boolean') throw new DebugAdapterError('emulator-deterministic-invalid', 'emulator deterministic flag must be a boolean');
  return value;
}

function fallbackStreamId(runOccurrence, sourceStreamId = null) {
  const sourcePart = sourceStreamId == null ? '' : `:source:${sourceStreamId}`;
  return `emulator:run:${runOccurrence}${sourcePart}`;
}

function eventIdentity(source, index, runOccurrence) {
  const providerEventId = source.providerEventId ?? source.id;
  const hasProviderEventId = providerEventId != null;
  const hasExplicitStreamSequence = source.streamId != null && source.sequence != null;
  // Provider event IDs are already the engine's stable identity. Keep the
  // historical fallback stream when no stream was supplied so adding a run
  // namespace cannot change the digest for providerEventId-only events.
  let streamId = source.streamId ?? (hasProviderEventId ? 'emulator' : fallbackStreamId(runOccurrence));
  // A complete engine-supplied stream/sequence pair (or provider event ID)
  // owns its identity. When either half is absent, the provider's generated
  // fallback must include this run occurrence (#5929).
  if (!hasProviderEventId && !hasExplicitStreamSequence && source.streamId != null) {
    streamId = typeof source.streamId === 'string' && source.streamId.trim()
      ? fallbackStreamId(runOccurrence, source.streamId)
      : source.streamId;
  }
  return {
    streamId,
    sequence: source.sequence ?? index,
    providerEventId,
  };
}

function normalizeEngineDescriptor(engine, options) {
  const source = typeof engine?.descriptor === 'function' ? engine.descriptor() : {};
  return deepFreeze({
    id: engineText(options.engineId ?? source.id ?? engine?.id, 'emulator', 'emulator-engine-id-invalid'),
    version: engineText(options.engineVersion ?? source.version ?? engine?.version, 'unknown', 'emulator-engine-version-invalid'),
    architecture: options.architecture ?? source.architecture ?? null,
    environment: options.environment ?? source.environment ?? 'unknown',
    deterministic: deterministicFlag(options.deterministic ?? source.deterministic ?? engine?.deterministic),
  });
}

async function boundedEngineOperation(operation, signal, registerSettlement = null) {
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve(ABORTED_EXECUTION);
    if (signal.aborted) resolve(ABORTED_EXECUTION);
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  // Observe both outcomes explicitly. A signal-ignoring engine may settle
  // after the provider has already returned its bounded cancellation result;
  // attaching the rejection branch here prevents that late failure from
  // becoming an unhandled rejection (#4385).
  const execution = Promise.resolve()
    .then(() => signal.aborted ? ABORTED_EXECUTION : operation())
    .then(
      (value) => value === ABORTED_EXECUTION ? { kind: 'aborted' } : { kind: 'completed', value },
      (error) => ({ kind: 'failed', error }),
    );
  if (registerSettlement) registerSettlement(execution);
  try {
    return await Promise.race([execution, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export class EmulatorProvider {
  constructor(engine, options = {}) {
    if (!engine || (typeof engine.execute !== 'function' && (typeof engine.launch !== 'function' || typeof engine.resume !== 'function'))) {
      throw new DebugAdapterError('emulator-engine-required', 'EmulatorProvider requires execute() or launch()+resume()');
    }
    this.engine = engine;
    this.options = options;
    this.engineDescriptor = normalizeEngineDescriptor(engine, options);
    this.activeSession = null;
    this.pendingEngineOperation = null;
    this._descriptor = createRuntimeProviderDescriptor({
      id: options.id ?? `emulator:${this.engineDescriptor.id}`,
      version: options.version ?? '1',
      kind: 'emulator',
      facets: ['emulator'],
      capabilities: {
        execute: true,
        replay: this.engineDescriptor.deterministic === true,
        syntheticEvidence: true,
      },
    });
  }

  descriptor() { return this._descriptor; }

  _registerEngineOperation(settlement) {
    this.pendingEngineOperation = settlement;
    settlement.finally(() => {
      if (this.pendingEngineOperation === settlement) this.pendingEngineOperation = null;
    });
  }

  _assertEngineAvailable() {
    if (this.pendingEngineOperation) {
      throw new DebugAdapterError('emulator-engine-busy', 'emulator engine still has an unsettled operation from a prior run');
    }
  }

  async openSession(request = {}, options = {}) {
    if (this.activeSession && !this.activeSession.closed) throw new DebugAdapterError('runtime-session-active', 'emulator provider already has an open session');
    this._assertEngineAvailable();
    let session;
    let connectedBySession = false;
    session = new RuntimeProviderSession({
      provider: this,
      request,
      close: async () => {
        if (connectedBySession && typeof this.engine.disconnect === 'function') await this.engine.disconnect();
        if (this.activeSession === session) this.activeSession = null;
      },
    });
    // Claim provider ownership before the first await. A second open must not
    // race through while this session is still connecting.
    this.activeSession = session;
    try {
      if (options.connect !== false && typeof this.engine.connect === 'function') {
        connectedBySession = true;
        await this.engine.connect(options.connectOptions || {});
      }
    } catch (error) {
      session.setState('failed');
      try { await session.close(); } catch {}
      throw error;
    }
    const evidence = new RuntimeEvidenceBridge();
    let lastRun = null;
    let activeRun = null;
    let nextRunOccurrence = 0;

    const run = async (input = {}, runOptions = {}) => {
      if (activeRun) throw new DebugAdapterError('already-running', 'emulator session already has an active run');
      this._assertEngineAvailable();
      const runToken = {};
      activeRun = runToken;
      try {
      const maxSteps = boundedInteger(runOptions.maxSteps, 20000, 1, 1000000, 'maxSteps');
      const timeoutMs = boundedInteger(runOptions.timeoutMs, 2000, 10, 60000, 'timeoutMs');
      const { signal: _nonReplayableSignal, ...replayableRunOptions } = runOptions;
      const replayOptions = { ...replayableRunOptions, maxSteps, timeoutMs };
      // Snapshot replay-effective options before engine execution. A callback,
      // symbol, Proxy, or other non-cloneable option must fail closed before
      // the engine can succeed and only then make run() throw while recording.
      const recordedOptions = recordableClone(replayOptions);
      const runOccurrence = ++nextRunOccurrence;
      const controller = session.controller();
      // The run's identity is fixed at start: a late completion (engine that
      // ignored the abort) must never be re-labelled as the current epoch's
      // normal observation (#5878).
      const startedEpoch = session.epoch;
      let externalAbort = null;
      let externalCancelled = false;
      if (runOptions.signal) {
        externalAbort = () => {
          externalCancelled = true;
          if (!controller.signal.aborted) controller.abort('cancelled');
        };
        if (runOptions.signal.aborted) externalAbort();
        else {
          runOptions.signal.addEventListener('abort', externalAbort, { once: true });
          if (runOptions.signal.aborted) externalAbort();
        }
      }
      let timeoutTriggered = false;
      let timer = null;
      if (!controller.signal.aborted) {
        timer = setTimeout(() => {
          if (controller.signal.aborted) return;
          timeoutTriggered = true;
          controller.abort('timeout');
        }, timeoutMs);
      }
      session.setState('running');
      let raw;
      let abortTermination = null;
      try {
        if (controller.signal.aborted) raw = { stop: { kind: timeoutTriggered ? 'timeout' : 'cancelled' } };
        else if (typeof this.engine.execute === 'function') {
          const outcome = await boundedEngineOperation(
            () => this.engine.execute(input, { ...replayOptions, signal: controller.signal }),
            controller.signal,
            (settlement) => this._registerEngineOperation(settlement),
          );
          if (outcome.kind === 'aborted') raw = { stop: { kind: timeoutTriggered ? 'timeout' : 'cancelled' } };
          else if (outcome.kind === 'failed') throw outcome.error;
          else raw = outcome.value;
        }
        else {
          const launch = await boundedEngineOperation(
            () => this.engine.launch(input, { signal: controller.signal }),
            controller.signal,
            (settlement) => this._registerEngineOperation(settlement),
          );
          if (launch.kind === 'aborted') raw = { stop: { kind: timeoutTriggered ? 'timeout' : 'cancelled' } };
          else if (launch.kind === 'failed') throw launch.error;
          else {
            const resume = await boundedEngineOperation(
              () => this.engine.resume({ ...replayOptions, signal: controller.signal }),
              controller.signal,
              (settlement) => this._registerEngineOperation(settlement),
            );
            if (resume.kind === 'aborted') raw = { stop: { kind: timeoutTriggered ? 'timeout' : 'cancelled' } };
            else if (resume.kind === 'failed') throw resume.error;
            else raw = resume.value;
          }
        }
      } catch (error) {
        if (controller.signal.aborted) raw = { stop: { kind: timeoutTriggered ? 'timeout' : 'cancelled' }, error: String(error?.message || error) };
        else raw = { stop: { kind: 'exception' }, error: String(error?.message || error) };
      } finally {
        if (timeoutTriggered) abortTermination = 'timeout';
        else if (externalCancelled || controller.signal.aborted) abortTermination = 'cancelled';
        if (timer) clearTimeout(timer);
        if (runOptions.signal && externalAbort) runOptions.signal.removeEventListener('abort', externalAbort);
        session.releaseController(controller);
      }

      const termination = abortTermination ?? terminationOf(raw || {});
      const completeness = completenessFor(termination);
      if (session.closed || session.state === 'closing') {
        throw new DebugAdapterError('runtime-session-stale', 'emulator run completed after its runtime session began closing', {
          termination,
          completeness,
        });
      }
      // Fail closed on epoch change: events/evidence derived from a stale
      // execution belong to the dead epoch and must not enter the new epoch's
      // stream, session state, or evidence bridge (#5878).
      if (session.epoch !== startedEpoch) {
        throw new DebugAdapterError('runtime-session-stale', 'emulator run completed after its runtime epoch changed', {
          startedEpoch,
          currentEpoch: session.epoch,
          termination,
          completeness,
        });
      }
      const eventSource = raw?.events != null ? raw.events : raw?.trace?.events;
      if (eventSource != null && !Array.isArray(eventSource)) {
        session.setState('degraded');
        throw new DebugAdapterError('emulator-invalid-events', 'emulator engine events must be an array');
      }
      const sourceEvents = eventSource ?? [];
      session.setState(termination === 'paused' ? 'paused' : termination === 'exception' ? 'degraded' : 'ready');
      const events = sourceEvents.map((source, index) => {
        const identity = eventIdentity(source, index, runOccurrence);
        return createRuntimeEvent({
          runtimeSessionId: session.runtimeSessionId,
          providerId: session.providerId,
          providerVersion: session.providerVersion,
          sessionEpoch: session.epoch,
          streamId: identity.streamId,
          sequence: identity.sequence,
          providerEventId: identity.providerEventId,
          timestamp: source.timestamp,
          processKey: session.target.processKey,
          moduleBindingKey: source.moduleBindingKey,
          moduleGeneration: source.moduleGeneration,
          kind: source.kind ?? source.type ?? 'emulator-checkpoint',
          payload: source.payload ?? source,
          observationMode: 'synthetic',
          completeness,
          interventionIds: source.interventionIds,
        });
      });
      if (!events.length) {
        events.push(createRuntimeEvent({
          runtimeSessionId: session.runtimeSessionId,
          providerId: session.providerId,
          providerVersion: session.providerVersion,
          sessionEpoch: session.epoch,
          streamId: fallbackStreamId(runOccurrence),
          sequence: 0,
          processKey: session.target.processKey,
          kind: 'emulator-checkpoint',
          payload: { termination, result: raw ?? null, engine: this.engineDescriptor },
          observationMode: 'synthetic',
          completeness,
        }));
      }
      const batch = createRuntimeEventBatch({
        runtimeSessionId: session.runtimeSessionId,
        providerId: session.providerId,
        sessionEpoch: session.epoch,
        events,
        completeness,
        dropped: 0,
      });
      const resolution = runOptions.resolution ?? null;
      const evidenceNodes = events.map((event) => evidence.eventToEvidence(event, resolution, { binaryId: request.binaryId ?? request.binaryHash ?? null, semanticKind: 'emulator-observation' }));
      const ownedRaw = ownedClone(raw ?? null);
      lastRun = deepFreeze({ input: ownedClone(input), options: recordedOptions, termination, completeness, raw: ownedRaw, eventIds: events.map((event) => event.eventId) });
      return deepFreeze({ termination, completeness, raw: ownedClone(ownedRaw), batch, evidence: evidenceNodes, recording: lastRun });
      } finally {
        if (activeRun === runToken) activeRun = null;
      }
    };

    const emulator = Object.freeze({
      engine: this.engineDescriptor,
      run,
      replay: async (recording = null, replayOptions = {}) => {
        if (this.engineDescriptor.deterministic !== true) throw new DebugAdapterError('unsupported', 'emulator engine does not advertise deterministic replay');
        const source = recording ?? lastRun;
        if (!source) throw new DebugAdapterError('emulator-replay-missing', 'no emulator recording is available to replay');
        return run(source.input, { ...source.options, ...replayOptions });
      },
      evidence,
    });
    session.facets = Object.freeze({ emulator });
    session.setState('ready');
    this.activeSession = session;
    return session;
  }
}

export function createEmulatorProvider(engine, options = {}) { return new EmulatorProvider(engine, options); }
