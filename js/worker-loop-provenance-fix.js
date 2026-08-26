'use strict';

/*
 * #1900: ADR/ADRP provenance must not flow through a control-flow merge point
 * merely because the worker happens to scan instructions in address order.
 *
 * Forward branch entries are already learned by AddressProvenance.control()
 * before their first linear visit. Backward entries are different: their edge
 * is only decoded after the target has already been visited, so a one-pass
 * scanner needs a cheap control-flow prepass. The prepass records only GP
 * registers that may be redefined between a backward target and its edge;
 * unchanged address bases are deliberately preserved.
 */

function __noteLoopProvenanceWrites(word, kind, pc, lastWrite) {
  const mark = (reg) => {
    const r = Number(reg);
    if (Number.isInteger(r) && r >= 0 && r < 32) lastWrite[r] = pc;
  };

  const K = Words.KIND;
  if (kind === K.CALL || kind === K.INDCALL) {
    for (let reg = 0; reg <= 18; reg++) mark(reg);
    mark(30);
    return;
  }

  const rel = Words.pcRelTarget(word, pc);
  if (rel) { mark(rel.reg); return; }

  const pair = Words.pairedOffset(word);
  if (pair) {
    if (!pair.load && !pair.store) mark(pair.rd);
    else if (pair.load && pair.gpDest !== false) mark(pair.rd);
    return;
  }

  if (kind === K.LITERAL) { mark(word & 0x1f); return; }

  const mem = Words.memoryAccess(word);
  if (mem) {
    if (mem.load && !mem.vector) {
      mark(mem.reg);
      if (mem.pair && mem.reg2 != null) mark(mem.reg2);
    }
    if (mem.statusReg != null) mark(mem.statusReg);
    if (mem.mode === 'pre' || mem.mode === 'post') mark(mem.base);
    return;
  }

  if (kind === K.FARITH || kind === K.FMUL || kind === K.SIMD ||
      (kind === K.CSEL && Words.isFpCondSelect?.(word))) return;
  if (WRITES_LOW_REG[kind]) mark(word & 0x1f);
}

async function __backwardLoopEntryKills(region, requestId) {
  const entries = new Map();
  const total = Number(region?.size ?? 0n);
  if (!Number.isSafeInteger(total) || total <= 0) return { entries, cancelled:false };

  const lastWrite = new Array(32).fill(null);
  let pos = 0;
  while (pos < total) {
    if (cancelled(requestId)) return { entries, cancelled:true };
    const want = Math.min(1024 * 1024, total - pos);
    const blk = await readRange(region.fileOffset + BigInt(pos), want);
    if (blk.length < 4) break;
    const count = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, count * 4);
    for (let i = 0; i < count; i++) {
      const word = dv.getUint32(i * 4, true);
      const pc = region.vmAddr + BigInt(pos + i * 4);
      const kind = Words.classifyWord(word);
      __noteLoopProvenanceWrites(word, kind, pc, lastWrite);

      let target = null;
      if (kind === Words.KIND.CALL || kind === Words.KIND.BRANCH) {
        target = Words.branchImm26(word, pc);
      } else if (kind === Words.KIND.CONDBR) {
        target = Words.condBranchTarget(word, pc);
      }
      if (target == null || target > pc) continue;
      if (target < region.vmAddr || target >= region.vmAddr + region.size) continue;

      let kills = entries.get(target);
      if (!kills) { kills = new Set(); entries.set(target, kills); }
      for (let reg = 0; reg < lastWrite.length; reg++) {
        const at = lastWrite[reg];
        if (at != null && at >= target) kills.add(reg);
      }
      if (!kills.size) entries.delete(target);
    }
    pos += count * 4;
    if (count * 4 < want) break;
    await yieldToQueue();
  }
  return { entries, cancelled:false };
}

/*
 * Preserve the existing scanProgram implementation and all later string-ref
 * filtering. AddressProvenance.create() is reached synchronously before the
 * underlying scanner's first readRange await, so the temporary factory swap is
 * confined to one JavaScript turn and cannot leak across worker requests.
 */
