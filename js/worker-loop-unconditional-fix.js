'use strict';

/* #2117: extend the #1900 backward-loop prepass to unconditional direct B edges. */
async function __backwardLoopEntryKills(region, requestId, epoch) {
  const entries = new Map();
  const total = Number(region?.size ?? 0n);
  if (!Number.isSafeInteger(total) || total <= 0) return { entries, cancelled:false };

  const functionStarts = Array.from(functionStartsForRegion(region) || [], (value) => {
    try { return typeof value === 'bigint' ? value : BigInt(value); } catch { return null; }
  }).filter((value) => value != null && value >= region.vmAddr && value < region.vmAddr + region.size)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const edgeTargets = new Map();
  const targetSet = new Set();
  const fastBranch = typeof Words.isCondBranch === 'function' && typeof Words.isBranchImm === 'function';
  const reader = typeof readScanBlock === 'function' ? readScanBlock : readRange;
  const blockSize = typeof STREAM_SCAN_BLOCK === 'number' ? STREAM_SCAN_BLOCK : 1024 * 1024;
  const maybeYield = typeof createYielder === 'function' ? createYielder(16) : yieldToQueue;
  let nextFunctionStart = 0;
  let currentFunctionStart = null;
  let pos = 0;

  while (pos < total) {
    if (cancelled(requestId, epoch)) return { entries, cancelled:true };
    const want = Math.min(blockSize, total - pos);
    const blk = await reader(region.fileOffset + BigInt(pos), want);
    if (blk.length < 4) break;
    const count = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, count * 4);
    for (let i = 0; i < count; i++) {
      const word = dv.getUint32(i * 4, true);
      const pc = region.vmAddr + BigInt(pos + i * 4);
      while (nextFunctionStart < functionStarts.length && functionStarts[nextFunctionStart] <= pc) {
        currentFunctionStart = functionStarts[nextFunctionStart++];
      }
      let target = null;
      if (fastBranch) {
        if (Words.isCondBranch(word)) target = Words.condBranchTarget(word, pc);
        else if (Words.isBranchImm(word)) target = Words.wordTarget(word, pc);
        else continue;
      } else {
        const kind = Words.classifyWord(word);
        if (kind === Words.KIND.CONDBR) target = Words.condBranchTarget(word, pc);
        else if (kind === Words.KIND.BRANCH) target = Words.wordTarget(word, pc);
        else continue;
      }
      if (target == null || target > pc) continue;
      if (target < region.vmAddr || target >= region.vmAddr + region.size) continue;
      if (currentFunctionStart != null && target < currentFunctionStart) continue;
      edgeTargets.set(pc, target);
      targetSet.add(target);
    }
    pos += count * 4;
    if (count * 4 < want) break;
    await maybeYield();
  }

  if (!targetSet.size) return { entries, cancelled:false };

  const values = new Array(32).fill(null);
  const lastWrite = new Array(32).fill(null);
  const targetValues = new Map();
  nextFunctionStart = 0;
  currentFunctionStart = null;
  pos = 0;
  while (pos < total) {
    if (cancelled(requestId, epoch)) return { entries, cancelled:true };
    const want = Math.min(blockSize, total - pos);
    const blk = await reader(region.fileOffset + BigInt(pos), want);
    if (blk.length < 4) break;
    const count = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, count * 4);
    for (let i = 0; i < count; i++) {
      const word = dv.getUint32(i * 4, true);
      const pc = region.vmAddr + BigInt(pos + i * 4);
      while (nextFunctionStart < functionStarts.length && functionStarts[nextFunctionStart] <= pc) {
        currentFunctionStart = functionStarts[nextFunctionStart++];
        values.fill(null);
        lastWrite.fill(null);
        targetValues.clear();
      }
      if (targetSet.has(pc)) targetValues.set(pc, values.slice());

      const kind = Words.classifyWord(word);
      __noteLoopProvenanceState(word, kind, pc, lastWrite, values);

      const target = edgeTargets.get(pc);
      if (target != null) {
        const before = targetValues.get(target);
        let kills = null;
        for (let reg = 0; reg < lastWrite.length; reg++) {
          const at = lastWrite[reg];
          if (at == null || at < target) continue;
          const prior = before ? before[reg] : null;
          if (prior == null || values[reg] !== prior) {
            if (!kills) kills = new Set();
            kills.add(reg);
          }
        }
        if (kills?.size) {
          const prior = entries.get(target);
          if (prior) for (const reg of prior) kills.add(reg);
          entries.set(target, kills);
        }
      }

      if (kind === Words.KIND.RET || kind === Words.KIND.TRAP || kind === Words.KIND.BRANCH) {
        values.fill(null);
        lastWrite.fill(null);
        continue;
      }
    }
    pos += count * 4;
    if (count * 4 < want) break;
    await maybeYield();
  }
  return { entries, cancelled:false };
}
