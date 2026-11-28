import { pick } from '../../i18n.js';
import { PATCH_RISK_LEVEL, GLOSSARY_KEY_SET } from '../../analysis/common/v6-auto-contracts.js';

export { PATCH_RISK_LEVEL };

/**
 * Exhaustive list of 33 ARM64e Pointer Authentication Code (PAC) mnemonics.
 * Modifying instructions in functions protected by PAC without re-signing or
 * preserving authentication chains will trigger immediate PAC auth faults.
 */
export const ARM64E_PAC_MNEMONIC_LIST = Object.freeze([
  'paciasp',
  'pacibsp',
  'paciaz',
  'pacibz',
  'autiasp',
  'autibsp',
  'autiaz',
  'autibz',
  'retaa',
  'retab',
  'xpaclri',
  'xpaci',
  'xpacd',
  'blraa',
  'blraaz',
  'blrab',
  'blrabz',
  'braa',
  'braaz',
  'brab',
  'brabz',
  'pacia',
  'pacib',
  'pacda',
  'pacdb',
  'autia',
  'autib',
  'autda',
  'autdb',
  'paciza',
  'pacizb',
  'pacdza',
  'pacdzb',
]);

const _pacMnemonicSet = new Set(ARM64E_PAC_MNEMONIC_LIST);

/**
 * Read-only Set-like facade over the 33 ARM64e PAC mnemonics.
 * Does not expose mutators (add / delete / clear).
 */
export const ARM64E_PAC_MNEMONICS = Object.freeze({
  size: _pacMnemonicSet.size,
  has(mnemonic) {
    return _pacMnemonicSet.has(mnemonic);
  },
  [Symbol.iterator]() {
    return _pacMnemonicSet[Symbol.iterator]();
  },
  values() {
    return _pacMnemonicSet.values();
  },
  keys() {
    return _pacMnemonicSet.keys();
  },
  entries() {
    return _pacMnemonicSet.entries();
  },
  forEach(callback, thisArg) {
    _pacMnemonicSet.forEach(callback, thisArg);
  },
});

const SYSCALL_MNEMONICS = new Set(['svc', 'syscall']);
const INDIRECT_BRANCH_MNEMONICS = new Set(['br', 'blr']);
const ATOMIC_RMW_RE = /^(?:ldxr|stxr|ldaxr|stlxr|ldxp|stxp|ldaxp|stlxp|cas(?:a|al|l)?[bh]?|ldadd(?:a|al|l)?[bh]?|ldclr(?:a|al|l)?[bh]?|ldeor(?:a|al|l)?[bh]?|ldset(?:a|al|l)?[bh]?|swp(?:a|al|l)?[bh]?|cmpxchg|xchg)$/;

const OBF_TAG_RE = /(?:obfuscated|high_entropy|cff|mba|vm_protect|packed)/i;
const CFF_TAG_RE = /\bcff\b|control_flow_flat/i;
const MBA_TAG_RE = /\bmba\b|mixed_boolean/i;
const CRYPTO_OR_INTEGRITY_TAG_RE = /(?:crypto|aes|sha|hash|hmac|rsa|chacha|md5|rc4|cipher|integrity|checksum|anti_debug|antidebug)/i;
const CANARY_TAG_RE = /(?:stack_canary|stack_chk|canary)/i;

const CALLGRAPH_ROLE_BY_ID = Object.freeze({
  0: 'normal',
  1: 'leaf_compute',
  2: 'dispatcher',
  3: 'utility_hub',
  4: 'recursive_scc',
});

const HIGH_RISK_THRESHOLD = 60;
const MEDIUM_RISK_THRESHOLD = 20;

function nonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseFirstMnemonicToken(raw) {
  const trimmed = nonEmptyString(raw);
  if (!trimmed) return null;
  const tokens = trimmed.split(/[\s,]+/);
  for (const token of tokens) {
    if (!token) continue;
    // Skip leading address or label prefixes like "0x1000:" or "loc_1000:"
    if (token.endsWith(':')) continue;
    // Ignore inline comment markers
    if (token.startsWith(';') || token.startsWith('//')) break;
    return token.toLowerCase();
  }
  return null;
}