const __scanProgramBeforeLoopProvenanceFix = scanProgram;
scanProgram = async function scanProgramWithLoopProvenance(args) {
  const region = regions.get(args.regionId);
  if (!region) throw new Error('Unknown region.');
  const prepass = await __backwardLoopEntryKills(region, args.requestId);
  if (prepass.cancelled) return { cancelled:true, __transfer:[] };
  if (!prepass.entries.size) return __scanProgramBeforeLoopProvenanceFix(args);

  const original = globalThis.AddressProvenance;
  const seeded = Object.freeze({
    ...original,
    create(options) {
      const inherited = Array.from(options?.entryKills || []);
      return original.create({
        ...options,
        entryKills: [...inherited, ...prepass.entries],
      });
    },
  });

  let pending;
  globalThis.AddressProvenance = seeded;
  try {
    // Calling an async function executes synchronously until its first await;
    // worker-legacy creates its provenance object before that point.
    pending = __scanProgramBeforeLoopProvenanceFix(args);
  } finally {
    globalThis.AddressProvenance = original;
  }
  return await pending;
};

/*
 * Keep worker-xref-memory-fix.js semantics, adding only selective first-visit
 * invalidation for GP registers that a backward loop edge may have redefined.
 */
findXrefs = async function findXrefsLoopSafe({ regionId, target, limit, requestId, epoch }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const prepass = await __backwardLoopEntryKills(region, requestId);
  if (prepass.cancelled) return { results:[], cancelled:true, capped:false };

  const want = BigInt(target);
  const cap = Math.min(Number(limit) || 2000, 2000);
  const total = Number(region.size);
  const out = [];
  const pageOf = new Array(32).fill(null);
  const pageAt = new Int32Array(32); pageAt.fill(-1);
  let index = 0, pos = 0;

  const pushHit = (byteOff, pc, kind) => {
    out.push({ row:byteOff / 4, addr:pc, kind });
    return out.length >= cap;
  };

  while (pos < total && out.length < cap) {
    if (cancelled(requestId)) return { results:out, cancelled:true, capped:false };
    const blk = await readRange(region.fileOffset + BigInt(pos), Math.min(1024 * 1024, total - pos));
    if (blk.length < 4) break;
    const words = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, words * 4);

    for (let i = 0; i < words; i++, index++) {
      const w = dv.getUint32(i * 4, true);
      const byteOff = pos + i * 4;
      const pc = region.vmAddr + BigInt(byteOff);
      const direct = Words.wordTarget(w, pc);
      if (direct != null && direct === want && pushHit(byteOff, pc, 'branch')) break;

      const loopKills = prepass.entries.get(pc);
      if (loopKills) {
        for (const reg of loopKills) {
          pageOf[reg] = null;
          pageAt[reg] = -1;
        }
      }

      /* Preserve worker-fixes.js control-boundary semantics exactly. */
      if (__controlBoundary(w)) {
        __clearPages(pageOf, pageAt);
        continue;
      }

      const rel = Words.pcRelTarget(w, pc);
      if (rel) {
        pageOf[rel.reg] = rel.value;
        pageAt[rel.reg] = index;
        if (!rel.page && rel.value === want && pushHit(byteOff, pc, 'address')) break;
        continue;
      }

      /* Preserve the pre-existing ADRP+ADD/ordinary unsigned-offset route. */
      const pair = Words.pairedOffset(w);
      let propagated = -1;
      if (pair && pageOf[pair.rn] != null && index - pageAt[pair.rn] <= 8) {
        const full = pageOf[pair.rn] + pair.imm;
        if (full === want && pushHit(byteOff, pc, pair.load ? 'load' : pair.store ? 'store' : 'address')) break;
        if (!pair.load && !pair.store) {
          pageOf[pair.rd] = full;
          pageAt[pair.rd] = index;
          propagated = pair.rd;
        } else if (pair.load && pair.rd < 31) {
          pageOf[pair.rd] = null;
          pageAt[pair.rd] = -1;
        }
      }

      const mem = Words.memoryAccess(w);
      if (mem && !pair && !mem.indexed && mem.disp != null &&
          pageOf[mem.base] != null && index - pageAt[mem.base] <= 8) {
        const first = mem.mode === 'post' ? pageOf[mem.base] : pageOf[mem.base] + mem.disp;
        const hitKind = mem.rmw ? 'rmw' : mem.load ? 'load' : 'store';
        if (first === want && pushHit(byteOff, pc, hitKind)) break;
        if (mem.pair && Number.isSafeInteger(mem.elementSize) && mem.elementSize > 0) {
          const second = first + BigInt(mem.elementSize);
          if (second === want && pushHit(byteOff, pc, hitKind)) break;
        }
      }

      if (__writesLowReg(w)) {
        const d = w & 31;
        if (d < 31 && d !== propagated) {
          pageOf[d] = null;
          pageAt[d] = -1;
        }
      }
    }

    pos += words * 4;
    scanProgress(requestId, epoch, pos, total, out.length);
    await yieldToQueue();
  }
  return { results:out, cancelled:false, capped:out.length >= cap };
};
