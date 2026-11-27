/*
 * Shared bounded worker pool for lightweight Capstone-free scan workers.
 *
 * Placed directly in js/ so new URL('./scan-worker.js', import.meta.url)
 * resolves cleanly to js/scan-worker.js in both browser and userscript builds.
 */
import { computeMaxScanWorkers } from './scan-planner.js';

const DEFAULT_IDLE_TIMEOUT_MS = 15_000;

function makeAbortError(message = 'Analysis request cancelled.') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function makeStaleError() {
  const error = new Error('The analysis request belongs to a file or slice that is no longer active.');
  error.name = 'StaleRequestError';
  error.stale = true;
  return error;
}

function makeDisposedError() {
  const error = new Error('Scan worker pool has been disposed.');
  error.code = 'BACKEND_DISPOSED';
  return error;
}

function makeWorkerFailedError(event, fallback = 'Scan worker failed.') {
  const message = (event && (event.message || (event.error && event.error.message))) || fallback;
  const error = event && event.error instanceof Error ? event.error : new Error(message);
  if (!error.code) error.code = 'WORKER_FAILED';
  error.workerName = 'scan';
  return error;
}

function requestKey(epoch, requestId) {
  return `${epoch ?? 0}:${requestId ?? ''}`;
}

export class ScanWorkerPool {
  constructor(options = {}) {
    this.maxWorkers = Math.max(1, Math.floor(Number(options.maxWorkers) || computeMaxScanWorkers({ document: { hidden: false } })));
    this.idleTimeoutMs = typeof options.idleTimeoutMs === 'number' && Number.isFinite(options.idleTimeoutMs)
      ? Math.max(0, options.idleTimeoutMs)
      : DEFAULT_IDLE_TIMEOUT_MS;
    this._workerFactory = typeof options.workerFactory === 'function'
      ? options.workerFactory
      : () => new Worker(new URL('./scan-worker.js', import.meta.url));
    this.disposed = false;
    this._seq = 1;
    this._workers = new Set();
    this._queue = [];
    this._cancelledRequests = new Set();
    this._minEpoch = 0;
  }

  get activeWorkerCount() {
    return this._workers.size;
  }

  get busyWorkerCount() {
    let n = 0;
    for (const entry of this._workers) if (entry.busy) n++;
    return n;
  }

  get queuedCount() {
    return this._queue.length;
  }

