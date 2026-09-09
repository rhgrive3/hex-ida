import { DebugSessionManager } from './session.js';
import { LocalFunctionSandboxAdapter, EmulatorAdapter, SymbolicAdapter, RemoteDebugAdapter, LLDBCompatibleAdapter, FridaCompatibleAdapter, ReplayAdapter } from '../adapters/index.js';
import { compileExperiment, HypothesisVerifier } from '../dynamic/experiments.js';
import { createRuntimeEvidenceRecord, evidenceFromExperiment, fuseStaticDynamic, traceToSemanticFacts } from '../runtime-evidence/index.js';
import { DebugAdapterError, asAddress, boundedInteger } from '../debug/adapter.js';

function runtimeAdapterName(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DebugAdapterError('invalid-adapter-name', 'adapter name must be a non-empty string');
  }
  return value;
}

function invalidExternalSignal() {
  return new DebugAdapterError('invalid-signal', 'signal must be AbortSignal-compatible');
}

function validateExternalSignal(externalSignal) {
  if (externalSignal == null) return null;
  if (typeof externalSignal !== 'object' && typeof externalSignal !== 'function') throw invalidExternalSignal();
  let addEventListener;
  let removeEventListener;
  let aborted;
  let reason;
  try {
    addEventListener = externalSignal.addEventListener;
    removeEventListener = externalSignal.removeEventListener;
    aborted = externalSignal.aborted;
    if (aborted) reason = externalSignal.reason;
  } catch {
    throw invalidExternalSignal();
  }
  if (typeof addEventListener !== 'function' || typeof removeEventListener !== 'function') throw invalidExternalSignal();
  return {
    signal:externalSignal,
    addEventListener,
    removeEventListener,
    aborted:!!aborted,
    reason:reason ?? 'cancelled',
  };
}

function operationController(session, externalSignal) {
  const authority = validateExternalSignal(externalSignal);
  const controller = session.controller();
  let listener = null;
  try {
    if (authority) {
      if (authority.aborted) controller.abort(authority.reason);
      else {
        listener = () => {
          let reason = 'cancelled';
          try { reason = authority.signal.reason ?? 'cancelled'; } catch {}
          controller.abort(reason);
        };
        Reflect.apply(authority.addEventListener, authority.signal, ['abort', listener, { once:true }]);
        let aborted;
        try { aborted = authority.signal.aborted; } catch { throw invalidExternalSignal(); }
        if (aborted) listener();
      }
    }
  } catch (error) {
    if (authority && listener) {
      try { Reflect.apply(authority.removeEventListener, authority.signal, ['abort', listener]); } catch {}
    }
    session.releaseController(controller);
    if (error instanceof DebugAdapterError && error.code === 'invalid-signal') throw error;
    throw invalidExternalSignal();
  }
  return {
    signal:controller.signal,
    abort(reason = 'cancelled') {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    release() {
      // Detachment is best-effort cleanup of a caller-owned signal; a throwing
      // removeEventListener must not mask the operation outcome, because
      // release() runs from consumer finally blocks.
      try {
        if (authority && listener) Reflect.apply(authority.removeEventListener, authority.signal, ['abort', listener]);
      } catch {}
      session.releaseController(controller);
    }
  };
}

function launchOptionsForTrace(functionAddress, options) {
  const source = options && options.launch ? options.launch : options || {};
  const launch = { ...source };
  for (const key of ['maxSteps','limit','timeoutMs','signal','onProgress','launch','attach']) delete launch[key];
  launch.address = asAddress(functionAddress);
  delete launch.functionAddress;
  return launch;
}

function runtimePositiveInteger(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) {
    throw new DebugAdapterError(`invalid-${name}`, `${name} must be a positive safe integer`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new DebugAdapterError(`invalid-${name}`, `${name} must be a positive safe integer`);
  return n;
}

function runtimeTimeout(value) {
  return value == null ? undefined : runtimePositiveInteger(value, 'timeoutMs', 60000);
}

function runtimeAbortError(signal) {
  let reason = 'cancelled';
  try { reason = signal?.reason ?? reason; } catch {}
  if (reason === 'disconnected') return new DebugAdapterError('disconnected', 'runtime field read session disconnected');
  if (reason === 'session-epoch-changed') return new DebugAdapterError('session-epoch-changed', 'runtime field read was invalidated by a newer session epoch');
  return new DebugAdapterError('cancelled', 'runtime field read cancelled');
}

// A provider may accept the signal without actually interrupting its pending
// read. Settle the caller at the boundary while retaining handlers on the
// provider promise so a late result or rejection cannot publish evidence or
// become an unhandled rejection.
function boundedRuntimeRead(read, { signal, timeoutMs, onTimeout }) {
  let timer = null;
  let abortHandler = null;
  let settled = false;
  let resolveResult;
  let rejectResult;
  const cleanup = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
    if (signal && abortHandler) {
      try { signal.removeEventListener('abort', abortHandler); } catch {}
    }
    abortHandler = null;
  };
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) rejectResult(error);
    else resolveResult(value);
  };
  return new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
    abortHandler = () => finish(runtimeAbortError(signal));
    if (signal) {
      signal.addEventListener('abort', abortHandler, { once:true });
      if (signal.aborted) {
        abortHandler();
        return;
      }
    }
    if (timeoutMs != null) {
      timer = setTimeout(() => {
        finish(new DebugAdapterError('timeout', `runtime field read timed out after ${timeoutMs} ms`, { timeoutMs }));
        try { if (typeof onTimeout === 'function') onTimeout(); } catch {}
      }, timeoutMs);
    }
    Promise.resolve().then(() => {
      if (signal?.aborted) throw runtimeAbortError(signal);
      return read();
    }).then((value) => finish(null, value), (error) => finish(error));
  });
}