/**
 * Extract a normalized lowercase instruction mnemonic from a string or instruction object.
 * Inspects `mnemonic ?? mn ?? op ?? text` in priority order.
 *
 * @param {string|{ mnemonic?: string, mn?: string, op?: string, text?: string }|null|undefined} insn
 * @returns {string|null}
 */
export function extractInstructionMnemonic(insn) {
  if (insn == null) return null;
  if (typeof insn === 'string') {
    return parseFirstMnemonicToken(insn);
  }
  if (typeof insn === 'object') {
    const candidates = [insn.mnemonic, insn.mn, insn.op, insn.text];
    for (const cand of candidates) {
      const token = parseFirstMnemonicToken(cand);
      if (token) return token;
    }
  }
  return null;
}

export { extractInstructionMnemonic as extractMnemonic };

function resolveCallgraphRoleName(callgraph) {
  if (!callgraph || typeof callgraph !== 'object') return 'normal';
  const explicitName = nonEmptyString(callgraph.roleName);
  if (explicitName) return explicitName.toLowerCase();
  if (typeof callgraph.role === 'string') {
    const asStr = nonEmptyString(callgraph.role);
    if (asStr) return asStr.toLowerCase();
  }
  const roleNum = Number(callgraph.role);
  if (Number.isInteger(roleNum) && Object.hasOwn(CALLGRAPH_ROLE_BY_ID, roleNum)) {
    return CALLGRAPH_ROLE_BY_ID[roleNum];
  }
  return 'normal';
}

