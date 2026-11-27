'use strict';

importScripts('./words.js', './worker-budget.js', './address-provenance.js', './scan-core.js');

let currentEpoch = 0;
const cancelledRequests = new Set();
const activeJobIds = new Set();
const cancelledJobIds = new Set();

function requestKey(epoch, requestId) {
  return `${epoch ?? 0}:${requestId ?? ''}`;
}

function isCancelled(requestId, epoch, id) {
  if (epoch != null && epoch < currentEpoch) return true;
  if (id != null && cancelledJobIds.has(id)) return true;
  if (requestId != null && cancelledRequests.has(requestKey(epoch, requestId))) return true;
  return false;
}

async function handleTask(msg) {
  const { t, id, epoch, requestId } = msg;
  if (epoch != null && epoch > currentEpoch) {
    currentEpoch = epoch;
    cancelledRequests.clear();
    cancelledJobIds.clear();
  }
  if (id != null) activeJobIds.add(id);
  try {
  const checkCancelled = () => isCancelled(requestId, epoch, id);
  if (checkCancelled()) {
    self.postMessage({ t: 'res', id, epoch, requestId, ok: true, result: { cancelled: true } });
    return;
  }

  const onProgress = (done, all, hits) => {
    if (checkCancelled()) return;
    self.postMessage({ t: 'progress', id, epoch, requestId, done, all, hits });
  };

  let result;
  if (t === 'scanStage1') {
    result = await globalThis.HexScanCore.scanStage1Chunk({
      file: msg.file,
      region: msg.region,
      chunkStart: msg.chunkStart,
      chunkEnd: msg.chunkEnd,
      chunkIndex: msg.chunkIndex,
      functionStarts: msg.functionStarts,
      isCancelled: checkCancelled,
      onProgress,
    });
  } else if (t === 'scanProgramChunk') {
    result = await globalThis.HexScanCore.scanProgramChunk({
      file: msg.file,
      region: msg.region,
      chunkStart: msg.chunkStart,
      chunkEnd: msg.chunkEnd,
      chunkIndex: msg.chunkIndex,
      functionStarts: msg.functionStarts,
      incomingForwardTargets: msg.incomingForwardTargets,
      loopKillAddrs: msg.loopKillAddrs,
      loopKillMasks: msg.loopKillMasks,
      stringRanges: msg.stringRanges,
      callLimit: msg.callLimit,
      refLimit: msg.refLimit,
      globalKindCap: msg.globalKindCap,
      chunkBudgetBytes: msg.chunkBudgetBytes,
      isCancelled: checkCancelled,
      onProgress,
    });
  } else if (t === 'scanShapesChunk') {
    result = await globalThis.HexScanCore.scanValueShapesChunk({
      file: msg.file,
      region: msg.region,
      chunkStart: msg.chunkStart,
      chunkEnd: msg.chunkEnd,
      chunkIndex: msg.chunkIndex,
      shapeLimit: msg.shapeLimit,
      isCancelled: checkCancelled,
      onProgress,
    });
  } else {
    throw new Error(`Unknown scan-worker request: ${String(t)}`);
  }

  const transfer = Array.isArray(result && result.__transfer) ? result.__transfer : [];
  if (result && Object.prototype.hasOwnProperty.call(result, '__transfer')) {
    delete result.__transfer;
  }
  self.postMessage({ t: 'res', id, epoch, requestId, ok: true, result }, transfer);
  } finally {
    if (id != null) {
      activeJobIds.delete(id);
      cancelledJobIds.delete(id);
    }
  }
}

self.onmessage = function onScanWorkerMessage(event) {
  const msg = event && event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.t === 'cancel') {
    if (msg.id != null) {
      if (activeJobIds.has(msg.id)) {
        cancelledJobIds.add(msg.id);
      }
    } else if (msg.requestId != null) {
      cancelledRequests.add(requestKey(msg.epoch, msg.requestId));
    } else if (msg.epoch != null) {
      if (msg.epoch + 1 > currentEpoch) {
        currentEpoch = msg.epoch + 1;
        cancelledRequests.clear();
        cancelledJobIds.clear();
      }
    } else {
      currentEpoch++;
      cancelledRequests.clear();
      cancelledJobIds.clear();
    }
    return;
  }

  handleTask(msg).catch((err) => {
    self.postMessage({
      t: 'res',
      id: msg.id,
      epoch: msg.epoch,
      requestId: msg.requestId,
      ok: false,
      error: (err && err.message) || String(err),
      code: (err && err.code) || null,
    });
  });
};