  runTask({
    t,
    payload = {},
    transfer = [],
    epoch = 0,
    requestId = null,
    onProgress = null,
    priority = 0,
  }) {
    if (this.disposed) {
      const p = Promise.reject(makeDisposedError());
      p.cancel = () => {};
      return p;
    }
    if (epoch < this._minEpoch) {
      const p = Promise.reject(makeStaleError());
      p.cancel = () => {};
      return p;
    }
    if (requestId != null && this._cancelledRequests.has(requestKey(epoch, requestId))) {
      const p = Promise.reject(makeAbortError());
      p.cancel = () => {};
      return p;
    }

    const job = {
      id: this._seq++,
      t,
      payload,
      transfer,
      epoch,
      requestId,
      onProgress,
      priority: Number(priority) || 0,
      settled: false,
      cancelled: false,
      workerEntry: null,
      resolve: null,
      reject: null,
    };

    const promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });

    promise.cancel = () => {
      this._cancelJob(job, makeAbortError());
    };

    this._enqueue(job);
    this._pump();
    return promise;
  }

  cancelRequest(epoch, requestId) {
    if (requestId == null) return;
    const key = requestKey(epoch, requestId);
    if (this._cancelledRequests.size >= 4096) {
      const oldest = this._cancelledRequests.values().next().value;
      if (oldest !== undefined) this._cancelledRequests.delete(oldest);
    }
    this._cancelledRequests.add(key);

    for (let i = this._queue.length - 1; i >= 0; i--) {
      const job = this._queue[i];
      if (job.epoch === epoch && job.requestId === requestId) {
        this._queue.splice(i, 1);
        this._settleJobReject(job, makeAbortError());
      }
    }

    for (const entry of [...this._workers]) {
      if (entry.terminated) continue;
      if (entry.currentJob && entry.currentJob.epoch === epoch && entry.currentJob.requestId === requestId) {
        try {
          entry.worker.postMessage({ t: 'cancel', epoch, requestId });
        } catch {}
        const job = entry.currentJob;
        job.cancelled = true;
        this._settleJobReject(job, makeAbortError());
      }
    }
  }

  cancelEpoch(epoch) {
    const targetEpoch = epoch == null ? this._minEpoch : Number(epoch);
    if (!Number.isSafeInteger(targetEpoch)) throw new TypeError('scan-pool: epoch must be a safe integer');
    if (targetEpoch + 1 > this._minEpoch) {
      this._minEpoch = targetEpoch + 1;
      this._cancelledRequests.clear();
    }

    for (let i = this._queue.length - 1; i >= 0; i--) {
      const job = this._queue[i];
      if (job.epoch <= targetEpoch) {
        this._queue.splice(i, 1);
        this._settleJobReject(job, makeStaleError());
      }
    }

    for (const entry of [...this._workers]) {
      if (entry.terminated) continue;
      try {
        entry.worker.postMessage({ t: 'cancel', epoch: targetEpoch });
      } catch {}
      if (entry.currentJob && entry.currentJob.epoch <= targetEpoch) {
        const job = entry.currentJob;
        job.cancelled = true;
        this._settleJobReject(job, makeStaleError());
      }
    }
  }

  onMemoryPressure() {
    for (const entry of [...this._workers]) {
      if (entry.busy) {
        entry.retireWhenIdle = true;
      } else {
        this._terminateWorker(entry);
      }
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;

    const queued = this._queue.splice(0, this._queue.length);
    for (const job of queued) {
      this._settleJobReject(job, makeDisposedError());
    }

    for (const entry of [...this._workers]) {
      const job = entry.currentJob;
      entry.currentJob = null;
      this._terminateWorker(entry);
      if (job) this._settleJobReject(job, makeDisposedError());
    }
    this._cancelledRequests.clear();
  }

  _enqueue(job) {
    if (this._queue.length === 0 || job.priority <= this._queue[this._queue.length - 1].priority) {
      this._queue.push(job);
      return;
    }
    let idx = this._queue.length;
    while (idx > 0 && this._queue[idx - 1].priority < job.priority) idx--;
    this._queue.splice(idx, 0, job);
  }

  _cancelJob(job, error) {
    if (job.settled) return;
    job.cancelled = true;
    const qIdx = this._queue.indexOf(job);
    if (qIdx >= 0) {
      this._queue.splice(qIdx, 1);
      this._settleJobReject(job, error);
      return;
    }
    const entry = job.workerEntry;
    if (entry && !entry.terminated && entry.currentJob === job) {
      try {
        entry.worker.postMessage({ t: 'cancel', id: job.id, epoch: job.epoch, requestId: job.requestId });
      } catch {}
    }
    this._settleJobReject(job, error);
  }

  _settleJobResolve(job, value) {
    if (job.settled) return;
    job.settled = true;
    job.resolve(value);
  }

  _settleJobReject(job, error) {
    if (job.settled) return;
    job.settled = true;
    job.reject(error);
  }

  _effectiveWorkerCap() {
    if (typeof document !== 'undefined' && document.hidden) return 1;
    return this.maxWorkers;
  }

  _pump() {
    if (this.disposed) return;
    const cap = this._effectiveWorkerCap();

    while (this._queue.length > 0) {
      let entry = this._findIdleWorker();
      if (!entry) {
        if (this._workers.size >= cap) break;
        entry = this._spawnWorker();
        if (!entry) break;
      }

      const job = this._queue.shift();
      if (!job || job.settled) continue;
      if (job.epoch < this._minEpoch) {
        this._settleJobReject(job, makeStaleError());
        continue;
      }
      if (job.requestId != null && this._cancelledRequests.has(requestKey(job.epoch, job.requestId))) {
        this._settleJobReject(job, makeAbortError());
        continue;
      }

      this._dispatch(entry, job);
    }
  }

  _findIdleWorker() {
    for (const entry of this._workers) {
      if (!entry.busy && !entry.terminated && !entry.retireWhenIdle) return entry;
    }
    return null;
  }

  _spawnWorker() {
    let worker;
    try {
      worker = this._workerFactory();
    } catch (error) {
      const failErr = error instanceof Error ? error : new Error(String(error));
      if (!failErr.code) failErr.code = 'WORKER_FAILED';
      const hasLiveWorker = [...this._workers].some((entry) => !entry.terminated);
      if (!hasLiveWorker) {
        const queued = this._queue.splice(0, this._queue.length);
        for (const job of queued) this._settleJobReject(job, failErr);
      }
      return null;
    }

    const entry = {
      worker,
      busy: false,
      currentJob: null,
      idleTimer: null,
      retireWhenIdle: false,
      terminated: false,
    };

    worker.onmessage = (event) => this._onWorkerMessage(entry, event && event.data);
    const onFailed = (event) => this._onWorkerError(entry, event);
    worker.onerror = onFailed;
    worker.onmessageerror = onFailed;

    this._workers.add(entry);
    return entry;
  }

  _dispatch(entry, job) {
    if (entry.idleTimer != null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    entry.busy = true;
    entry.currentJob = job;
    job.workerEntry = entry;

    try {
      const msg = {
        ...job.payload,
        t: job.t,
        id: job.id,
        epoch: job.epoch,
        requestId: job.requestId,
      };
      if (job.transfer && job.transfer.length > 0) {
        entry.worker.postMessage(msg, job.transfer);
      } else {
        entry.worker.postMessage(msg);
      }
    } catch (error) {
      entry.currentJob = null;
      entry.busy = false;
      job.workerEntry = null;
      this._terminateWorker(entry);
      const failErr = error instanceof Error ? error : new Error(String(error));
      if (!failErr.code) failErr.code = 'WORKER_FAILED';
      this._settleJobReject(job, failErr);
      this._pump();
    }
  }

  _onWorkerMessage(entry, msg) {
    if (entry.terminated || !msg || typeof msg !== 'object') return;
    const job = entry.currentJob;

    if (msg.t === 'progress') {
      if (job && !job.settled && !job.cancelled && msg.id === job.id && typeof job.onProgress === 'function') {
        job.onProgress({
          done: msg.done,
          all: msg.all,
          hits: msg.hits,
          epoch: msg.epoch,
          requestId: msg.requestId,
        });
      }
      return;
    }

    if (msg.t !== 'res') return;

    if (job && msg.id === job.id) {
      entry.currentJob = null;
      entry.busy = false;
      job.workerEntry = null;

      if (!job.settled) {
        if (this.disposed) {
          this._settleJobReject(job, makeDisposedError());
        } else if (job.epoch < this._minEpoch) {
          this._settleJobReject(job, makeStaleError());
        } else if (!msg.ok) {
          const err = new Error(msg.error || 'Scan worker task failed.');
          if (msg.code) err.code = msg.code;
          this._settleJobReject(job, err);
        } else if (msg.result && msg.result.cancelled) {
          this._settleJobReject(job, makeAbortError());
        } else {
          this._settleJobResolve(job, msg.result);
        }
      }

      this._onWorkerIdle(entry);
    }
  }

  _onWorkerError(entry, event) {
    const job = entry.currentJob;
    entry.currentJob = null;
    entry.busy = false;
    if (job) job.workerEntry = null;
    this._terminateWorker(entry);
    if (job && !job.settled) {
      this._settleJobReject(job, makeWorkerFailedError(event));
    }
    this._pump();
  }

  _onWorkerIdle(entry) {
    if (entry.terminated) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (this.disposed || entry.retireWhenIdle || hidden) {
      if (hidden && !this.disposed && !entry.retireWhenIdle && this._queue.length > 0 && this._workers.size <= 1) {
        this._pump();
        if (!entry.busy && !entry.terminated) this._terminateWorker(entry);
        return;
      }
      this._terminateWorker(entry);
      if (!this.disposed && this._queue.length > 0) this._pump();
      return;
    }

    if (this._queue.length > 0) {
      this._pump();
      return;
    }

    if (entry.idleTimer != null) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (!entry.busy) this._terminateWorker(entry);
    }, this.idleTimeoutMs);
    if (typeof entry.idleTimer.unref === 'function') {
      entry.idleTimer.unref();
    }
  }

  _terminateWorker(entry) {
    if (entry.terminated) return;
    entry.terminated = true;
    entry.busy = false;
    entry.currentJob = null;
    if (entry.idleTimer != null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    this._workers.delete(entry);
    try {
      entry.worker.onmessage = null;
      entry.worker.onerror = null;
      entry.worker.onmessageerror = null;
      entry.worker.terminate();
    } catch {}
  }
}
