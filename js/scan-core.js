/*
 * Shared Capstone-free ARM64 scan core for parallel scan workers and Node VM
 * equivalence tests.
 *
 * Classic-script IIFE shape on purpose (loaded via importScripts in
 * js/scan-worker.js) while remaining valid under ESM-goal strict parsing
 * (new vm.SourceTextModule in tests/check.mjs).
 */
(function (global) {
  'use strict';

  const STREAM_SCAN_BLOCK = 4 * 1024 * 1024;
  const PAIR_WINDOW = Number.MAX_SAFE_INTEGER;
  const MAX_EDGES = 8_000_000;
  const MAX_REFS = 8_000_000;
  const MAX_KIND_WORDS = 16 * 1024 * 1024;
  const CHUNK_EDGES_INITIAL = 16_384;
  const MAX_SHAPE_EVENTS = 200_000;
  const CHUNK_SHAPES_INITIAL = 4_096;
  const PROGRAM_INDEX_BUDGET_BYTES =
    (global.HexWorkerBudget && global.HexWorkerBudget.PROGRAM_INDEX_BYTES) ||
    (96 * 1024 * 1024);

  const SHAPE_DECREASE = 1;
  const SHAPE_INCREASE = 2;
  const SHAPE_CLAMP = 4;
  const SHAPE_CROSS = 8;
  const SHAPE_SCALED = 16;
  const SHAPE_ATOMIC_RMW = 32;

  const AMT_NONE = 0;
  const AMT_FIELD = 1;
  const AMT_IMM = 2;
  const AMT_CALL = 3;

  function buildWritesLowReg(Words) {
    const K = Words.KIND;
    const t = new Uint8Array(64).fill(1);
    for (const k of [
      K.NOP, K.CONDBR, K.CMP, K.BRANCH, K.CALL, K.INDCALL, K.RET,
      K.STORE, K.SYS, K.TRAP,
    ]) {
      t[k] = 0;
    }
    return t;
  }

  const WRITES_LOW_REG = global.Words ? buildWritesLowReg(global.Words) : null;

  function resolveWords(ctx) {
    const Words = (ctx && ctx.words) || global.Words;
    if (!Words || !Words.KIND) throw new Error('HexScanCore requires Words');
    return Words;
  }

  function resolveWritesLowReg(Words) {
    if (Words === global.Words && WRITES_LOW_REG) return WRITES_LOW_REG;
    return buildWritesLowReg(Words);
  }

  function canonicalProgramKind(w, fastKind, wordsObj) {
    const Words = wordsObj || global.Words;
    const K = Words.KIND;
    const u = w >>> 0;
    if (u === 0) return K.TRAP;
    if (((u & 0x7f20001f) >>> 0) === 0x6a20001f) return K.LOGIC;
    if (((u & 0x7f800000) >>> 0) === 0x13800000) return K.SHIFT;
    if (((u & 0x5f200000) >>> 0) === 0x1e000000) return K.FCONV;
    if (((u & 0xff3fe000) >>> 0) === 0x04000000) return K.ARITH;
    return fastKind === K.LITERAL ? K.LOAD : fastKind;
  }

  function inSortedRanges(addr, sortedRanges) {
    if (!sortedRanges || sortedRanges.length === 0) return false;
    let lo = 0;
    let hi = sortedRanges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const r = sortedRanges[mid];
      if (addr < r.start) {
        hi = mid - 1;
      } else if (addr >= r.end) {
        lo = mid + 1;
      } else {
        return true;
      }
    }
    return false;
  }

  function normalizeSortedRanges(ranges) {
    if (!ranges || ranges.length === 0) return [];
    const out = [];
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      if (!r) continue;
      const start = typeof r.start === 'bigint' ? r.start : BigInt(r.start);
      const end = typeof r.end === 'bigint' ? r.end : BigInt(r.end);
      if (end > start) out.push({ start, end });
    }
    if (out.length <= 1) return out;
    out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : (a.end < b.end ? -1 : a.end > b.end ? 1 : 0)));
    const merged = [out[0]];
    for (let i = 1; i < out.length; i++) {
      const prev = merged[merged.length - 1];
      const cur = out[i];
      if (cur.start <= prev.end) {
        if (cur.end > prev.end) prev.end = cur.end;
      } else {
        merged.push(cur);
      }
    }
    return merged;
  }

  function normalizeFunctionStarts(functionStarts, lo, hi) {
    if (!functionStarts) return [];
    const out = [];
    const len = functionStarts.length;
    if (typeof len === 'number') {
      for (let i = 0; i < len; i++) {
        const raw = functionStarts[i];
        if (raw == null) continue;
        const v = typeof raw === 'bigint' ? raw : BigInt(raw);
        if (v >= lo && v < hi) out.push(v);
      }
    } else {
      for (const raw of functionStarts) {
        if (raw == null) continue;
        const v = typeof raw === 'bigint' ? raw : BigInt(raw);
        if (v >= lo && v < hi) out.push(v);
      }
    }
    if (out.length > 1) {
      let sorted = true;
      for (let i = 1; i < out.length; i++) {
        if (out[i] < out[i - 1]) { sorted = false; break; }
      }
      if (!sorted) out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
    return out;
  }

  function createYielder(intervalMs = 16) {
    const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? () => performance.now()
      : () => Date.now();
    let last = now();
    return async function maybeYield() {
      const t = now();
      if (t - last < intervalMs) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
      last = now();
    };
  }

  async function readFileBlock(file, fileOffset, pos, length) {
    const start = Number(fileOffset) + pos;
    const fileSize = Number(file.size ?? 0);
    if (length <= 0 || start < 0 || start >= fileSize) return new Uint8Array(0);
    const end = Math.min(start + length, fileSize);
    if (end <= start) return new Uint8Array(0);
    const buf = await file.slice(start, end).arrayBuffer();
    return new Uint8Array(buf);
  }

  function noteLoopProvenanceState(word, kind, pc, lastWrite, values, Words, writesLowReg) {
    const write = (reg, value = null, record = true) => {
      const r = Number(reg);
      if (!Number.isInteger(r) || r < 0 || r >= 32) return;
      if (values) values[r] = value == null ? null : value;
      if (record) lastWrite[r] = pc;
    };
    const unknown = (reg, record = true) => write(reg, null, record);

    const K = Words.KIND;
    if (kind === K.CALL || kind === K.INDCALL) {
      for (let reg = 0; reg <= 18; reg++) unknown(reg);
      unknown(30);
      return;
    }

    const rel = Words.pcRelTarget(word, pc);
    if (rel) { write(rel.reg, rel.value); return; }

    const pair = Words.pairedOffset(word);
    if (pair) {
      if (!pair.load && !pair.store) {
        const value = values && values[pair.rn] != null ? values[pair.rn] + pair.imm : null;
        write(pair.rd, value, pair.rd !== pair.rn);
      } else if (pair.load && pair.gpDest !== false) {
        unknown(pair.rd);
      }
      return;
    }

    if (kind === K.LITERAL) { unknown(word & 0x1f); return; }

    const mem = Words.memoryAccess(word);
    if (mem) {
      if (mem.load && !mem.vector && !mem.prefetch) {
        unknown(mem.reg);
        if (mem.pair && mem.reg2 != null) unknown(mem.reg2);
      }
      if (mem.statusReg != null) unknown(mem.statusReg);
      if ((mem.mode === 'pre' || mem.mode === 'post') && !mem.vector) unknown(mem.base);
      return;
    }

    if (kind === K.FARITH || kind === K.FMUL || kind === K.SIMD ||
        (kind === K.CSEL && Words.isFpCondSelect && Words.isFpCondSelect(word))) return;
    if (writesLowReg[kind]) unknown(word & 0x1f);
  }

  async function scanStage1Chunk(ctx) {
    const Words = resolveWords(ctx);
    const writesLowReg = resolveWritesLowReg(Words);
    const region = ctx.region;
    const regionVm = BigInt(region.vmAddr);
    const regionSize = BigInt(region.size);
    const regionFileOffset = BigInt(region.fileOffset);
    const regionEndVm = regionVm + regionSize;
    const chunkStart = Math.max(0, Math.floor(Number(ctx.chunkStart) || 0));
    const chunkEnd = Math.max(chunkStart, Math.min(Number(regionSize), Math.floor(Number(ctx.chunkEnd) || 0)));
    const chunkLen = chunkEnd - chunkStart;
    const pass1Budget = Math.floor(chunkLen * 0.8);
    const pass2Budget = chunkLen - pass1Budget;
    const chunkStartVm = regionVm + BigInt(chunkStart);
    const chunkEndVm = regionVm + BigInt(chunkEnd);
    const fnStarts = normalizeFunctionStarts(ctx.functionStarts, chunkStartVm, chunkEndVm);
    const isCancelled = typeof ctx.isCancelled === 'function' ? ctx.isCancelled : null;
    const onProgress = typeof ctx.onProgress === 'function' ? ctx.onProgress : null;
    let lastProgressDone = -1;
    const reportProgress = (done, hits) => {
      if (!onProgress) return;
      const clamped = Math.max(lastProgressDone < 0 ? 0 : lastProgressDone, Math.min(chunkLen, done));
      if (clamped === lastProgressDone) return;
      lastProgressDone = clamped;
      onProgress(clamped, chunkLen, hits);
    };
    const readBlock = typeof ctx.readBlock === 'function'
      ? ctx.readBlock
      : (pos, len) => readFileBlock(ctx.file, regionFileOffset, pos, len);
    const maybeYield = createYielder(16);

    const edgeTargets = new Map();
    const targetSet = new Set();
    const crossChunkForwardSet = new Set();

    let nextFunctionStart = 0;
    let currentFunctionStart = null;
    let pos = chunkStart;

    // Pass 1: fast bitmask scan collecting local backward loop edges AND
    // cross-chunk forward branch/call targets.
    while (pos < chunkEnd) {
      if (isCancelled && isCancelled()) return { cancelled: true, __transfer: [] };
      const want = Math.min(STREAM_SCAN_BLOCK, chunkEnd - pos);
      const blk = await readBlock(pos, want);
      if (blk.length < 4) break;
      const count = Math.floor(blk.length / 4);
      const dv = new DataView(blk.buffer, blk.byteOffset, count * 4);
      for (let i = 0; i < count; i++) {
        const word = dv.getUint32(i * 4, true);
        const pc = regionVm + BigInt(pos + i * 4);
        while (nextFunctionStart < fnStarts.length && fnStarts[nextFunctionStart] <= pc) {
          currentFunctionStart = fnStarts[nextFunctionStart++];
        }
        if (Words.isCondBranch(word)) {
          const target = Words.condBranchTarget(word, pc);
          if (target != null) {
            if (target >= chunkStartVm && target <= pc &&
                (currentFunctionStart == null || target >= currentFunctionStart)) {
              edgeTargets.set(pc, target);
              targetSet.add(target);
            } else if (target > pc + 4n && target >= chunkEndVm && target < regionEndVm) {
              crossChunkForwardSet.add(target);
            }
          }
        } else if (Words.isBranchImm(word)) {
          const target = Words.branchImm26(word, pc);
          if (target != null) {
            if (target >= chunkStartVm && target <= pc &&
                (currentFunctionStart == null || target >= currentFunctionStart)) {
              edgeTargets.set(pc, target);
              targetSet.add(target);
            } else if (target > pc + 4n && target >= chunkEndVm && target < regionEndVm) {
              crossChunkForwardSet.add(target);
            }
          }
        } else if (Words.isCallImm(word)) {
          const target = Words.branchImm26(word, pc);
          if (target != null && target > pc + 4n && target >= chunkEndVm && target < regionEndVm) {
            crossChunkForwardSet.add(target);
          }
        }
      }
      pos += count * 4;
      if (onProgress) {
        const p1Done = chunkLen > 0
          ? Math.min(pass1Budget, Math.floor(((pos - chunkStart) / chunkLen) * pass1Budget))
          : 0;
        reportProgress(p1Done, targetSet.size + crossChunkForwardSet.size);
      }
      if (count * 4 < want) break;
      await maybeYield();
    }

    // Pass 2: compute local loop kills ONLY if local backward targets exist.
    const entries = new Map();
    if (targetSet.size > 0) {
      const K = Words.KIND;
      const values = new Array(32).fill(null);
      const lastWrite = new Array(32).fill(null);
      const targetValues = new Map();
      nextFunctionStart = 0;
      currentFunctionStart = null;
      pos = chunkStart;

      while (pos < chunkEnd) {
        if (isCancelled && isCancelled()) return { cancelled: true, __transfer: [] };
        const want = Math.min(STREAM_SCAN_BLOCK, chunkEnd - pos);
        const blk = await readBlock(pos, want);
        if (blk.length < 4) break;
        const count = Math.floor(blk.length / 4);
        const dv = new DataView(blk.buffer, blk.byteOffset, count * 4);
        for (let i = 0; i < count; i++) {
          const word = dv.getUint32(i * 4, true);
          const pc = regionVm + BigInt(pos + i * 4);
          while (nextFunctionStart < fnStarts.length && fnStarts[nextFunctionStart] <= pc) {
            currentFunctionStart = fnStarts[nextFunctionStart++];
            values.fill(null);
            lastWrite.fill(null);
            targetValues.clear();
          }
          if (targetSet.has(pc)) targetValues.set(pc, values.slice());

          const kind = Words.classifyWord(word);
          noteLoopProvenanceState(word, kind, pc, lastWrite, values, Words, writesLowReg);

          const target = edgeTargets.get(pc);
          if (target != null) {
            const before = targetValues.get(target);
            let killMask = 0;
            for (let reg = 0; reg < 32; reg++) {
              const at = lastWrite[reg];
              if (at == null || at < target) continue;
              const prior = before ? before[reg] : null;
              if (prior == null || values[reg] !== prior) {
                killMask = (killMask | (1 << reg)) >>> 0;
              }
            }
            if (killMask !== 0) {
              entries.set(target, ((entries.get(target) || 0) | killMask) >>> 0);
            }
          }

          // Reset AFTER edgeTargets.get(pc) (#2117) so unconditional backward B
          // edges compute their kill set before clearing linear state.
          if (kind === K.RET || kind === K.TRAP || kind === K.BRANCH) {
            values.fill(null);
            lastWrite.fill(null);
          }
        }
        pos += count * 4;
        if (onProgress) {
          const p2Done = chunkLen > 0
            ? Math.min(chunkLen, pass1Budget + Math.floor(((pos - chunkStart) / chunkLen) * pass2Budget))
            : chunkLen;
          reportProgress(p2Done, entries.size + crossChunkForwardSet.size);
        }
        if (count * 4 < want) break;
        await maybeYield();
      }
    } else if (onProgress) {
      reportProgress(chunkLen, crossChunkForwardSet.size);
    }

    const forwardList = Array.from(crossChunkForwardSet);
    if (forwardList.length > 1) {
      forwardList.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
    const crossChunkForwardTargets = new BigUint64Array(forwardList.length);
    for (let i = 0; i < forwardList.length; i++) crossChunkForwardTargets[i] = forwardList[i];

    const loopKillAddrs = new BigUint64Array(entries.size);
    const loopKillMasks = new Uint32Array(entries.size);
    let killIdx = 0;
    for (const [addr, mask] of entries) {
      loopKillAddrs[killIdx] = addr;
      loopKillMasks[killIdx] = mask >>> 0;
      killIdx++;
    }

    return {
      chunkIndex: ctx.chunkIndex ?? 0,
      cancelled: false,
      crossChunkForwardTargets,
      loopKillAddrs,
      loopKillMasks,
      __transfer: [
        crossChunkForwardTargets.buffer,
        loopKillAddrs.buffer,
        loopKillMasks.buffer,
      ],
    };
  }

  async function scanProgramChunk(ctx) {
    const Words = resolveWords(ctx);
    const writesLowReg = resolveWritesLowReg(Words);
    const AddressProvenance = (ctx && ctx.addressProvenance) || global.AddressProvenance;
    if (!AddressProvenance || typeof AddressProvenance.create !== 'function') {
      throw new Error('HexScanCore.scanProgramChunk requires AddressProvenance');
    }

    const region = ctx.region;
    const regionVm = BigInt(region.vmAddr);
    const regionSize = BigInt(region.size);
    const regionFileOffset = BigInt(region.fileOffset);
    const regionEndVm = regionVm + regionSize;
    const chunkStart = Math.max(0, Math.floor(Number(ctx.chunkStart) || 0));
    const chunkEnd = Math.max(chunkStart, Math.min(Number(regionSize), Math.floor(Number(ctx.chunkEnd) || 0)));
    const chunkBytes = chunkEnd - chunkStart;
    const chunkWordBase = Math.floor(chunkStart / 4);
    const chunkWords = Math.floor(chunkBytes / 4);
    const chunkStartVm = regionVm + BigInt(chunkStart);
    const chunkEndVm = regionVm + BigInt(chunkEnd);

    const capOf = (value, hard) =>
      value == null ? hard : Math.max(0, Math.min(hard, Math.floor(Number(value) || 0)));
    const callCap = capOf(ctx.callLimit, MAX_EDGES);
    const refCap = capOf(ctx.refLimit, MAX_REFS);
    const globalKindCap = capOf(ctx.globalKindCap, MAX_KIND_WORDS);
    const chunkKindCount = Math.max(0, Math.min(chunkWords, globalKindCap - chunkWordBase));
    const chunkBudgetBytes =
      typeof ctx.chunkBudgetBytes === 'number' && Number.isFinite(ctx.chunkBudgetBytes)
        ? Math.max(0, Math.floor(ctx.chunkBudgetBytes))
        : PROGRAM_INDEX_BUDGET_BYTES;

    const kinds = new Uint8Array(chunkKindCount);
    let callInitial = Math.min(chunkWords, CHUNK_EDGES_INITIAL, callCap);
    let refInitial = Math.min(chunkWords, CHUNK_EDGES_INITIAL, refCap);
    if (kinds.byteLength + callInitial * 16 + refInitial * 17 > chunkBudgetBytes) {
      const avail = Math.max(0, chunkBudgetBytes - kinds.byteLength);
      const half = Math.floor(avail / 2);
      callInitial = Math.min(callInitial, Math.floor(half / 16));
      refInitial = Math.min(refInitial, Math.floor(Math.max(0, avail - callInitial * 16) / 17));
    }

    let callFrom = new BigUint64Array(callInitial);
    let callTo = new BigUint64Array(callInitial);
    let refFrom = new BigUint64Array(refInitial);
    let refTo = new BigUint64Array(refInitial);
    let refKind = new Uint8Array(refInitial);

    let nCalls = 0;
    let nRefs = 0;
    let callsLimitCapped = false;
    let refsLimitCapped = false;
    let budgetCapped = false;

    const stringRanges = normalizeSortedRanges(ctx.stringRanges);
    const fnStarts = normalizeFunctionStarts(ctx.functionStarts, chunkStartVm, chunkEndVm);

    const entryKills = [];
    const loopKillAddrs = ctx.loopKillAddrs;
    const loopKillMasks = ctx.loopKillMasks;
    if (loopKillAddrs && loopKillMasks) {
      const len = Math.min(loopKillAddrs.length, loopKillMasks.length);
      for (let i = 0; i < len; i++) {
        const mask = loopKillMasks[i] >>> 0;
        if (!mask) continue;
        const regs = [];
        for (let r = 0; r < 32; r++) {
          if ((mask & (1 << r)) !== 0) regs.push(r);
        }
        entryKills.push([loopKillAddrs[i], regs]);
      }
    }

    const provenance = AddressProvenance.create({
      words: Words,
      pairWindow: PAIR_WINDOW,
      functionStarts: fnStarts,
      rangeStart: regionVm,
      rangeEnd: regionEndVm,
      branchEntries: ctx.incomingForwardTargets || [],
      entryKills,
    });

    const residentBytes = () =>
      callFrom.byteLength + callTo.byteLength +
      refFrom.byteLength + refTo.byteLength + refKind.byteLength +
      kinds.byteLength;

    function growCalls() {
      if (callFrom.length >= callCap || callFrom.length >= MAX_EDGES) return 'limit';
      const grown = callFrom.length === 0
        ? Math.min(CHUNK_EDGES_INITIAL, callCap, MAX_EDGES)
        : Math.max(callFrom.length + 1, Math.floor(callFrom.length * 1.5));
      const size = Math.min(grown, MAX_EDGES, callCap);
      if (size <= callFrom.length) return 'limit';
      const postGrowResidentBytes =
        (residentBytes() - callFrom.byteLength - callTo.byteLength) + size * 16;
      const newSingleArrayBytes = size * 8;
      if (postGrowResidentBytes + newSingleArrayBytes > chunkBudgetBytes) return 'budget';
      let next = new BigUint64Array(size);
      next.set(callFrom);
      callFrom = next;
      next = new BigUint64Array(size);
      next.set(callTo);
      callTo = next;
      return 'ok';
    }

    function growRefs() {
      if (refFrom.length >= refCap || refFrom.length >= MAX_REFS) return 'limit';
      const grown = refFrom.length === 0
        ? Math.min(CHUNK_EDGES_INITIAL, refCap, MAX_REFS)
        : Math.max(refFrom.length + 1, Math.floor(refFrom.length * 1.5));
      const size = Math.min(grown, MAX_REFS, refCap);
      if (size <= refFrom.length) return 'limit';
      const postGrowResidentBytes =
        (residentBytes() - refFrom.byteLength - refTo.byteLength - refKind.byteLength) + size * 17;
      const newSingleArrayBytes = size * 8;
      if (postGrowResidentBytes + newSingleArrayBytes > chunkBudgetBytes) return 'budget';
      let next64 = new BigUint64Array(size);
      next64.set(refFrom);
      refFrom = next64;
      next64 = new BigUint64Array(size);
      next64.set(refTo);
      refTo = next64;
      const next8 = new Uint8Array(size);
      next8.set(refKind);
      refKind = next8;
      return 'ok';
    }

    function addRef(pc, target, k) {
      if (target == null || refsLimitCapped || budgetCapped) return;
      if (nRefs === refFrom.length) {
        const status = growRefs();
        if (status === 'budget') { budgetCapped = true; return; }
        if (status === 'limit') { refsLimitCapped = true; return; }
      }
      if (nRefs < refFrom.length) {
        refFrom[nRefs] = pc;
        refTo[nRefs] = target;
        refKind[nRefs] = k;
        nRefs++;
      }
    }

    const isCancelled = typeof ctx.isCancelled === 'function' ? ctx.isCancelled : null;
    const onProgress = typeof ctx.onProgress === 'function' ? ctx.onProgress : null;
    const readBlock = typeof ctx.readBlock === 'function'
      ? ctx.readBlock
      : (pos, len) => readFileBlock(ctx.file, regionFileOffset, pos, len);
    const maybeYield = createYielder(16);
    const K = Words.KIND;

    let localIndex = 0;
    let pos = chunkStart;

    while (pos < chunkEnd && !budgetCapped) {
      if (isCancelled && isCancelled()) return { cancelled: true, __transfer: [] };
      const want = Math.min(STREAM_SCAN_BLOCK, chunkEnd - pos);
      const blk = await readBlock(pos, want);
      if (blk.length < 4) break;
      const n = Math.floor(blk.length / 4);
      const dv = new DataView(blk.buffer, blk.byteOffset, n * 4);

      for (let i = 0; i < n; i++, localIndex++) {
        const index = chunkWordBase + localIndex;
        const w = dv.getUint32(i * 4, true);
        const pc = regionVm + BigInt(pos + i * 4);
        provenance.enter(pc);
        const kind = Words.classifyWord(w);
        if (localIndex < kinds.length) kinds[localIndex] = canonicalProgramKind(w, kind, Words);

        if (kind === K.CALL || kind === K.INDCALL) {
          if (kind === K.CALL) {
            const t = Words.branchImm26(w, pc);
            if (t != null && !callsLimitCapped && !budgetCapped) {
              if (nCalls === callFrom.length) {
                const status = growCalls();
                if (status === 'budget') budgetCapped = true;
                else if (status === 'limit') callsLimitCapped = true;
              }
              if (nCalls < callFrom.length && !budgetCapped) {
                callFrom[nCalls] = pc;
                callTo[nCalls] = t;
                nCalls++;
              }
            }
          }
          provenance.control(w, pc, kind);
          if (budgetCapped) break;
          continue;
        }
        if (kind === K.CONDBR || kind === K.BRANCH || kind === K.RET || kind === K.TRAP) {
          provenance.control(w, pc, kind);
          continue;
        }

        const rel = Words.pcRelTarget(w, pc);
        if (rel) {
          provenance.note(rel.reg, rel.value, index);
          if (!rel.page) addRef(pc, rel.value, 0);
          if (budgetCapped) break;
          continue;
        }

        const pair = Words.pairedOffset(w);
        const base = pair ? provenance.base(pair.rn, index, {
          allowEntryFallback: pair.load || pair.store,
        }) : null;
        if (pair && base != null) {
          const full = base + pair.imm;
          addRef(pc, full, pair.load ? 1 : pair.store ? 2 : 0);
          if (!pair.load && !pair.store) provenance.note(pair.rd, full, index);
          else if (pair.load && pair.gpDest !== false) provenance.kill(pair.rd);
          if (budgetCapped) break;
          continue;
        }

        if (kind === K.LITERAL) {
          const t = Words.literalTarget(w, pc);
          if (t != null) addRef(pc, t, 1);
          if (!Words.isPrefetchLiteral(w)) provenance.kill(w & 0x1f);
          if (budgetCapped) break;
          continue;
        }

        const memWrite = Words.memoryAccess(w);
        if (memWrite) {
          const referenceWorthy = memWrite.pair === true || memWrite.rmw === true;
          const knownBase = referenceWorthy && !memWrite.indexed && memWrite.disp != null
            ? provenance.base(memWrite.base, index, { allowEntryFallback: true }) : null;
          if (knownBase != null) {
            const full = memWrite.mode === 'post' ? knownBase : knownBase + memWrite.disp;
            if (!inSortedRanges(BigInt.asUintN(64, full), stringRanges)) {
              addRef(pc, full, memWrite.rmw ? 3 : memWrite.load ? 1 : memWrite.store ? 2 : 0);
            }
          }
          if (memWrite.load && !memWrite.vector && !memWrite.prefetch) {
            provenance.kill(memWrite.reg);
            if (memWrite.pair && memWrite.reg2 != null) provenance.kill(memWrite.reg2);
          }
          if (memWrite.statusReg != null) provenance.kill(memWrite.statusReg);
          if (memWrite.mode === 'pre' || memWrite.mode === 'post') provenance.kill(memWrite.base);
          if (budgetCapped) break;
          continue;
        }

        if (kind === K.FARITH || kind === K.FMUL || kind === K.SIMD ||
            (kind === K.CSEL && Words.isFpCondSelect && Words.isFpCondSelect(w))) continue;
        if (writesLowReg[kind] && !Words.isPrefetchLiteral(w)) provenance.kill(w & 0x1f);
      }

      pos += n * 4;
      if (onProgress) onProgress(pos - chunkStart, chunkBytes, nCalls + nRefs);
      if (n * 4 < want) break;
      await maybeYield();
    }

    // Field-by-field trimming before transfer to bound peak worker RAM spike.
    const outCallFrom = nCalls === callFrom.length ? callFrom : callFrom.slice(0, nCalls);
    callFrom = null;
    const outCallTo = nCalls === callTo.length ? callTo : callTo.slice(0, nCalls);
    callTo = null;
    const outRefFrom = nRefs === refFrom.length ? refFrom : refFrom.slice(0, nRefs);
    refFrom = null;
    const outRefTo = nRefs === refTo.length ? refTo : refTo.slice(0, nRefs);
    refTo = null;
    const outRefKind = nRefs === refKind.length ? refKind : refKind.slice(0, nRefs);
    refKind = null;

    return {
      chunkIndex: ctx.chunkIndex ?? 0,
      chunkStart,
      chunkEnd,
      chunkWordBase,
      words: chunkWords,
      callFrom: outCallFrom,
      callTo: outCallTo,
      callCount: nCalls,
      refFrom: outRefFrom,
      refTo: outRefTo,
      refKind: outRefKind,
      refCount: nRefs,
      kinds,
      kindsCovered: Math.min(localIndex, kinds.length),
      callsLimitCapped,
      refsLimitCapped,
      budgetCapped,
      cancelled: false,
      __transfer: [
        outCallFrom.buffer, outCallTo.buffer,
        outRefFrom.buffer, outRefTo.buffer, outRefKind.buffer,
        kinds.buffer,
      ],
    };
  }

  async function scanValueShapesChunk(ctx) {
    const Words = resolveWords(ctx);
    const region = ctx.region;
    const regionVm = BigInt(region.vmAddr);
    const regionSize = BigInt(region.size);
    const regionFileOffset = BigInt(region.fileOffset);
    const chunkStart = Math.max(0, Math.floor(Number(ctx.chunkStart) || 0));
    const chunkEnd = Math.max(chunkStart, Math.min(Number(regionSize), Math.floor(Number(ctx.chunkEnd) || 0)));
    const chunkBytes = chunkEnd - chunkStart;
    const limit = ctx.shapeLimit == null
      ? MAX_SHAPE_EVENTS
      : Math.max(0, Math.min(MAX_SHAPE_EVENTS, Math.floor(Number(ctx.shapeLimit) || 0)));

    const initial = Math.min(CHUNK_SHAPES_INITIAL, limit);
    let evAddr = new BigUint64Array(initial);
    let evDisp = new Int32Array(initial);
    let evAmtDisp = new Int32Array(initial);
    let evSize = new Uint8Array(initial);
    let evFlags = new Uint8Array(initial);
    let evAmtKind = new Uint8Array(initial);
    let evSpan = new Int32Array(initial);
    let evAmtSize = new Uint8Array(initial);
    let evAmtSpan = new Int32Array(initial);
    let n = 0;
    let capped = false;

    function growEvents() {
      if (evAddr.length >= limit) return false;
      const grown = evAddr.length === 0
        ? Math.min(CHUNK_SHAPES_INITIAL, limit)
        : Math.max(evAddr.length + 1, Math.floor(evAddr.length * 1.5));
      const nextSize = Math.min(grown, limit);
      if (nextSize <= evAddr.length) return false;

      let next64 = new BigUint64Array(nextSize);
      next64.set(evAddr);
      evAddr = next64;

      let next32 = new Int32Array(nextSize);
      next32.set(evDisp);
      evDisp = next32;

      next32 = new Int32Array(nextSize);
      next32.set(evAmtDisp);
      evAmtDisp = next32;

      let next8 = new Uint8Array(nextSize);
      next8.set(evSize);
      evSize = next8;

      next8 = new Uint8Array(nextSize);
      next8.set(evFlags);
      evFlags = next8;

      next8 = new Uint8Array(nextSize);
      next8.set(evAmtKind);
      evAmtKind = next8;

      next32 = new Int32Array(nextSize);
      next32.set(evSpan);
      evSpan = next32;

      next8 = new Uint8Array(nextSize);
      next8.set(evAmtSize);
      evAmtSize = next8;

      next32 = new Int32Array(nextSize);
      next32.set(evAmtSpan);
      evAmtSpan = next32;

      return true;
    }

    const spanOf = new Int32Array(32);
    const noteSpan = (base, disp) => {
      if (base < 0 || base > 31) return;
      if (disp > spanOf[base]) spanOf[base] = disp;
    };

    const pBase = new Int8Array(32).fill(-1);
    const pDisp = new Int32Array(32);
    const pSize = new Uint8Array(32);
    const pDir = new Int8Array(32);
    const pClamp = new Uint8Array(32);
    const pAmtKind = new Uint8Array(32);
    const pAmtBase = new Int8Array(32);
    const pAmtDisp = new Int32Array(32);
    const pAmtScaled = new Uint8Array(32);
    const pAmtSize = new Uint8Array(32);
    const pAmtSpan = new Int32Array(32);

    const forget = (r) => {
      if (r < 0 || r >= 31) return;
      pBase[r] = -1;
      spanOf[r] = 0;
      pAmtKind[r] = AMT_NONE;
      pAmtBase[r] = -1;
      pAmtDisp[r] = 0;
      pAmtScaled[r] = 0;
      pAmtSize[r] = 0;
      pAmtSpan[r] = 0;
    };
    const forgetAll = () => {
      pBase.fill(-1);
      pAmtKind.fill(AMT_NONE);
    };
    const copy = (d, s) => {
      if (d === 31) return;
      if (d !== s) spanOf[d] = spanOf[s];
      pBase[d] = pBase[s];
      pDisp[d] = pDisp[s];
      pSize[d] = pSize[s];
      pDir[d] = pDir[s];
      pClamp[d] = pClamp[s];
      pAmtKind[d] = pAmtKind[s];
      pAmtBase[d] = pAmtBase[s];
      pAmtDisp[d] = pAmtDisp[s];
      pAmtScaled[d] = pAmtScaled[s];
      pAmtSize[d] = pAmtSize[s];
      pAmtSpan[d] = pAmtSpan[s];
    };
    const setAmount = (d, kind, base, disp, scaled, size, span) => {
      if (pAmtKind[d] !== AMT_NONE) return;
      pAmtKind[d] = kind;
      pAmtBase[d] = base == null ? -1 : base;
      pAmtDisp[d] = disp || 0;
      pAmtScaled[d] = scaled ? 1 : 0;
      pAmtSize[d] = size || 0;
      pAmtSpan[d] = span || 0;
    };

    const isCancelled = typeof ctx.isCancelled === 'function' ? ctx.isCancelled : null;
    const onProgress = typeof ctx.onProgress === 'function' ? ctx.onProgress : null;
    const readBlock = typeof ctx.readBlock === 'function'
      ? ctx.readBlock
      : (pos, len) => readFileBlock(ctx.file, regionFileOffset, pos, len);
    const maybeYield = createYielder(16);

    let pos = chunkStart;
    while (pos < chunkEnd && n < limit) {
      if (isCancelled && isCancelled()) return { cancelled: true, __transfer: [] };
      const want = Math.min(STREAM_SCAN_BLOCK, chunkEnd - pos);
      const blk = await readBlock(pos, want);
      if (blk.length < 4) break;
      const words = Math.floor(blk.length / 4);
      const dv = new DataView(blk.buffer, blk.byteOffset, words * 4);

      for (let i = 0; i < words && n < limit; i++) {
        const w = dv.getUint32(i * 4, true);

        if (Words.isCallImm(w) || Words.isIndirectCall(w)) {
          for (let r = 0; r <= 18; r++) forget(r);
          pAmtKind[0] = AMT_CALL;
          continue;
        }
        if (Words.isBranchImm(w) || Words.isRet(w) || Words.isBr(w)) {
          forgetAll();
          spanOf.fill(0);
          continue;
        }
        if (Words.isCondBranch(w)) continue;

        const mem = Words.memoryAccess(w);
        if (mem && !mem.indexed && mem.disp != null) {
          const d = Number(mem.disp);
          noteSpan(mem.base, d);

          if (mem.pair && !mem.rmw) continue;

          if (mem.rmw) {
            if (n === evAddr.length && !growEvents()) { capped = true; break; }
            evAddr[n] = regionVm + BigInt(pos + i * 4);
            evDisp[n] = d;
            evSize[n] = mem.size;
            evFlags[n] = SHAPE_ATOMIC_RMW;
            evAmtKind[n] = AMT_NONE;
            evAmtDisp[n] = 0;
            evSpan[n] = spanOf[mem.base];
            evAmtSize[n] = 0;
            evAmtSpan[n] = 0;
            n++;
            if (n >= limit) capped = true;

            const r = mem.resultReg != null ? mem.resultReg : mem.reg;
            if (r != null && r !== 31) {
              spanOf[r] = 0;
              pBase[r] = mem.base;
              pDisp[r] = d;
              pSize[r] = mem.size;
              pDir[r] = 0;
              pClamp[r] = 0;
              pAmtKind[r] = AMT_NONE;
              pAmtBase[r] = -1;
              pAmtDisp[r] = 0;
              pAmtScaled[r] = 0;
              pAmtSize[r] = 0;
              pAmtSpan[r] = 0;
            }
            continue;
          }

          if (mem.load) {
            if (!mem.vector && !mem.prefetch) {
              const r = mem.reg;
              if (r !== 31) {
                spanOf[r] = 0;
                pBase[r] = mem.base;
                pDisp[r] = d;
                pSize[r] = mem.size;
                pDir[r] = 0;
                pClamp[r] = 0;
                pAmtKind[r] = AMT_NONE;
                pAmtBase[r] = -1;
                pAmtDisp[r] = 0;
                pAmtScaled[r] = 0;
                pAmtSize[r] = 0;
                pAmtSpan[r] = 0;
              }
            }
            continue;
          }

          const src = mem.reg;
          if (src < 31 && pBase[src] >= 0 && pDir[src] !== 0 &&
              pBase[src] === mem.base && pDisp[src] === d) {
            if (n === evAddr.length && !growEvents()) { capped = true; break; }
            let flags = pDir[src] > 0 ? SHAPE_INCREASE : SHAPE_DECREASE;
            if (pClamp[src]) flags |= SHAPE_CLAMP;
            if (pAmtScaled[src]) flags |= SHAPE_SCALED;
            if (pAmtKind[src] === AMT_FIELD && pAmtBase[src] >= 0 && pAmtBase[src] !== mem.base) {
              flags |= SHAPE_CROSS;
            }
            evAddr[n] = regionVm + BigInt(pos + i * 4);
            evDisp[n] = d;
            evSize[n] = mem.size;
            evFlags[n] = flags;
            evAmtKind[n] = pAmtKind[src];
            evAmtDisp[n] = pAmtKind[src] === AMT_FIELD ? pAmtDisp[src] : 0;
            evSpan[n] = spanOf[mem.base];
            evAmtSize[n] = pAmtSize[src];
            evAmtSpan[n] = pAmtSpan[src];
            n++;
            if (n >= limit) capped = true;
          }
          continue;
        }

        if (Words.masked(w, 0x1f200000) === 0x0b000000 && ((w >>> 10) & 0x3f) === 0) {
          const d = w & 31;
          const a = (w >>> 5) & 31;
          const m = (w >>> 16) & 31;
          const sub = ((w >>> 30) & 1) === 1;
          if (((w >>> 29) & 1) === 1 && d === 31) continue;
          if (pBase[a] >= 0) {
            const amtKind = pBase[m] >= 0 ? AMT_FIELD : AMT_NONE;
            const amtBase = pBase[m] >= 0 ? pBase[m] : -1;
            const amtDisp = pBase[m] >= 0 ? pDisp[m] : 0;
            const scaled = pAmtScaled[m];
            copy(d, a);
            pDir[d] = sub ? -1 : 1;
            if (amtKind !== AMT_NONE) {
              setAmount(d, AMT_FIELD, amtBase, amtDisp, scaled, pSize[m], spanOf[amtBase]);
            } else if (pAmtKind[m] === AMT_CALL) {
              setAmount(d, AMT_CALL, -1, 0, 0);
            }
          } else {
            forget(d);
          }
          continue;
        }

        if (Words.masked(w, 0x1f000000) === 0x11000000) {
          const d = w & 31;
          const a = (w >>> 5) & 31;
          const sub = ((w >>> 30) & 1) === 1;
          if (((w >>> 29) & 1) === 1 && d === 31) continue;
          if (pBase[a] >= 0) {
            const imm = ((w >>> 10) & 0xfff) << (((w >>> 22) & 1) ? 12 : 0);
            copy(d, a);
            pDir[d] = sub ? -1 : 1;
            setAmount(d, AMT_IMM, -1, imm, 0);
          } else {
            forget(d);
          }
          continue;
        }

        if (Words.masked(w, 0x1f000000) === 0x1b000000 && ((w >>> 21) & 7) === 0) {
          const d = w & 31;
          const nR = (w >>> 5) & 31;
          const m = (w >>> 16) & 31;
          const a = (w >>> 10) & 31;
          const sub = ((w >>> 15) & 1) === 1;
          if (a !== 31 && pBase[a] >= 0) {
            const src = pBase[nR] >= 0 ? nR : (pBase[m] >= 0 ? m : -1);
            copy(d, a);
            pDir[d] = sub ? -1 : 1;
            if (src >= 0) {
              setAmount(d, AMT_FIELD, pBase[src], pDisp[src], 1, pSize[src], spanOf[pBase[src]]);
            }
          } else {
            forget(d);
          }
          continue;
        }

        if (Words.isMultiply(w) || Words.isDivide(w) || Words.isShiftOp(w)) {
          const d = w & 31;
          const a = (w >>> 5) & 31;
          const m = (w >>> 16) & 31;
          const src = pBase[a] >= 0 ? a : (pBase[m] >= 0 ? m : -1);
          if (src >= 0) { copy(d, src); pAmtScaled[d] = 1; } else forget(d);
          continue;
        }

        if (Words.masked(w, 0x1f200000) === 0x0a200000) {
          const d = w & 31;
          const a = (w >>> 5) & 31;
          const m = (w >>> 16) & 31;
          if (a === m && ((w >>> 22) & 3) === 2 && ((w >>> 10) & 0x3f) === 31 && pBase[a] >= 0) {
            copy(d, a);
            pClamp[d] = 1;
          } else {
            forget(d);
          }
          continue;
        }

        if (Words.masked(w, 0x1fe00000) === 0x1a800000) {
          const d = w & 31;
          const a = (w >>> 5) & 31;
          const m = (w >>> 16) & 31;
          const src = pBase[a] >= 0 ? a : (pBase[m] >= 0 ? m : -1);
          if (src >= 0) { copy(d, src); pClamp[d] = 1; } else forget(d);
          continue;
        }

        if (Words.masked(w, 0x7fe0ffe0) === 0x2a0003e0) {
          const d = w & 31;
          const m = (w >>> 16) & 31;
          if (pBase[m] >= 0) copy(d, m); else forget(d);
          continue;
        }

        if (Words.isCompare(w) || Words.isNop(w)) continue;
        forget(w & 31);
      }

      pos += words * 4;
      if (onProgress) onProgress(pos - chunkStart, chunkBytes, n);
      if (words * 4 < want) break;
      await maybeYield();
    }

    // Field-by-field trimming before transfer.
    const addr = n === evAddr.length ? evAddr : evAddr.slice(0, n);
    evAddr = null;
    const disp = n === evDisp.length ? evDisp : evDisp.slice(0, n);
    evDisp = null;
    const size = n === evSize.length ? evSize : evSize.slice(0, n);
    evSize = null;
    const flags = n === evFlags.length ? evFlags : evFlags.slice(0, n);
    evFlags = null;
    const amtKind = n === evAmtKind.length ? evAmtKind : evAmtKind.slice(0, n);
    evAmtKind = null;
    const amtDisp = n === evAmtDisp.length ? evAmtDisp : evAmtDisp.slice(0, n);
    evAmtDisp = null;
    const span = n === evSpan.length ? evSpan : evSpan.slice(0, n);
    evSpan = null;
    const amtSize = n === evAmtSize.length ? evAmtSize : evAmtSize.slice(0, n);
    evAmtSize = null;
    const amtSpan = n === evAmtSpan.length ? evAmtSpan : evAmtSpan.slice(0, n);
    evAmtSpan = null;

    return {
      chunkIndex: ctx.chunkIndex ?? 0,
      chunkStart,
      chunkEnd,
      count: n,
      capped,
      cancelled: false,
      addr, disp, size, flags, amtKind, amtDisp, span, amtSize, amtSpan,
      __transfer: [
        addr.buffer, disp.buffer, size.buffer, flags.buffer,
        amtKind.buffer, amtDisp.buffer, span.buffer, amtSize.buffer, amtSpan.buffer,
      ],
    };
  }

  global.HexScanCore = Object.freeze({
    STREAM_SCAN_BLOCK,
    PAIR_WINDOW,
    WRITES_LOW_REG,
    MAX_EDGES,
    MAX_REFS,
    MAX_KIND_WORDS,
    CHUNK_EDGES_INITIAL,
    MAX_SHAPE_EVENTS,
    CHUNK_SHAPES_INITIAL,
    PROGRAM_INDEX_BUDGET_BYTES,
    canonicalProgramKind,
    inSortedRanges,
    scanStage1Chunk,
    scanProgramChunk,
    scanValueShapesChunk,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