function isReplayable(adapter, observation = null, trace = null) {
  if (adapter?.capabilities?.replay) return true;
  if (observation?.recordingId || observation?.recording || trace?.recordingId || trace?.recording) return true;
  return false;
}

export class RuntimeAnalysisPlatform {
  constructor(options = {}) {
    this.options = options;
    this.sessions = new DebugSessionManager(options.sessions || {});
    this.adapters = new Map();
    this.evidence = [];
    if (options.localIO) this.registerAdapter('local', new LocalFunctionSandboxAdapter(options.localIO, options.local || {}));
    if (options.symbolic !== false) this.registerAdapter('symbolic', new SymbolicAdapter(options.symbolic || {}));
  }
  registerAdapter(name, adapter) {
    if (!adapter) throw new DebugAdapterError('adapter','adapter is required');
    this.adapters.set(runtimeAdapterName(name), adapter);
    return adapter;
  }
  adapter(name = null) {
    if (name != null) return this.adapters.get(runtimeAdapterName(name)) || null;
    const session = this.sessions.current;
    if (session) return session.adapter;
    return this.adapters.get('local') || this.adapters.values().next().value || null;
  }
  createRemote(name, transport, options = {}) {
    const adapterName = runtimeAdapterName(name);
    const kind = options.kind || 'remote';
    const adapter = kind === 'lldb' ? new LLDBCompatibleAdapter(transport, options) : kind === 'frida' ? new FridaCompatibleAdapter(transport, options) : new RemoteDebugAdapter(transport, options);
    return this.registerAdapter(adapterName, adapter);
  }
  createReplay(name, recording, options = {}) {
    const adapterName = runtimeAdapterName(name);
    return this.registerAdapter(adapterName, new ReplayAdapter(recording, options));
  }
  async startSession({ adapter = null, binaryHash = null, trace = {}, connect = true } = {}) {
    const instance = adapter == null ? this.adapter() : (typeof adapter === 'string' ? this.adapter(adapter) : adapter);
    if (!instance) throw new DebugAdapterError('adapter-not-found',`debug adapter not found: ${adapter ?? '<default>'}`);
    const session = this.sessions.create(instance,{binaryHash,trace});
    if (!connect) return session;
    try { await session.connect(); return session; }
    catch (error) { try { await this.sessions.close(session.id); } catch {} throw error; }
  }
  currentSession(required = true) {
    const session = this.sessions.current;
    if (!session && required) throw new DebugAdapterError('no-session','no active runtime session');
    return session;
  }
  _recordEvidence(record) {
    if (!record) return null;
    this.evidence.push(record);
    if (this.evidence.length > 4096) this.evidence.shift();
    return record;
  }
  async runExperiment(experiment, options = {}) {
    const session = this.currentSession();
    if (!experiment || typeof experiment !== 'object' || !Array.isArray(experiment.cases)) throw new DebugAdapterError('invalid-experiment','experiment must contain cases');
    if (experiment.binaryHash && session.binaryHash && experiment.binaryHash !== session.binaryHash) throw new DebugAdapterError('binary-version-mismatch','experiment binary hash does not match the active runtime session',{experimentHash:experiment.binaryHash,sessionHash:session.binaryHash});
    const scopedExperiment = experiment.binaryHash || !session.binaryHash ? experiment : { ...experiment, binaryHash:session.binaryHash };
    session.addExperiment(scopedExperiment);
    const operation = operationController(session, options.signal);
    const verifier = new HypothesisVerifier(session.adapter, ({experiment:testExperiment,testCase,observation,comparison}) => evidenceFromExperiment({
      experiment:testExperiment,testCase,observation,comparison,backend:session.backend,binaryHash:session.binaryHash,
      sliceIdentity:this.options.sliceIdentity || null,sessionId:session.id,
      replayable:isReplayable(session.adapter,observation,observation?.trace || null)
    }));
    let result;
    try { result = await verifier.verify(scopedExperiment, { ...options, signal:operation.signal }); }
    finally { operation.release(); }
    const evidence = [];
    for (const item of result.cases) {
      if (item.evidence) { evidence.push(this._recordEvidence(item.evidence)); session.addObservation({ experimentId:scopedExperiment.id, caseId:item.case.id, evidenceId:item.evidence.id, verdict:item.comparison.status }); }
    }
    return { ...result, evidence };
  }
  async verifyHypothesis(hypothesis, options = {}) {
    const session = this.currentSession();
    // A hypothesis explicitly bound to another binary must never be re-labeled
    // onto the active session: the compiled experiment would silently pass the
    // runExperiment mismatch guard and produce evidence for the wrong binary.
    if (hypothesis?.binaryHash && session.binaryHash && hypothesis.binaryHash !== session.binaryHash) {
      throw new DebugAdapterError('binary-version-mismatch','hypothesis binary hash does not match the active runtime session',{hypothesisHash:hypothesis.binaryHash,sessionHash:session.binaryHash});
    }
    const experiment = compileExperiment(hypothesis,{ ...options,binaryHash:session.binaryHash || options.binaryHash || hypothesis?.binaryHash || null });
    return this.runExperiment(experiment, options);
  }
  async verifyFunction(functionAddress, options = {}) {
    const hypothesis = options.hypothesis || { id:`verify:${asAddress(functionAddress).toString(16)}`, functionAddress,
      fieldOffset:options.fieldOffset ?? null, fieldSize:options.fieldSize ?? 8, initial:options.initial ?? 100,
      argumentIndex:options.argumentIndex ?? 1, operation:options.operation || 'set' };
    return this.verifyHypothesis(hypothesis, options);
  }
  async traceFunction(functionAddress, options = {}) {
    const session = this.currentSession();
    const adapter = session.adapter;
    const requestedAddress = asAddress(functionAddress);
    const launchSpec = launchOptionsForTrace(requestedAddress,options);
    const operation = operationController(session,options.signal);
    const traceEpoch = session.epoch;
    const timeoutBudget = runtimeTimeout(options.timeoutMs);
    let observation = { stop:null, returnValue:null, branches:[] }, trace;
    const started = Date.now();
    try {
      if (adapter.capabilities.launch) {
        await adapter.launch(launchSpec,{signal:operation.signal});
      } else if (adapter.capabilities.attach && options.attach) {
        await adapter.attach(options.attach,{signal:operation.signal});
      } else if (!adapter.capabilities.traceFunction) {
        if (adapter.capabilities.attach) throw new DebugAdapterError('attach-target-required','adapter requires an attach target before tracing');
        throw new DebugAdapterError('unsupported','adapter cannot launch, attach, or trace an existing target');
      }
      if (adapter.capabilities.resume) {
        observation = await adapter.resume({ maxSteps:options.maxSteps ?? 20000, timeoutMs:timeoutBudget, signal:operation.signal }) || observation;
      }
      if (observation.trace) trace = observation.trace;
      else {
        if (!adapter.capabilities.traceFunction) throw new DebugAdapterError('unsupported','adapter does not provide function tracing');
        const timeoutMs = timeoutBudget == null ? undefined : Math.max(1, timeoutBudget - (Date.now() - started));
        trace = await adapter.trace({ limit:boundedInteger(options.limit,4096,1,50000,'limit'), timeoutMs, signal:operation.signal });
      }
    } finally { operation.release(); }
    if (session.epoch !== traceEpoch) {
      throw new DebugAdapterError('session-epoch-changed','runtime trace completed after the active session epoch changed',{traceEpoch,sessionEpoch:session.epoch});
    }
    const acceptance = session.acceptEvents(trace?.events == null ? [] : trace.events,traceEpoch);
    if (!acceptance.ok) {
      const rejection = {
        'closed-session': { code:'session-closed', message:'runtime trace session is closed' },
        'events-not-array': { code:'session-trace-invalid', message:'runtime trace events must be an array' },
        'wire-unsafe': { code:'session-trace-not-wire-safe', message:'runtime trace contains a non-wire-safe event' },
        'event-epoch-invalid': { code:'session-epoch-event-mismatch', message:'runtime trace contains an event with an invalid epoch' },
        'event-epoch-missing': { code:'session-epoch-event-mismatch', message:'runtime trace contains an event without a valid epoch' },
        'event-epoch-mismatch': { code:'session-epoch-event-mismatch', message:'runtime trace contains an event outside the captured session epoch' },
      }[acceptance.reason] || { code:'session-trace-invalid', message:'runtime trace event batch was rejected' };
      throw new DebugAdapterError(rejection.code,rejection.message,{traceEpoch,eventEpoch:null,reason:acceptance.reason});
    }
    const factExtraction = traceToSemanticFacts(trace,{sessionId:session.id,binaryHash:session.binaryHash,traceId:`fn:${requestedAddress.toString(16)}`});
    const facts = factExtraction.facts;
    const replayable=isReplayable(adapter,observation,trace);
    const evidence = createRuntimeEvidenceRecord({ backend:session.backend,binaryHash:session.binaryHash,sliceIdentity:this.options.sliceIdentity || null,sessionId:session.id,
      experimentId:`trace:${requestedAddress.toString(16)}`,caseId:'trace',function:requestedAddress,
      input:launchSpec,observedState:{stop:observation.stop,returnValue:observation.returnValue,factsComplete:factExtraction.complete,factExtraction:{truncated:factExtraction.truncated,processedEvents:factExtraction.processedEvents,totalEvents:factExtraction.totalEvents,reasons:factExtraction.reasons}},branchPath:observation.branches || [],
      verdict:'inconclusive',confidence:factExtraction.complete ? 0.5 : 0.35,kind:'trace',reproducibility:{replayable,runs:1,consistent:null} });
    this._recordEvidence(evidence);
    return { functionAddress:requestedAddress, observation, trace, facts, factExtraction, evidence:[evidence] };
  }
  async readRuntimeField(address, size = 8, options = {}) {
    const session = this.currentSession();
    const n = runtimePositiveInteger(size == null ? 8 : size, 'size', 4096);
    const timeoutMs = runtimeTimeout(options?.timeoutMs);
    const operation = operationController(session, options?.signal);
    const readEpoch = session.epoch;
    let bytes;
    try {
      bytes = await boundedRuntimeRead(
        () => session.adapter.readMemory(address, n, { signal:operation.signal, timeoutMs }),
        { signal:operation.signal, timeoutMs, onTimeout:() => operation.abort('timeout') },
      );
    } finally { operation.release(); }
    if (session.closed) throw new DebugAdapterError('session-closed', 'runtime field read completed after the session closed');
    if (session.epoch !== readEpoch) {
      throw new DebugAdapterError('session-epoch-changed', 'runtime field read completed after the active session epoch changed', { readEpoch, sessionEpoch:session.epoch });
    }
    if (!(bytes instanceof Uint8Array) || bytes.length !== n) throw new DebugAdapterError('short-read',`runtime field read returned ${bytes && bytes.length || 0} of ${n} bytes`);
    const replayable=isReplayable(session.adapter);
    const evidence = createRuntimeEvidenceRecord({ backend:session.backend,binaryHash:session.binaryHash,sliceIdentity:this.options.sliceIdentity || null,sessionId:session.id,
      experimentId:`read:${asAddress(address).toString(16)}`,caseId:'read',address:asAddress(address),input:{address:asAddress(address),size:n},
      observedState:{bytes:[...bytes]},verdict:'inconclusive',confidence:0.5,kind:'memory-read',reproducibility:{replayable,runs:1,consistent:null} });
    this._recordEvidence(evidence);
    return { address:asAddress(address), bytes, evidence:[evidence] };
  }
  fuse(staticCandidate, runtimeEvidence = null) { return fuseStaticDynamic(staticCandidate, runtimeEvidence || this.evidence); }
  replayShape(experimentId = null) { return this.currentSession().replayShape(experimentId); }
  async replayExperiment(recording, options = {}) {
    const session = this.currentSession();
    const source = recording || {};
    const original = source.experiment || (Array.isArray(source.experiments) ? source.experiments[0] : null);
    if (!original) throw new DebugAdapterError('replay-missing-experiment','replay recording has no experiment');
    let functionAddress = asAddress(original.functionAddress);
    const sourceHash = source.binaryHash || original.binaryHash || null;
    const targetHash = session.binaryHash || null;
    if ((!sourceHash || !targetHash) && options.allowUnverifiedBinary !== true) {
      throw new DebugAdapterError('replay-unverified-binary','replay requires source and target binary identity; pass allowUnverifiedBinary only for an explicit unsafe replay',{sourceHash,targetHash});
    }
    if (sourceHash && targetHash && sourceHash !== targetHash) {
      const resolveFunction = options.resolveFunction || this.options.resolveFunction;
      if (typeof resolveFunction !== 'function') return { status:'unsupported', reason:'binary-version-mismatch', sourceHash, targetHash, evidence:[] };
      const resolved = await resolveFunction({ functionAddress, fingerprint:original.functionFingerprint || source.functionFingerprint || null, sourceBinaryHash:sourceHash, targetBinaryHash:targetHash });
      if (resolved == null) return { status:'unsupported', reason:'function-re-resolution-failed', sourceHash, targetHash, evidence:[] };
      const rawConfidence = resolved && typeof resolved === 'object' ? (resolved.identityConfidence ?? resolved.confidence ?? resolved.score) : undefined;
      const rawMargin = resolved && typeof resolved === 'object' ? (resolved.ambiguityMargin ?? resolved.margin) : undefined;
      const confidence = typeof rawConfidence === 'number' ? rawConfidence : NaN;
      const margin = typeof rawMargin === 'number' ? rawMargin : NaN;
      const accepted = !!(resolved && typeof resolved === 'object' && resolved.accepted === true);
      const ambiguous = !!(resolved && typeof resolved === 'object' && resolved.ambiguous === true);
      const invalidMargin = rawMargin != null && !Number.isFinite(margin);
      if (!accepted || !Number.isFinite(confidence) || confidence < 0.85 || ambiguous || invalidMargin || (Number.isFinite(margin) && margin < 0.10)) {
        return { status:'unsupported', reason:'function-re-resolution-ambiguous', sourceHash, targetHash, confidence:Number.isFinite(confidence)?confidence:null, ambiguityMargin:Number.isFinite(margin)?margin:null, evidence:[] };
      }
      functionAddress = asAddress(resolved.address);
    }
    const experiment = { ...original, functionAddress, binaryHash:targetHash || sourceHash || null };
    return this.runExperiment(experiment,{ ...options,replay:true });
  }
}

export { DebugSessionManager } from './session.js';
export { LocalFunctionSandboxAdapter, EmulatorAdapter, SymbolicAdapter, RemoteDebugAdapter, LLDBCompatibleAdapter, FridaCompatibleAdapter, ReplayAdapter } from '../adapters/index.js';
export { compileExperiment, generateDifferentialInputs, compareExpected, classifyHypothesis, HypothesisVerifier } from '../dynamic/experiments.js';
export { createRuntimeEvidenceRecord, evidenceFromExperiment, traceToSemanticFacts, compareRuntimeDispatch, dynamicTypeAnnotation, fuseStaticDynamic, createRuntimeAgentTools, registerRuntimeAgentTools, RUNTIME_TOOL_NAMES } from '../runtime-evidence/index.js';
