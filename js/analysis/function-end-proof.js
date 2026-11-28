/*
 * CFG reachability proof of function end for binaries whose loader metadata
 * supplies function start addresses without exact extents (e.g. Mach-O
 * LC_FUNCTION_STARTS).
 *
 * Static range contracts (`validatedFunctionRange` / `rangeFor`) intentionally
 * remain `complete: false, reason: 'function-end-unproven'`. After decoding
 * instructions within `[start, windowEnd)`, this module inspects the entry-
 * reachable CFG and promotes to `proven: true` ONLY when every reachable
 * path stays strictly within `[start, windowEnd)`, executes only decoded
 * instructions, and terminates in a closed exit.
 */

const RET_MN_RE = /^(?:ret|retaa|retab)$/;
const TRAP_MN_RE = /^(?:brk|udf)$/;
const CALL_MN_RE = /^(?:bl|blr|blraa|blrab|blraaz|blrabz)$/;
const INDIRECT_BRANCH_MN_RE = /^(?:br|braa|brab|braaz|brabz)$/;
const COND_BRANCH_MN_RE = /^(?:b\.[a-z]{2}|cbz|cbnz|tbz|tbnz)$/;
const X16_OR_X17_OP_RE = /^\s*x(?:16|17)\b/i;
const X16_OR_X17_DEST_RE = /^\s*[xw](?:16|17)\b/i;
const REG_INDEXED_MEM_RE = /\[\s*[xw]\d+\s*,\s*[xw]\d+/i;
const REG_ADD_TO_X16_17_RE = /^\s*[xw](?:16|17)\s*,\s*[xw]\d+\s*,\s*[xw]\d+/i;
const IMM_ADD_TO_X16_17_RE = /^\s*x(?:16|17)\s*,\s*x(?:16|17)\s*,\s*#/i;
const GOT_LDR_TO_X16_17_RE = /^\s*x(?:16|17)\s*,\s*\[\s*x(?:16|17)(?:\s*,\s*#[^\]]+)?\s*\]/i;
const LITERAL_LDR_TO_X16_17_RE = /^\s*x(?:16|17)\s*,\s*(?:#|0x|[a-z_])/i;
const DISQUALIFYING_COMPUTE_MN_RE = /^(?:sub|subs|madd|msub|mul|lsl|lsr|asr|orr|and|eor|bfm|ubfm|sbfm|addg|subg)$/;
const COMPUTED_LOAD_MN_RE = /^(?:ldr|ldrb|ldrh|ldrsb|ldrsh|ldrsw|ldur|ldurb|ldurh|ldursb|ldursh|ldursw)$/;
const CONTROL_FLOW_STOP_MN_RE = /^(?:b|b\.[a-z]{2}|cbz|cbnz|tbz|tbnz|bl|blr|blraa|blrab|blraaz|blrabz|br|braa|brab|braaz|brabz|ret|retaa|retab|brk|udf)$/;

const NORETURN_PATTERNS = [
  /^_*stack_chk_fail(?:\b|$)/,
  /^_*objc_exception_(?:throw|rethrow)(?:\b|$)/,
  /^_*objc_terminate(?:\b|$)/,
  /^_*cxa_(?:throw|rethrow|pure_virtual|deleted_virtual|bad_cast|bad_typeid|call_unexpected)(?:\b|$)/,
  /^_*assert_(?:rtn|fail)(?:\b|$)/,
  /^_*(?:abort|abort_with_reason|abort_with_payload|exit|_exit|_Exit|quick_exit|longjmp|siglongjmp|pthread_exit)(?:\b|$)/,
  /^_*swift_(?:fatalError|deletedMethodError|unexpectedError)(?:\b|$)/,
  /^_*NSException(?:\b|$)/,
  /^[+-]\[NSException\s+raise(?::|\])/,
  /^_*_Z(?:NSt3__1|St)\d*__throw_/,
  /^_*_ZSt9terminatev(?:\b|$)/,
  /^_*Unwind_Resume(?:_or_Rethrow)?(?:\b|$)/,
  /^_*clang_call_terminate(?:\b|$)/,
  /^std::(?:__1::)?(?:terminate|__throw_)/,
];

function toBigIntOrNull(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && value.trim()) {
    try { return BigInt(value.trim()); } catch { return null; }
  }
  return null;
}

function isKnownNoreturnName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  for (const re of NORETURN_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  return false;
}

function isX16OrX17IndirectTarget(insn) {
  const op0 = Array.isArray(insn?.ops) ? insn.ops[0] : null;
  if (op0 && op0.k === 'reg' && op0.cls === 'gp') {
    return op0.num === 16 || op0.num === 17;
  }
  return typeof insn?.operands === 'string' && X16_OR_X17_OP_RE.test(insn.operands);
}

function isPltOrObjcTailStubBranch(insn, blockInsns = null, idx = -1) {
  if (!isX16OrX17IndirectTarget(insn)) return false;
  if (!Array.isArray(blockInsns) || idx <= 0) return false;

  let sawAdrp = false;
  let sawAdr = false;
  let sawGotLdr = false;
  let sawLiteralLdr = false;
  let sawImmAdd = false;

  const minIdx = Math.max(0, idx - 5);
  for (let i = idx - 1; i >= minIdx; i--) {
    const prev = blockInsns[i];
    if (!prev) break;
    const prevBase = typeof prev.mnemonic === 'string' ? prev.mnemonic.trim().toLowerCase() : '';
    if (!prevBase || CONTROL_FLOW_STOP_MN_RE.test(prevBase)) break;
    const prevOps = typeof prev.operands === 'string' ? prev.operands.trim() : '';
    if (!X16_OR_X17_DEST_RE.test(prevOps)) continue;

    // Disqualify computed switch / jump-table arithmetic into x16/x17
    if (prevBase === 'add' && REG_ADD_TO_X16_17_RE.test(prevOps)) return false;
    if (DISQUALIFYING_COMPUTE_MN_RE.test(prevBase)) return false;
    if (COMPUTED_LOAD_MN_RE.test(prevBase) && REG_INDEXED_MEM_RE.test(prevOps)) return false;

    if (prevBase === 'adrp') {
      sawAdrp = true;
    } else if (prevBase === 'adr') {
      sawAdr = true;
    } else if (prevBase === 'add' && IMM_ADD_TO_X16_17_RE.test(prevOps)) {
      sawImmAdd = true;
    } else if (prevBase === 'ldr') {
      if (GOT_LDR_TO_X16_17_RE.test(prevOps)) sawGotLdr = true;
      else if (LITERAL_LDR_TO_X16_17_RE.test(prevOps)) sawLiteralLdr = true;
    }
  }

  if (sawAdrp && (sawGotLdr || sawImmAdd)) return true;
  if (sawAdr || sawLiteralLdr) return true;
  if (idx <= 3 && sawGotLdr) return true;
  return false;
}

function provenEndProvenance(range) {
  const raw = typeof range?.provenance === 'string' ? range.provenance.trim() : '';
  if (raw && /^elf\b/i.test(raw)) {
    return `${raw.replace(/\+section-analysis-window$|\+analysis-window$/i, '')}+cfg-proven-end`;
  }
  if (raw && !raw.startsWith('executable-region') && !raw.startsWith('macho')) {
    return `${raw.replace(/\+analysis-window$/i, '')}+cfg-proven-end`;
  }
  return 'macho-function-starts+cfg-proven-end';
}

function isUndecodedOrInvalid(insn, base) {
  if (!insn || insn.data === true || insn.unknown === true) return true;
  if (!base || base.charCodeAt(0) === 46) return true;
  if (base === 'unknown' || base === '???') return true;
  return false;
}

function resolveCallName(insn, callNameByRow, symbols) {
  const fromCalls = callNameByRow.get(insn.row);
  if (fromCalls) return fromCalls;
  const target = toBigIntOrNull(insn.callTarget);
  if (target == null || !symbols) return null;
  try {
    return symbols.nameAt?.(target) ?? symbols.label?.(target) ?? null;
  } catch {
    return null;
  }
}

function resolveJumpTableTargets(insn, model) {
  const direct = insn?.jumpTableTargets;
  if (Array.isArray(direct) && direct.length > 0) return direct;
  const tables = model?.jumpTables;
  if (!Array.isArray(tables) || tables.length === 0) return null;
  for (const jt of tables) {
    if (!jt) continue;
    const matchRow = jt.branchRow != null && jt.branchRow === insn.row;
    const matchAddr = jt.branchAddress != null && insn.address != null
      && toBigIntOrNull(jt.branchAddress) === toBigIntOrNull(insn.address);
    if ((matchRow || matchAddr) && Array.isArray(jt.targets) && jt.targets.length > 0) {
      return jt.targets;
    }
  }
  return null;
}

/**
 * Prove the end address of a function whose static extent is unproven (`fn.end == null`)
 * using entry-reachable CFG closure within `[range.start, range.end)`.
 *
 * @param {object} model  Semantic model from `buildSemanticModel` / `analyzeFunction`
 * @param {object} range  Range object `{ start, end, function? }`
 * @param {object} [symbols] SymbolIndex (used to resolve noreturn call targets)
 * @returns {{ proven: true, provenEnd: bigint, reason: null, provenance: string } | { proven: false, reason: 'function-end-unproven' }}
 */
export function proveFunctionEnd(model, range, symbols = null) {
  const unproven = { proven: false, reason: 'function-end-unproven' };
  if (!model || typeof model !== 'object' || model.truncated === true) return unproven;
  const insns = model.instructions;
  if (!Array.isArray(insns) || insns.length === 0) return unproven;
  if (!range || typeof range !== 'object') return unproven;
  if (range.function && range.function.end != null) return unproven;

  const start = toBigIntOrNull(range.start);
  const windowEnd = toBigIntOrNull(range.end);
  if (start == null || windowEnd == null || windowEnd <= start) return unproven;

  const addrToIdx = new Map();
  for (let i = 0; i < insns.length; i++) {
    const addr = toBigIntOrNull(insns[i]?.address);
    if (addr == null || addr < start || addr >= windowEnd) continue;
    if (!addrToIdx.has(addr)) addrToIdx.set(addr, i);
  }

  const entryIdx = addrToIdx.get(start);
  if (entryIdx == null) return unproven;

  const callNameByRow = new Map();
  if (Array.isArray(model.calls)) {
    for (const c of model.calls) {
      if (c && c.row != null && typeof c.name === 'string' && c.name) {
        callNameByRow.set(c.row, c.name);
      }
    }
  }

  const visited = new Uint8Array(insns.length);
  const stack = [entryIdx];
  let maxReachableEnd = start;

  while (stack.length > 0) {
    const idx = stack.pop();
    if (visited[idx]) continue;
    visited[idx] = 1;

    const insn = insns[idx];
    const addr = toBigIntOrNull(insn?.address);
    if (addr == null || addr < start || addr >= windowEnd) return unproven;

    const base = typeof insn.mnemonic === 'string' ? insn.mnemonic.trim().toLowerCase() : '';
    if (isUndecodedOrInvalid(insn, base)) return unproven;

    const insnSize = typeof insn.size === 'number' && Number.isSafeInteger(insn.size) && insn.size > 0
      ? BigInt(insn.size)
      : 4n;
    const nextAddr = addr + insnSize;
    if (nextAddr > windowEnd) return unproven;
    if (nextAddr > maxReachableEnd) maxReachableEnd = nextAddr;

    // 1. Return instruction (ret / retaa / retab)
    if (insn.isReturn === true || RET_MN_RE.test(base)) {
      continue;
    }

    // 2. Explicit trap (brk / udf)
    if (TRAP_MN_RE.test(base)) {
      continue;
    }

    // 3. Unconditional direct branch: internal jump or external tail call (including target === windowEnd)
    if (base === 'b') {
      const target = toBigIntOrNull(insn.branchTarget ?? insn.callTarget);
      if (target == null) return unproven;
      if (target < start || target >= windowEnd) {
        // Closed unconditional tail call outside [start, windowEnd)
        continue;
      }
      const targetIdx = addrToIdx.get(target);
      if (targetIdx == null) return unproven;
      if (!visited[targetIdx]) stack.push(targetIdx);
      continue;
    }

    // 4. Indirect branch (br / braa / brab / braaz / brabz)
    if (INDIRECT_BRANCH_MN_RE.test(base)) {
      const jtTargets = resolveJumpTableTargets(insn, model);
      if (jtTargets) {
        for (const rawTarget of jtTargets) {
          const target = toBigIntOrNull(rawTarget);
          if (target == null || target < start || target >= windowEnd) return unproven;
          const targetIdx = addrToIdx.get(target);
          if (targetIdx == null) return unproven;
          if (!visited[targetIdx]) stack.push(targetIdx);
        }
        continue;
      }
      if (isPltOrObjcTailStubBranch(insn, insns, idx)) {
        // PLT/GOT/ObjC tail-call stub via x16/x17
        continue;
      }
      return unproven;
    }

    // 5. Conditional branch (b.cond / cbz / cbnz / tbz / tbnz)
    if (insn.isConditional === true || COND_BRANCH_MN_RE.test(base)) {
      const target = toBigIntOrNull(insn.branchTarget);
      if (target == null || target < start || target >= windowEnd) {
        // Conditional branch outside [start, windowEnd) is not closed
        return unproven;
      }
      const targetIdx = addrToIdx.get(target);
      if (targetIdx == null) return unproven;
      if (!visited[targetIdx]) stack.push(targetIdx);

      // Fallthrough must stay strictly inside [start, windowEnd)
      if (nextAddr >= windowEnd) return unproven;
      const fallIdx = addrToIdx.get(nextAddr);
      if (fallIdx == null) return unproven;
      if (!visited[fallIdx]) stack.push(fallIdx);
      continue;
    }

    // 6. Call instruction (bl / blr / PAC blr*)
    if (CALL_MN_RE.test(base)) {
      if (base === 'bl') {
        const calleeName = resolveCallName(insn, callNameByRow, symbols);
        if (isKnownNoreturnName(calleeName)) {
          // Known noreturn call closes this path
          continue;
        }
      }
      if (nextAddr >= windowEnd) return unproven;
      const fallIdx = addrToIdx.get(nextAddr);
      if (fallIdx == null) return unproven;
      if (!visited[fallIdx]) stack.push(fallIdx);
      continue;
    }

    // 7. Ordinary non-terminating instruction: fall through to nextAddr
    if (nextAddr >= windowEnd) return unproven;
    const fallIdx = addrToIdx.get(nextAddr);
    if (fallIdx == null) return unproven;
    if (!visited[fallIdx]) stack.push(fallIdx);
  }

  if (maxReachableEnd <= start || maxReachableEnd > windowEnd) return unproven;

  return {
    proven: true,
    provenEnd: maxReachableEnd,
    reason: null,
    provenance: provenEndProvenance(range),
  };
}

/**
 * Create a non-destructive shallow copy of `model` trimmed to `[start, provenEnd)`.
 * Keeps cached `model` and its nested arrays/objects intact.
 *
 * @param {object} model
 * @param {bigint|number|string} provenEnd
 * @returns {object}
 */
export function trimModelToProvenEnd(model, provenEnd) {
  if (!model || typeof model !== 'object') return model;
  const endAddr = toBigIntOrNull(provenEnd);
  if (endAddr == null) return { ...model };

  const origInsns = Array.isArray(model.instructions) ? model.instructions : [];
  const instructions = origInsns.filter((insn) => {
    const addr = toBigIntOrNull(insn?.address);
    return addr != null && addr < endAddr;
  });

  const endRow = instructions.length > 0
    ? instructions[instructions.length - 1].row
    : model.endRow;

  const trimBlockList = (list, reindex) => {
    if (!Array.isArray(list)) return list;
    const out = [];
    for (const block of list) {
      if (!block || block.startRow > endRow) continue;
      if (block.endRow > endRow) {
        const rows = Array.isArray(block.rows) ? block.rows.filter((r) => r <= endRow) : block.rows;
        if (Array.isArray(rows) && rows.length === 0) continue;
        const clampedEnd = Array.isArray(rows) && rows.length > 0
          ? rows[rows.length - 1]
          : Math.min(block.endRow, endRow);
        out.push(reindex
          ? { ...block, index: out.length, endRow: clampedEnd, rows }
          : { ...block, endRow: clampedEnd, rows });
      } else {
        out.push(reindex ? { ...block, index: out.length } : { ...block });
      }
    }
    return out;
  };

  const basicBlocks = trimBlockList(model.basicBlocks, true);
  const semantic = trimBlockList(model.semantic, false);

  const filterByRow = (list) => (
    Array.isArray(list) ? list.filter((item) => item == null || item.row == null || item.row <= endRow) : list
  );

  const backEdges = Array.isArray(model.backEdges)
    ? model.backEdges.filter((e) => e && e.from <= endRow && e.to <= endRow)
    : model.backEdges;

  let flowByRow = model.flowByRow;
  if (model.flowByRow instanceof Map) {
    flowByRow = new Map();
    for (const [row, val] of model.flowByRow.entries()) {
      if (row <= endRow) flowByRow.set(row, val);
    }
  }

  const trimmed = {
    ...model,
    endRow,
    instructions,
    basicBlocks,
    semantic,
    backEdges,
    calls: filterByRow(model.calls),
    flows: filterByRow(model.flows),
    addressRefs: filterByRow(model.addressRefs),
    diagnostics: filterByRow(model.diagnostics),
    flowByRow,
  };

  if (Array.isArray(semantic)) {
    trimmed.blockOfRow = (row) => semantic.find((b) => row >= b.startRow && row <= b.endRow) || null;
  } else if (typeof model.blockOfRow === 'function') {
    trimmed.blockOfRow = (row) => (row <= endRow ? model.blockOfRow(row) : null);
  }

  return trimmed;
}
