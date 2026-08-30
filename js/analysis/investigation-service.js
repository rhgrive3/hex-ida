import {
  InvestigationService as BaseInvestigationService,
  __investigationInternalsForTests as baseInternals,
} from './investigation-service-base.js';

export * from './investigation-service-base.js';

const SERVICES = new WeakMap();
const HEAVY_LANES = new WeakMap();
const DEFAULT_HEAVY_CONCURRENCY = 2;

function abortError(signal, message = 'Investigation cancelled') {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason == null ? message : String(signal.reason));
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}
function abortIfNeeded(signal) { if (signal?.aborted) throw abortError(signal); }

function laneFor(service) {
  let lane = HEAVY_LANES.get(service);
  if (!lane) {
    lane = { active:0, peak:0, queue:[], starts:[] };
    HEAVY_LANES.set(service, lane);
  }
  return lane;
}

function pumpLane(service) {
  const lane = laneFor(service);
  while (lane.active < DEFAULT_HEAVY_CONCURRENCY && lane.queue.length) {
    const entry = lane.queue.shift();
    if (entry.signal?.aborted) { entry.reject(abortError(entry.signal)); continue; }
    lane.active++;
    lane.peak = Math.max(lane.peak, lane.active);
    lane.starts.push(entry.label);
    entry.cleanup?.();
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => { lane.active--; pumpLane(service); });
  }
}

function runHeavy(service, label, task, signal) {
  abortIfNeeded(signal);
  return new Promise((resolve, reject) => {
    const lane = laneFor(service);
    const entry = { label, task, signal, resolve, reject, cleanup:null };
    if (signal) {
      const onAbort = () => {
        const index = lane.queue.indexOf(entry);
        if (index < 0) return;
        lane.queue.splice(index, 1);
        signal.removeEventListener('abort', onAbort);
        reject(abortError(signal));
      };
      entry.cleanup = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once:true });
    }
    lane.queue.push(entry);
    pumpLane(service);
  });
}

function progressAggregator(options, activeStages) {
  const states = new Map(activeStages.map((stage) => [stage, 0]));
  let last = 0;
  const publish = (stage, value = {}) => {
    if (!states.has(stage)) return;
    const ratio = Number(value.all) > 0 ? Math.max(0, Math.min(1, Number(value.done || 0) / Number(value.all))) : states.get(stage);
    states.set(stage, Math.max(states.get(stage), ratio));
    const aggregate = Array.from(states.values()).reduce((sum, item) => sum + item, 0) / Math.max(1, states.size);
    last = Math.max(last, aggregate);
    try { options?.onProgress?.({ ...value, phase:value.phase || stage, done:last, all:1, aggregate:true }); } catch { /* observer only */ }
  };
  return {
    options(stage) { return { ...options, onProgress:(value) => publish(stage, value) }; },
    done(stage) { publish(stage, { phase:stage, done:1, all:1 }); },
  };
}

function assertBindingCurrent(app, binding) {
  if (baseInternals.analysisBindingCurrent(app, binding)) return;
  const error = new Error('investigation-analysis-binding-changed');
  error.code = 'ANALYSIS_SNAPSHOT_STALE';
  error.stale = true;
  throw error;
}

export class InvestigationService extends BaseInvestigationService {
  async prepareGoal(goal, options = {}) {
    abortIfNeeded(options.signal);
    const shapeNeeded = baseInternals.needsShapeEvidence(goal);
    const stages = shapeNeeded ? ['metadata','strings','shapes','program'] : ['strings','program'];
    if (goal?.id === 'overview') stages.push('recognition');
    const aggregate = progressAggregator(options, stages);

    const metadataP = shapeNeeded
      ? runHeavy(this, 'metadata', () => this.ensureMetadata(aggregate.options('metadata')), options.signal)
          .then((value) => { aggregate.done('metadata'); return value; })
      : Promise.resolve({ fields:this.app.fields });

    const stringsP = runHeavy(this, 'strings', () => this.collectStrings(aggregate.options('strings')), options.signal)
      .then((value) => { aggregate.done('strings'); return value; });

    const shapesP = shapeNeeded
      ? runHeavy(this, 'shapes', () => this.collectShapes(aggregate.options('shapes')), options.signal)
          .then((value) => { aggregate.done('shapes'); return value; })
      : Promise.resolve(null);

    if (goal?.id === 'overview' && typeof this.app.ensureRecognition === 'function') {
      metadataP.then(() => runHeavy(this, 'recognition', () => this.app.ensureRecognition({
        signal:options.signal,
        priority:baseInternals.priorityOf(options),
        budget:options.budget ?? null,
        maxFunctions:350000,
        knowledgeLimit:512,
      }), options.signal).then(() => aggregate.done('recognition'))).catch(() => {});
    }

    const programP = metadataP
      .then(() => runHeavy(this, 'program', () => this.buildProgram(aggregate.options('program')), options.signal))
      .then((value) => { aggregate.done('program'); return value; });

    const [strings, program, shapes, metadata] = await Promise.all([stringsP, programP, shapesP, metadataP]);
    abortIfNeeded(options.signal);

    const binding = baseInternals.captureAnalysisBinding(this.app, {
      program,
      shapes,
      fields:metadata?.fields ?? this.app.fields,
    });
    const snapshot = await this.app.analysisQueries.snapshot({
      signal:options.signal,
      priority:baseInternals.priorityOf(options),
      budget:options.budget ?? null,
    });
    abortIfNeeded(options.signal);
    assertBindingCurrent(this.app, binding);

    const context = {
      snapshot,
      snapshotId:snapshot.snapshotId,
      strings,
      program:binding.program,
      shapes:binding.shapes,
      symbols:binding.symbols,
      fields:binding.fields,
      region:binding.region,
      binding,
    };
    context.completeness = baseInternals.completenessFor(context);
    return Object.freeze(context);
  }
}

export function investigationServiceFor(app) {
  if (!app) throw new TypeError('investigation-app-required');
  let service = SERVICES.get(app);
  if (!service) { service = new InvestigationService(app); SERVICES.set(app, service); }
  return service;
}

function boundedLaneSnapshot(service) {
  const lane = laneFor(service);
  return Object.freeze({ active:lane.active, peak:lane.peak, queued:lane.queue.length, starts:lane.starts.slice() });
}

export const __investigationInternalsForTests = Object.freeze({
  ...baseInternals,
  boundedLaneSnapshot,
  heavyConcurrency:DEFAULT_HEAVY_CONCURRENCY,
});
