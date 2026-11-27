/**
 * HEX-DB Background Incremental Analysis Converger (§17.3)
 *
 * Budget-sliced / idle-time work queue for:
 *   - dirty-cone refresh (highest priority)
 *   - signature propagation (`sig-prop`)
 *   - struct recovery (`struct-recovery`)
 *   - HEX-SIG matching (`hexsig`)
 *   - shard compaction (`compact`)
 *
 * Immediately yields to foreground user requests (`PAUSED_FOREGROUND`) within
 * a single work item (<= 8 ms slice budget), cancels pending timers on
 * foreground start, guards against re-entrant `runSlice()`, and pauses under
 * hard/emergency memory pressure (`PAUSED_PRESSURE`).
 */

export const CONVERGER_STATE = Object.freeze({
  IDLE: 'IDLE',
  OPENING_STORE: 'OPENING_STORE',
  VERIFYING_CHECKPOINT: 'VERIFYING_CHECKPOINT',
  PHASE1_FUNC_AND_CG: 'PHASE1_FUNC_AND_CG',
  PHASE2_SIG_PROP_AND_STRUCT: 'PHASE2_SIG_PROP_AND_STRUCT',
  PHASE3_HEXSIG_INDEX: 'PHASE3_HEXSIG_INDEX',
  COMPACTING: 'COMPACTING',
  PAUSED_FOREGROUND: 'PAUSED_FOREGROUND',
  PAUSED_PRESSURE: 'PAUSED_PRESSURE',
  CONVERGED: 'CONVERGED',
  DISPOSED: 'DISPOSED',
});

export const CONVERGER_PRIORITY = Object.freeze({
  FOREGROUND_DIRTY_CONE: 0,
  SIG_PROPAGATION: 10,
  STRUCT_RECOVERY: 20,
  HEXSIG_MATCH: 30,
  COMPACTION: 40,
  LOW: 50,
});

const KIND_DEFAULT_PRIORITY = Object.freeze({
  'dirty-cone': CONVERGER_PRIORITY.FOREGROUND_DIRTY_CONE,
  'func-cg': CONVERGER_PRIORITY.SIG_PROPAGATION - 2,
  'sig-prop': CONVERGER_PRIORITY.SIG_PROPAGATION,
  'struct-recovery': CONVERGER_PRIORITY.STRUCT_RECOVERY,
  'hexsig': CONVERGER_PRIORITY.HEXSIG_MATCH,
  'compact': CONVERGER_PRIORITY.COMPACTION,
});

const KIND_TO_PHASE = Object.freeze({
  'dirty-cone': CONVERGER_STATE.PHASE2_SIG_PROP_AND_STRUCT,
  'func-cg': CONVERGER_STATE.PHASE1_FUNC_AND_CG,
  'sig-prop': CONVERGER_STATE.PHASE2_SIG_PROP_AND_STRUCT,
  'struct-recovery': CONVERGER_STATE.PHASE2_SIG_PROP_AND_STRUCT,
  'hexsig': CONVERGER_STATE.PHASE3_HEXSIG_INDEX,
  'compact': CONVERGER_STATE.COMPACTING,
});

function defaultNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export class HexDbConverger {
  constructor(options = {}) {
    this._store = options.store ?? null;
    this._sliceBudgetMs = options.sliceBudgetMs ?? 8;
    this._maxItemsPerSlice = options.maxItemsPerSlice ?? 64;
    this._checkpointEveryBatches = options.checkpointEveryBatches ?? 16;
    this._checkpointIntervalMs = options.checkpointIntervalMs ?? 2000;
    this._now = options.now ?? defaultNow;
    this._onCheckpoint = options.onCheckpoint ?? null;
    this._onStateChange = options.onStateChange ?? null;
    this._handlers = new Map(Object.entries(options.handlers ?? {}));

    this._state = CONVERGER_STATE.IDLE;
    this._queue = [];
    this._nextSeq = 1;
    this._foregroundDepth = 0;
    this._pressurePaused = false;
    this._manualPaused = false;
    this._running = false;
    this._slicing = false;
    this._timerId = null;

    this._completedCount = 0;
    this._failedCount = 0;
    this._yieldCount = 0;
    this._batchesSinceCheckpoint = 0;
    this._lastCheckpointAt = this._now();
    this._checkpointCount = 0;
    this._disposed = false;
  }

  get state() {
    return this._state;
  }

  get pendingCount() {
    return this._queue.length;
  }

  get completedCount() {
    return this._completedCount;
  }

  get yieldCount() {
    return this._yieldCount;
  }

  get isForegroundActive() {
    return this._foregroundDepth > 0;
  }

  _setState(next) {
    if (this._state === next) return;
    const prev = this._state;
    this._state = next;
    if (this._onStateChange) {
      try {
        this._onStateChange({ prev, state: next, pending: this._queue.length });
      } catch {
        // Ignore observer errors
      }
    }
  }

  registerHandler(kind, fn) {
    if (typeof fn !== 'function') {
      throw new TypeError(`HEXDB_CONVERGER_HANDLER_INVALID: ${kind}`);
    }
    this._handlers.set(String(kind), fn);
  }

  /**
   * Enqueue a work item. Lower `priority` runs earlier; ties break FIFO by `seq`.
   */
  enqueue(task) {
    if (this._disposed) {
      throw new Error('HEXDB_CONVERGER_DISPOSED');
    }
    const kind = String(task.kind ?? 'sig-prop');
    const priority = typeof task.priority === 'number'
      ? task.priority
      : (KIND_DEFAULT_PRIORITY[kind] ?? CONVERGER_PRIORITY.LOW);
    const seq = this._nextSeq++;
    const item = {
      id: task.id ?? `job-${seq}`,
      kind,
      priority,
      seq,
      payload: task.payload ?? null,
      run: typeof task.run === 'function' ? task.run : null,
    };

    let lo = 0;
    let hi = this._queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const cur = this._queue[mid];
      if (cur.priority < item.priority || (cur.priority === item.priority && cur.seq < item.seq)) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this._queue.splice(lo, 0, item);

    if (this._state === CONVERGER_STATE.CONVERGED || this._state === CONVERGER_STATE.IDLE) {
      if (this._foregroundDepth > 0) {
        this._setState(CONVERGER_STATE.PAUSED_FOREGROUND);
      } else if (this._pressurePaused) {
        this._setState(CONVERGER_STATE.PAUSED_PRESSURE);
      } else {
        this._setState(KIND_TO_PHASE[kind] ?? CONVERGER_STATE.PHASE2_SIG_PROP_AND_STRUCT);
      }
    }

    if (this._running) {
      this._scheduleNextSlice();
    }

    return item.id;
  }

  /**
   * Signal that a foreground user request has started; immediately yields background work
   * and clears any scheduled background timer.
   */
  notifyForegroundStart() {
    if (this._disposed) return;
    this._foregroundDepth += 1;
    this._clearTimer();
    if (this._foregroundDepth === 1) {
      this._yieldCount += 1;
      if (this._state !== CONVERGER_STATE.IDLE && this._state !== CONVERGER_STATE.CONVERGED) {
        this._setState(CONVERGER_STATE.PAUSED_FOREGROUND);
      }
    }
  }

  /**
   * Signal that a foreground user request has finished.
   */
  notifyForegroundEnd() {
    if (this._disposed) return;
    if (this._foregroundDepth > 0) {
      this._foregroundDepth -= 1;
    }
    if (this._foregroundDepth === 0) {
      if (this._pressurePaused) {
        this._setState(CONVERGER_STATE.PAUSED_PRESSURE);
      } else if (this._queue.length > 0 && !this._manualPaused) {
        this._setState(KIND_TO_PHASE[this._queue[0].kind] ?? CONVERGER_STATE.PHASE2_SIG_PROP_AND_STRUCT);
        if (this._running) this._scheduleNextSlice();
      } else if (this._queue.length === 0 && this._completedCount > 0) {
        this._setState(CONVERGER_STATE.CONVERGED);
      } else {
        this._setState(CONVERGER_STATE.IDLE);
      }
    }
  }

  pauseForPressure() {
    if (this._disposed) return;
    this._pressurePaused = true;
    this._clearTimer();
    if (this._state !== CONVERGER_STATE.IDLE && this._state !== CONVERGER_STATE.CONVERGED) {
      this._setState(CONVERGER_STATE.PAUSED_PRESSURE);
    }
  }

  resumeFromPressure() {
    if (this._disposed) return;
    this._pressurePaused = false;
    if (this._foregroundDepth > 0) {
      this._setState(CONVERGER_STATE.PAUSED_FOREGROUND);
      return;
    }
    if (this._queue.length > 0 && !this._manualPaused) {
      this._setState(KIND_TO_PHASE[this._queue[0].kind] ?? CONVERGER_STATE.PHASE2_SIG_PROP_AND_STRUCT);
      if (this._running) this._scheduleNextSlice();
    }
  }

  pause() {
    this._manualPaused = true;
    this._clearTimer();
  }

  resume() {
    if (this._disposed) return;
    this._manualPaused = false;
    if (this._running && this._queue.length > 0) {
      this._scheduleNextSlice();
    }
  }

  /**
   * Execute one budget-sliced batch of queued work items.
   * Guarded against re-entrancy (`_slicing`), immediately yields on foreground
   * or pressure, and only checkpoints when foreground is inactive and not pressure-paused.
   */
  async runSlice(budgetMs = this._sliceBudgetMs, maxItems = this._maxItemsPerSlice) {
    if (this._disposed) {
      return { processed: 0, remaining: this._queue.length, yielded: false, state: this._state };
    }
    if (this._slicing) {
      return { processed: 0, remaining: this._queue.length, yielded: true, reason: 'reentrant', state: this._state };
    }
    if (this._foregroundDepth > 0) {
      this._setState(CONVERGER_STATE.PAUSED_FOREGROUND);
      return { processed: 0, remaining: this._queue.length, yielded: true, reason: 'foreground', state: this._state };
    }
    if (this._pressurePaused) {
      this._setState(CONVERGER_STATE.PAUSED_PRESSURE);
      return { processed: 0, remaining: this._queue.length, yielded: true, reason: 'pressure', state: this._state };
    }
    if (this._manualPaused) {
      return { processed: 0, remaining: this._queue.length, yielded: true, reason: 'paused', state: this._state };
    }
    if (this._queue.length === 0) {
      if (this._completedCount > 0) this._setState(CONVERGER_STATE.CONVERGED);
      return { processed: 0, remaining: 0, yielded: false, state: this._state };
    }

    this._slicing = true;
    try {
      const startMs = this._now();
      let processed = 0;
      let yielded = false;
      let yieldReason = null;

      while (this._queue.length > 0 && processed < maxItems) {
        if (this._foregroundDepth > 0) {
          this._setState(CONVERGER_STATE.PAUSED_FOREGROUND);
          yielded = true;
          yieldReason = 'foreground';
          break;
        }
        if (this._pressurePaused) {
          this._setState(CONVERGER_STATE.PAUSED_PRESSURE);
          yielded = true;
          yieldReason = 'pressure';
          break;
        }
        if (processed > 0 && (this._now() - startMs) >= budgetMs) {
          yielded = true;
          yieldReason = 'budget';
          break;
        }

        const item = this._queue.shift();
        this._setState(KIND_TO_PHASE[item.kind] ?? CONVERGER_STATE.PHASE2_SIG_PROP_AND_STRUCT);

        try {
          const fn = item.run ?? this._handlers.get(item.kind);
          if (fn) {
            await fn(item.payload, { store: this._store, task: item, converger: this });
          }
          this._completedCount += 1;
        } catch {
          this._failedCount += 1;
        }
        processed += 1;

        if (this._foregroundDepth > 0) {
          this._setState(CONVERGER_STATE.PAUSED_FOREGROUND);
          yielded = true;
          yieldReason = 'foreground';
          break;
        }
        if (this._pressurePaused) {
          this._setState(CONVERGER_STATE.PAUSED_PRESSURE);
          yielded = true;
          yieldReason = 'pressure';
          break;
        }
      }

      if (processed > 0 && this._foregroundDepth === 0 && !this._pressurePaused) {
        this._batchesSinceCheckpoint += 1;
        const now = this._now();
        const shouldCheckpoint = this._batchesSinceCheckpoint >= this._checkpointEveryBatches
          || (now - this._lastCheckpointAt) >= this._checkpointIntervalMs
          || this._queue.length === 0;
        if (shouldCheckpoint) {
          await this._triggerCheckpoint();
        }
      }

      if (this._queue.length === 0 && this._foregroundDepth === 0 && !this._pressurePaused) {
        this._setState(CONVERGER_STATE.CONVERGED);
      }

      return {
        processed,
        remaining: this._queue.length,
        yielded,
        reason: yieldReason,
        state: this._state,
      };
    } finally {
      this._slicing = false;
    }
  }

  async _triggerCheckpoint() {
    this._batchesSinceCheckpoint = 0;
    this._lastCheckpointAt = this._now();
    this._checkpointCount += 1;
    if (this._store && typeof this._store.checkpoint === 'function') {
      try {
        await this._store.checkpoint();
      } catch {
        // Store might not be open yet in standalone converger tests
      }
    }
    if (this._onCheckpoint) {
      try {
        await this._onCheckpoint(this.getProgress());
      } catch {
        // Ignore callback errors
      }
    }
  }

  _clearTimer() {
    if (this._timerId != null) {
      clearTimeout(this._timerId);
      this._timerId = null;
    }
  }

  _scheduleNextSlice() {
    if (!this._running || this._disposed || this._timerId != null) return;
    if (this._queue.length === 0 || this._foregroundDepth > 0 || this._pressurePaused || this._manualPaused) {
      return;
    }
    this._timerId = setTimeout(async () => {
      this._timerId = null;
      if (!this._running || this._disposed) return;
      await this.runSlice();
      if (this._running && this._queue.length > 0 && this._foregroundDepth === 0 && !this._pressurePaused && !this._manualPaused) {
        this._scheduleNextSlice();
      }
    }, 0);
  }

  start() {
    if (this._disposed) return;
    this._running = true;
    this._manualPaused = false;
    this._scheduleNextSlice();
  }

  stop() {
    this._running = false;
    this._clearTimer();
  }

  getProgress() {
    return Object.freeze({
      state: this._state,
      pending: this._queue.length,
      completed: this._completedCount,
      failed: this._failedCount,
      yieldCount: this._yieldCount,
      checkpointCount: this._checkpointCount,
      foregroundActive: this._foregroundDepth > 0,
      pressurePaused: this._pressurePaused,
      running: this._running,
      slicing: this._slicing,
    });
  }

  dispose() {
    this.stop();
    this._queue.length = 0;
    this._disposed = true;
    this._setState(CONVERGER_STATE.DISPOSED);
  }
}