function resolveIncomingXrefCount(xrefs) {
  if (Array.isArray(xrefs)) return xrefs.length;
  if (xrefs && typeof xrefs === 'object') {
    const n = Number(xrefs.inCount);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return 0;
}

function resolveCfgBlockCount(cfg) {
  if (!cfg || typeof cfg !== 'object') return 0;
  if (Array.isArray(cfg.blocks)) return cfg.blocks.length;
  const n = Number(cfg.blockCount);
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  return 0;
}

function toNonNegativeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function buildFailSafeResult(reasons, cautions, glossaryKeys) {
  return {
    level: PATCH_RISK_LEVEL.UNKNOWN,
    score: null,
    reasons,
    cautions,
    glossaryKeys,
    isFailSafe: true,
  };
}

/**
 * Assess patch risk for a function from available static/WASM/deobf evidence.
 *
 * Fail-safe contract:
 * - Missing/non-object/empty evidence, unavailable WASM hints without instructions,
 *   or `!hasInstructions && score < 20` ALWAYS return `level: 'UNKNOWN'`,
 *   `score: null`, `isFailSafe: true` rather than falsely claiming `LOW`.
 * - Scores are clamped to `0..100`.
 *
 * @param {object|null|undefined} evidence
 * @returns {{
 *   level: 'LOW'|'MEDIUM'|'HIGH'|'UNKNOWN',
 *   score: number|null,
 *   reasons: string[],
 *   cautions: string[],
 *   glossaryKeys: string[],
 *   isFailSafe: boolean,
 * }}
 */
export function assessPatchRisk(evidence) {
  const reasons = [];
  const cautions = [];
  const glossaryKeys = [];
  const reasonSet = new Set();
  const cautionSet = new Set();
  const glossarySet = new Set();

  const addReason = (text) => {
    const clean = nonEmptyString(text);
    if (clean && !reasonSet.has(clean)) {
      reasonSet.add(clean);
      reasons.push(clean);
    }
  };

  const addCaution = (text) => {
    const clean = nonEmptyString(text);
    if (clean && !cautionSet.has(clean)) {
      cautionSet.add(clean);
      cautions.push(clean);
    }
  };

  const addGlossaryKey = (key) => {
    if (typeof key === 'string' && GLOSSARY_KEY_SET.has(key) && !glossarySet.has(key)) {
      glossarySet.add(key);
      glossaryKeys.push(key);
    }
  };

  addGlossaryKey('patch');

  if (!evidence || typeof evidence !== 'object') {
    addReason(pick(
      '解析証拠が不足しているため、パッチの安全性を判定できません。',
      'Insufficient analysis evidence to determine patch safety.',
    ));
    addCaution(pick(
      '安全と断定せず、関数の命令列や参照元を確認してからパッチを検討してください。',
      'Do not assume it is safe to patch; inspect the instructions and callers first.',
    ));
    return buildFailSafeResult(reasons, cautions, glossaryKeys);
  }

  let rawScore = 0;

  // 1. Inspect instructions
  const rawInstructions = Array.isArray(evidence.instructions) ? evidence.instructions : [];
  const extractedMnemonics = [];
  for (const insn of rawInstructions) {
    const mn = extractInstructionMnemonic(insn);
    if (mn) extractedMnemonics.push(mn);
  }
  const hasInstructions = extractedMnemonics.length > 0;

  const detectedPac = [];
  const detectedPacSet = new Set();
  let hasSyscall = false;
  let hasIndirectBranch = false;
  let hasAtomicInsn = false;

  for (const mn of extractedMnemonics) {
    if (ARM64E_PAC_MNEMONICS.has(mn)) {
      if (!detectedPacSet.has(mn)) {
        detectedPacSet.add(mn);
        detectedPac.push(mn);
      }
    } else if (SYSCALL_MNEMONICS.has(mn)) {
      hasSyscall = true;
    } else if (INDIRECT_BRANCH_MNEMONICS.has(mn)) {
      hasIndirectBranch = true;
    }
    if (ATOMIC_RMW_RE.test(mn)) {
      hasAtomicInsn = true;
    }
  }

  if (detectedPac.length > 0) {
    rawScore += detectedPac.length >= 2 ? 65 : 60;
    const sample = detectedPac.slice(0, 3).join(', ');
    addReason(pick(
      `ARM64e PAC（ポインタ認証）命令を検出しました（${sample}）。`,
      `Detected ARM64e PAC (Pointer Authentication) instructions (${sample}).`,
    ));
    addCaution(pick(
      'PAC 保護された関数の戻り先や関数ポインタを不用意に書き換えると、認証失敗で即座にクラッシュします。',
      'Patching a PAC-protected function without preserving authentication chains causes immediate crash faults.',
    ));
    addGlossaryKey('pac');
    if (detectedPac.some((m) => m.startsWith('pac') && (m.endsWith('sp') || m.endsWith('z')))) {
      addGlossaryKey('prologue');
    }
    if (detectedPac.some((m) => m.startsWith('aut') || m === 'retaa' || m === 'retab')) {
      addGlossaryKey('epilogue');
    }
  }

  if (hasSyscall) {
    rawScore += 25;
    addReason(pick(
      'OS カーネルを直接呼び出すシステムコール命令を含んでいます。',
      'Contains direct system call instructions invoking the OS kernel.',
    ));
    addCaution(pick(
      'レジスタ引数や戻り値の規約を崩すと、OS 側でエラー終了や強制終了が発生します。',
      'Breaking register conventions around system calls can trigger kernel errors or termination.',
    ));
    addGlossaryKey('syscall');
  }

  if (hasIndirectBranch) {
    rawScore += 15;
    addReason(pick(
      'レジスタ経由の間接分岐・間接呼び出し命令を含んでいます。',
      'Contains register-indirect branch or call instructions.',
    ));
    addCaution(pick(
      'ジャンプ先が動的に決まるため、レジスタ値の変更やコード配置のずれに注意してください。',
      'Branch targets are computed dynamically; avoid disturbing target registers or code layout.',
    ));
    addGlossaryKey('branch');
    addGlossaryKey('pointer');
  }

  // 2. Inspect deobf overlay
  const hasDeobfOverlay = Boolean(evidence.deobfOverlay && evidence.deobfOverlay.hasOverlay === true);
  if (hasDeobfOverlay) {
    rawScore += 35;
    addReason(pick(
      '難読化解除オーバーレイが適用されており、元の制御構造が複雑化されています。',
      'A deobfuscation overlay is active, indicating obfuscated control flow or expressions.',
    ));
    addCaution(pick(
      '難読化されたコードの局所パッチは状態遷移を壊しやすいため、制御フロー全体を確認してください。',
      'Local patches in obfuscated code can break state transitions; verify the full control flow first.',
    ));
    addGlossaryKey('cff');
    addGlossaryKey('decompile');
  }

  // 3. Inspect WASM hints (strictly gated by available !== false)
  const wasmHints = evidence.wasmHints && typeof evidence.wasmHints === 'object' ? evidence.wasmHints : null;
  const wasmAvailable = Boolean(wasmHints && wasmHints.available !== false);

  let hasRmw = hasAtomicInsn;
  let hasStackCanary = evidence.hasStackCanary === true;

  if (wasmAvailable) {
    const tags = Array.isArray(wasmHints.tags)
      ? wasmHints.tags.filter((t) => typeof t === 'string' && t.trim().length > 0)
      : [];

    if (tags.some((t) => CANARY_TAG_RE.test(t))) {
      hasStackCanary = true;
    }

    const hasObfTag = tags.some((t) => OBF_TAG_RE.test(t));
    if (hasObfTag) {
      rawScore += hasDeobfOverlay ? 15 : 35;
      if (!hasDeobfOverlay) {
        addReason(pick(
          '難読化または高エントロピーの兆候が検出されています。',
          'Signs of obfuscation or high entropy were detected.',
        ));
        addCaution(pick(
          '難読化関数は改ざん検知や状態機械を含む場合があるため慎重に検証してください。',
          'Obfuscated functions may include tamper checks or state machines; verify carefully.',
        ));
      }
      if (tags.some((t) => CFF_TAG_RE.test(t))) addGlossaryKey('cff');
      if (tags.some((t) => MBA_TAG_RE.test(t))) addGlossaryKey('mba');
    }

    if (tags.some((t) => CRYPTO_OR_INTEGRITY_TAG_RE.test(t))) {
      rawScore += 20;
      addReason(pick(
        '暗号処理または整合性検証に関連する特徴が検出されています。',
        'Characteristics of cryptography or integrity verification were detected.',
      ));
      addCaution(pick(
        '検証ロジックや鍵計算を変更すると、署名・整合性チェックに失敗する可能性があります。',
        'Altering cryptographic or integrity routines may cause verification failures.',
      ));
    }

    const roleName = resolveCallgraphRoleName(wasmHints.callgraph);
    if (roleName === 'utility_hub') {
      rawScore += 35;
      addReason(pick(
        '多数の関数から呼び出される共通ユーティリティハブ（utility_hub）です。',
        'Identified as a shared utility hub (utility_hub) called from many locations.',
      ));
      addCaution(pick(
        'この関数を直接パッチするとアプリ全体の挙動に波及するため、呼び出し元での個別修正を検討してください。',
        'Patching a utility hub affects many callers across the binary; consider patching a specific caller instead.',
      ));
      addGlossaryKey('xref');
    } else if (roleName === 'dispatcher' || roleName === 'recursive_scc') {
      rawScore += 25;
      addReason(pick(
        `コールグラフ上で重要な役割（${roleName}）を担っています。`,
        `Plays a critical call-graph role (${roleName}).`,
      ));
      addCaution(pick(
        '分岐振り分けや再帰構造の前提を崩さないよう、呼び出し関係を確認してください。',
        'Review call relationships to avoid breaking dispatch or recursion invariants.',
      ));
      addGlossaryKey('cfg');
      addGlossaryKey('branch');
    }

    const jumpTableCount = toNonNegativeInt(wasmHints.jumpTableCount);
    if (jumpTableCount > 0) {
      rawScore += jumpTableCount >= 2 ? 30 : 25;
      addReason(pick(
        `ジャンプテーブルを ${jumpTableCount} 件使用しています。`,
        `Uses ${jumpTableCount} jump table(s) for multi-way branching.`,
      ));
      addCaution(pick(
        '命令長やオフセットを変えるとジャンプテーブルの参照先がずれ、クラッシュの原因になります。',
        'Changing instruction lengths or offsets can misalign jump table targets and cause crashes.',
      ));
      addGlossaryKey('branch');
      addGlossaryKey('cfg');
    }

    const rmwHitCount = toNonNegativeInt(wasmHints.rmwHitCount);
    if (rmwHitCount > 0) {
      hasRmw = true;
    }

    const constTableRefCount = Array.isArray(wasmHints.constTableRefs) ? wasmHints.constTableRefs.length : 0;
    if (constTableRefCount > 0) {
      rawScore += 15;
      addReason(pick(
        `定数テーブルへの参照が ${constTableRefCount} 件あります。`,
        `References ${constTableRefCount} constant table(s).`,
      ));
      addCaution(pick(
        '定数テーブル参照のオフセットやデータ整合性を壊さないよう注意してください。',
        'Preserve constant table offsets and data alignment when patching.',
      ));
      addGlossaryKey('pointer');
    }
  }

  // 4. Atomic / RMW risk (from instructions or WASM hints)
  if (hasRmw) {
    rawScore += 25;
    addReason(pick(
      'アトミック操作（Read-Modify-Write）を含んでいます。',
      'Contains atomic Read-Modify-Write (RMW) operations.',
    ));
    addCaution(pick(
      '排他制御やスレッド同期に関わるため、パッチにより競合やデッドロックが起きる恐れがあります。',
      'Atomic operations guard thread synchronization; patching may cause race conditions or deadlocks.',
    ));
  }

  // 5. Stack canary protection
  if (hasStackCanary) {
    rawScore += 30;
    addReason(pick(
      'スタックカナリア（スタック破壊検知）が有効な関数です。',
      'Protected by a stack canary (stack smash protection).',
    ));
    addCaution(pick(
      'スタックフレームのレイアウトやエピローグの検証処理を変更すると強制終了します。',
      'Modifying stack frame layout or epilogue canary checks will abort execution.',
    ));
    addGlossaryKey('stack_frame');
    addGlossaryKey('epilogue');
  }

  // 6. System library function
  if (evidence.isSystemLibrary === true) {
    rawScore += 25;
    addReason(pick(
      'システムまたは共有ライブラリ由来の関数です。',
      'Belongs to a system or shared library.',
    ));
    addCaution(pick(
      'ライブラリ関数の改変は意図しない副作用を招きやすいため、アプリ固有の呼び出し元を優先してください。',
      'Modifying library routines can cause broad side effects; prefer patching app-specific callers.',
    ));
  }

  // 7. Incoming cross-references (xrefs)
  const inXrefCount = resolveIncomingXrefCount(evidence.xrefs);
  if (inXrefCount >= 20) {
    rawScore += 35;
    addReason(pick(
      `多数の箇所（${inXrefCount} 件）から参照されており、影響範囲が広大です。`,
      `Referenced from ${inXrefCount} locations, giving it a wide blast radius.`,
    ));
    addCaution(pick(
      '1 箇所の修正がアプリ全体の動作に波及する可能性があります。',
      'A single patch here can impact many unrelated code paths.',
    ));
    addGlossaryKey('xref');
  } else if (inXrefCount >= 5) {
    rawScore += 20;
    addReason(pick(
      `複数箇所（${inXrefCount} 件）から参照されています。`,
      `Referenced from ${inXrefCount} callers.`,
    ));
    addCaution(pick(
      'すべての呼び出し元で期待される戻り値・副作用を確認してください。',
      'Verify expected return values and side effects across all callers.',
    ));
    addGlossaryKey('xref');
  } else if (inXrefCount >= 2) {
    rawScore += 10;
    addReason(pick(
      `${inXrefCount} 箇所から呼び出されています。`,
      `Called from ${inXrefCount} locations.`,
    ));
    addGlossaryKey('xref');
  }

  // 8. CFG complexity
  const cfgBlocks = resolveCfgBlockCount(evidence.cfg);
  if (cfgBlocks >= 20) {
    rawScore += 20;
    addReason(pick(
      `制御フローグラフが複雑です（${cfgBlocks} ブロック）。`,
      `Complex control-flow graph (${cfgBlocks} basic blocks).`,
    ));
    addCaution(pick(
      '分岐条件や合流点でのレジスタ状態を見落とさないよう注意してください。',
      'Check register liveness across branch merges before modifying instructions.',
    ));
    addGlossaryKey('cfg');
    addGlossaryKey('branch');
  } else if (cfgBlocks >= 8) {
    rawScore += 10;
    addReason(pick(
      `分岐ブロックがやや多い構造です（${cfgBlocks} ブロック）。`,
      `Moderately branched control-flow graph (${cfgBlocks} basic blocks).`,
    ));
    addGlossaryKey('cfg');
    addGlossaryKey('branch');
  }

  const clampedScore = Math.max(0, Math.min(100, Math.round(rawScore)));

  // Fail-safe rule: without instructions and without sufficient risk evidence (score < 20),
  // never falsely report LOW; always fail safe to UNKNOWN.
  if (!hasInstructions && clampedScore < MEDIUM_RISK_THRESHOLD) {
    if (wasmHints && wasmHints.available === false) {
      addReason(pick(
        'WASM 自動解析ヒントが利用不可で、命令列も未取得のため危険度を判定できません。',
        'WASM analysis hints are unavailable and no instructions were provided; risk cannot be assessed.',
      ));
    } else {
      addReason(pick(
        '命令列が未取得で十分なリスク証拠がないため、安全と断定できません。',
        'No instructions were provided and risk evidence is insufficient to conclude it is safe.',
      ));
    }
    addCaution(pick(
      'まず関数の逆アセンブル命令を読み込み、保護機構や呼び出し元を確認してください。',
      'Load the function disassembly first to verify protections and callers.',
    ));
    return buildFailSafeResult(reasons, cautions, glossaryKeys);
  }

  let level = PATCH_RISK_LEVEL.LOW;
  if (clampedScore >= HIGH_RISK_THRESHOLD) {
    level = PATCH_RISK_LEVEL.HIGH;
  } else if (clampedScore >= MEDIUM_RISK_THRESHOLD) {
    level = PATCH_RISK_LEVEL.MEDIUM;
  }

  if (level === PATCH_RISK_LEVEL.LOW) {
    if (reasons.length === 0) {
      addReason(pick(
        'PAC・スタックカナリア・難読化などの高リスク保護機構は検出されませんでした。',
        'No high-risk protections such as PAC, stack canaries, or obfuscation were detected.',
      ));
    }
    if (cautions.length === 0) {
      addCaution(pick(
        '低リスクと判定されましたが、パッチ前には元のバイト列を控え、呼び出し規約を維持してください。',
        'Although rated low risk, keep a backup of the original bytes and preserve the calling convention.',
      ));
    }
    addGlossaryKey('calling_convention');
  } else if (cautions.length === 0) {
    addCaution(pick(
      'パッチ適用後は戻り値・スタック・分岐先が正しく保たれるか検証してください。',
      'Verify return values, stack balance, and branch targets after patching.',
    ));
  }

  return {
    level,
    score: clampedScore,
    reasons,
    cautions,
    glossaryKeys,
    isFailSafe: false,
  };
}
