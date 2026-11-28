import { pick } from '../../i18n.js';
import { GLOSSARY_KEY_SET, isStrippedFunctionName } from '../../analysis/common/v6-auto-contracts.js';

const VALID_BADGE_TONES = new Set(['info', 'ok', 'warn']);

const CALLGRAPH_ROLE_BY_ID = Object.freeze({
  0: 'normal',
  1: 'leaf_compute',
  2: 'dispatcher',
  3: 'utility_hub',
  4: 'recursive_scc',
});

const CRYPTO_TAG_RE = /(?:crypto|aes|sha|hash|hmac|rsa|chacha|md5|rc4|cipher)/i;
const OBF_TAG_RE = /(?:obfuscated|high_entropy|cff|mba|vm_protect|packed)/i;

function nonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveCallgraphRoleName(callgraph) {
  if (!callgraph || typeof callgraph !== 'object') return 'normal';
  const roleName = nonEmptyString(callgraph.roleName);
  if (roleName) return roleName.toLowerCase();
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

function describeStlKind(kind) {
  const lower = String(kind || '').toLowerCase();
  if (lower.includes('vector')) {
    return pick('可変長配列 (std::vector)', 'resizable array (std::vector)');
  }
  if (lower.includes('string')) {
    return pick('文字列 (std::string)', 'string container (std::string)');
  }
  if (lower.includes('unordered_map')) {
    return pick('ハッシュマップ (std::unordered_map)', 'hash map (std::unordered_map)');
  }
  if (lower.includes('map')) {
    return pick('連想配列 (std::map)', 'ordered map (std::map)');
  }
  if (lower.includes('shared_ptr')) {
    return pick('参照カウント付きスマートポインタ (std::shared_ptr)', 'reference-counted smart pointer (std::shared_ptr)');
  }
  if (lower.includes('list')) {
    return pick('連結リスト (std::list)', 'linked list (std::list)');
  }
  return kind;
}

/**
 * Narrate v6 function enrichment signals (demangling, HexSig library matching,
 * TIL type signatures, deobfuscation overlays, C++ STL patterns, and WASM hints)
 * into beginner-friendly bilingual text, badges, highlights, and glossary keys.
 *
 * @param {object|null|undefined} v6Enrichment
 * @param {{ rawName?: string|null }} [opts]
 * @returns {{
 *   displayName: string|null,
 *   badges: Array<{ id: string, label: string, tone: 'info'|'ok'|'warn' }>,
 *   summaryLines: string[],
 *   highlights: string[],
 *   glossaryKeys: string[],
 * }}
 */
export function narrateV6Enrichment(v6Enrichment, { rawName = null } = {}) {
  if (!v6Enrichment || typeof v6Enrichment !== 'object') {
    return {
      displayName: null,
      badges: [],
      summaryLines: [],
      highlights: [],
      glossaryKeys: [],
    };
  }

  const badges = [];
  const badgeIds = new Set();
  const summaryLines = [];
  const highlights = [];
  const highlightSet = new Set();
  const glossaryKeys = [];
  const glossarySet = new Set();

  const addBadge = (id, label, tone = 'info') => {
    if (!id || !label || badgeIds.has(id)) return;
    const safeTone = VALID_BADGE_TONES.has(tone) ? tone : 'info';
    badgeIds.add(id);
    badges.push({ id, label, tone: safeTone });
  };

  const addSummary = (line) => {
    const clean = nonEmptyString(line);
    if (clean) summaryLines.push(clean);
  };

  const addHighlight = (line) => {
    const clean = nonEmptyString(line);
    if (clean && !highlightSet.has(clean)) {
      highlightSet.add(clean);
      highlights.push(clean);
    }
  };

  const addGlossaryKey = (key) => {
    if (typeof key === 'string' && GLOSSARY_KEY_SET.has(key) && !glossarySet.has(key)) {
      glossarySet.add(key);
      glossaryKeys.push(key);
    }
  };

  const providedRawName = nonEmptyString(rawName);
  const enrichmentRawName = nonEmptyString(v6Enrichment.rawName);
  const compareRawName = rawName ?? v6Enrichment.rawName;
  const effectiveRawName = providedRawName || enrichmentRawName;
  const demangledName = nonEmptyString(v6Enrichment.demangledName);
  const explicitDisplayName = nonEmptyString(v6Enrichment.displayName);

  const hexsigMatch = v6Enrichment.hexsigMatch && typeof v6Enrichment.hexsigMatch === 'object'
    ? v6Enrichment.hexsigMatch
    : null;
  const hexsigName = nonEmptyString(hexsigMatch?.newName) || nonEmptyString(hexsigMatch?.symbolName);
  const hexsigLib = nonEmptyString(hexsigMatch?.libName) || nonEmptyString(hexsigMatch?.lib);

  const cxxClass = v6Enrichment.cxxClass && typeof v6Enrichment.cxxClass === 'object'
    ? v6Enrichment.cxxClass
    : null;
  const semanticName = v6Enrichment.semanticName && typeof v6Enrichment.semanticName === 'object'
    ? v6Enrichment.semanticName
    : null;
  const semanticNaming = semanticName?.naming && typeof semanticName.naming === 'object'
    ? semanticName.naming
    : null;
  const semanticConfidence = nonEmptyString(semanticNaming?.confidence)?.toLowerCase() || null;
  const semanticJaLabel = nonEmptyString(semanticNaming?.labelJa);
  const semanticEnLabel = nonEmptyString(semanticNaming?.nameEn);
  const isTrustedSemanticConfidence = semanticConfidence === 'high' || semanticConfidence === 'medium';
  const semanticDisplayName = isTrustedSemanticConfidence
    ? nonEmptyString(pick(semanticJaLabel || semanticEnLabel || '', semanticEnLabel || semanticJaLabel || ''))
    : null;
  const virtualFolderPath = nonEmptyString(v6Enrichment.virtualFolderPath)
    || nonEmptyString(semanticName?.folderPath);

  const displayName = semanticDisplayName || explicitDisplayName || demangledName || hexsigName || effectiveRawName || null;

  // 1. Demangled symbol name (guarded so plain C names like main === main do not misfire)
  const isActuallyDemangled = Boolean(demangledName && demangledName !== compareRawName);
  if (isActuallyDemangled) {
    addBadge('demangled', pick('名前を復元済み', 'Demangled Name'), 'info');
    addSummary(pick(
      `記号化された関数名を「${demangledName}」として読みやすく復元しました。`,
      `Decoded the mangled symbol name into "${demangledName}".`,
    ));
    addHighlight(pick(
      `復元された関数名: ${demangledName}`,
      `Demangled name: ${demangledName}`,
    ));
    addGlossaryKey('demangle');
  }

  // 2. HexSig library signature match
  if (hexsigMatch && (hexsigName || hexsigLib)) {
    addBadge('hexsig', pick('ライブラリ一致', 'Library Match'), 'ok');
    if (hexsigName && hexsigLib) {
      addSummary(pick(
        `バイト列の特徴から既知ライブラリ（${hexsigLib}）の関数「${hexsigName}」と一致しました。`,
        `Matched known library function "${hexsigName}" from ${hexsigLib} by signature.`,
      ));
      addHighlight(pick(
        `ライブラリ関数一致: ${hexsigName} (${hexsigLib})`,
        `Library match: ${hexsigName} (${hexsigLib})`,
      ));
    } else if (hexsigName) {
      addSummary(pick(
        `バイト列の特徴から既知の関数「${hexsigName}」と一致しました。`,
        `Matched known function "${hexsigName}" by binary signature.`,
      ));
      addHighlight(pick(
        `既知関数一致: ${hexsigName}`,
        `Known function match: ${hexsigName}`,
      ));
    } else {
      addSummary(pick(
        `既知ライブラリ（${hexsigLib}）のコードパターンと一致しました。`,
        `Matched code signature from known library ${hexsigLib}.`,
      ));
      addHighlight(pick(
        `ライブラリ一致: ${hexsigLib}`,
        `Library match: ${hexsigLib}`,
      ));
    }
    addGlossaryKey('hexsig');
    if (hexsigMatch.oldName != null && isStrippedFunctionName(hexsigMatch.oldName)) {
      addGlossaryKey('stripped');
    }
  }

  // 3. TIL type signature
  const tilSig = v6Enrichment.tilSignature;
  if (typeof tilSig === 'string' && tilSig.trim().length > 0) {
    const sigText = tilSig.trim();
    addBadge('til', pick('型情報を解決済み', 'Type Info Resolved'), 'ok');
    addSummary(pick(
      `型ライブラリ（TIL）から関数の型情報「${sigText}」を取得しました。`,
      `Resolved function type signature "${sigText}" from TIL.`,
    ));
    addHighlight(pick(
      `型情報あり: ${sigText}`,
      `Type signature: ${sigText}`,
    ));
    addGlossaryKey('til');
  } else if (tilSig && typeof tilSig === 'object') {
    const sigName = nonEmptyString(tilSig.matchedName) || nonEmptyString(tilSig.name);
    const packId = nonEmptyString(tilSig.packId) || nonEmptyString(tilSig.source);
    const retType = nonEmptyString(tilSig.retTypeStr);
    const arity = Number.isInteger(tilSig.arity) && tilSig.arity >= 0
      ? tilSig.arity
      : (Array.isArray(tilSig.paramTypeStrs) ? tilSig.paramTypeStrs.length
        : (Array.isArray(tilSig.paramHexTypes) ? tilSig.paramHexTypes.length : null));
    const hasMeaningfulTil = Boolean(
      sigName || packId || retType || arity != null
      || tilSig.isAlloc || tilSig.isFree || tilSig.isNoReturn || tilSig.isVariadic,
    );

    if (hasMeaningfulTil) {
      addBadge('til', pick('型情報を解決済み', 'Type Info Resolved'), 'ok');
      const detailPartsJa = [];
      const detailPartsEn = [];
      if (arity != null) {
        detailPartsJa.push(`引数 ${arity} 個`);
        detailPartsEn.push(`${arity} arg${arity === 1 ? '' : 's'}`);
      }
      if (retType) {
        detailPartsJa.push(`戻り値 ${retType}`);
        detailPartsEn.push(`returns ${retType}`);
      }
      if (packId) {
        detailPartsJa.push(`出典: ${packId}`);
        detailPartsEn.push(`pack: ${packId}`);
      }
      const detailJa = detailPartsJa.length > 0 ? `（${detailPartsJa.join(' / ')}）` : '';
      const detailEn = detailPartsEn.length > 0 ? ` (${detailPartsEn.join(', ')})` : '';
      addSummary(pick(
        `型ライブラリ（TIL）から引数や戻り値の型情報を解決しました${detailJa}。`,
        `Resolved argument and return types from TIL${detailEn}.`,
      ));
      addHighlight(pick(
        sigName ? `型情報解決: ${sigName}${detailJa}` : `型情報を解決済み${detailJa}`,
        sigName ? `Type resolved: ${sigName}${detailEn}` : `Type info resolved${detailEn}`,
      ));
      addGlossaryKey('til');
      if (tilSig.callConv != null) {
        addGlossaryKey('calling_convention');
      }
    }
  }

  // 4. Deobfuscation overlay (CFF / MBA / generic overlay)
  const deobf = v6Enrichment.deobfOverlay && typeof v6Enrichment.deobfOverlay === 'object'
    ? v6Enrichment.deobfOverlay
    : null;
  if (deobf) {
    const summary = deobf.summary && typeof deobf.summary === 'object' ? deobf.summary : null;
    const annotation = deobf.annotation && typeof deobf.annotation === 'object' ? deobf.annotation : null;
    const cffRecovered = Boolean(summary?.cffRecovered);
    const mbaCount = Number.isFinite(Number(summary?.mba?.simplifiedCount))
      ? Math.max(0, Math.trunc(Number(summary.mba.simplifiedCount)))
      : 0;
    const annotationText = nonEmptyString(annotation?.text);
    const hasOverlay = Boolean(deobf.hasOverlay || cffRecovered || mbaCount > 0 || annotationText);

    if (hasOverlay) {
      addBadge('deobf', pick('難読化を解除済み', 'Deobfuscated'), 'warn');
      if (cffRecovered) {
        addSummary(pick(
          '制御フロー平坦化（CFF）による難読化を解除し、本来の処理の流れを復元しました。',
          'Recovered control-flow flattening (CFF) to restore the original execution flow.',
        ));
        addHighlight(pick(
          '制御フロー平坦化 (CFF) を復元済み',
          'Control-flow flattening (CFF) recovered',
        ));
        addGlossaryKey('cff');
        addGlossaryKey('cfg');
      }
      if (mbaCount > 0) {
        addSummary(pick(
          `複雑な難読化数式（MBA）を ${mbaCount} 箇所シンプルに整理しました。`,
          `Simplified ${mbaCount} obfuscated MBA expression${mbaCount === 1 ? '' : 's'}.`,
        ));
        addHighlight(pick(
          `難読化数式 (MBA) を ${mbaCount} 箇所簡約化`,
          `Simplified ${mbaCount} MBA expression${mbaCount === 1 ? '' : 's'}`,
        ));
        addGlossaryKey('mba');
      }
      if (!cffRecovered && mbaCount === 0) {
        addSummary(pick(
          annotationText
            ? `難読化の解除結果を適用しています（${annotationText}）。`
            : '難読化の解除結果を適用し、読みやすい形に整理しました。',
          annotationText
            ? `Applied deobfuscation recovery (${annotationText}).`
            : 'Applied deobfuscation recovery to make the logic easier to read.',
        ));
        addHighlight(pick(
          '難読化解除オーバーレイを適用済み',
          'Deobfuscation overlay applied',
        ));
        if (annotationText && /\bcff\b/i.test(annotationText)) addGlossaryKey('cff');
        if (annotationText && /\bmba\b/i.test(annotationText)) addGlossaryKey('mba');
        addGlossaryKey('decompile');
      }
    }
  }

  // 5. C++ STL container pattern recognition
  const stl = v6Enrichment.stl && typeof v6Enrichment.stl === 'object' ? v6Enrichment.stl : null;
  if (stl && stl.recognized === true) {
    const primary = stl.primary && typeof stl.primary === 'object'
      ? stl.primary
      : (Array.isArray(stl.matches) && stl.matches[0] && typeof stl.matches[0] === 'object' ? stl.matches[0] : null);
    const kind = nonEmptyString(primary?.kind);
    if (kind) {
      const friendlyKind = describeStlKind(kind);
      const abiFamily = nonEmptyString(primary?.abiFamily);
      const abiSuffixJa = abiFamily ? `（${abiFamily}）` : '';
      const abiSuffixEn = abiFamily ? ` (${abiFamily})` : '';
      addBadge('stl', pick(`C++ STL: ${kind}`, `C++ STL: ${kind}`), 'info');
      addSummary(pick(
        `C++ 標準ライブラリの ${friendlyKind} を扱う処理パターンを検出しました${abiSuffixJa}。`,
        `Detected C++ standard library pattern for ${friendlyKind}${abiSuffixEn}.`,
      ));
      addHighlight(pick(
        `C++ コンテナ検出: ${kind}${abiSuffixJa}`,
        `C++ container detected: ${kind}${abiSuffixEn}`,
      ));
      addGlossaryKey('stl_container');
    }
  }

  // 6. WASM static analysis hints
  const wasmHints = v6Enrichment.wasmHints && typeof v6Enrichment.wasmHints === 'object'
    ? v6Enrichment.wasmHints
    : null;
  if (wasmHints && wasmHints.available !== false) {
    const tags = Array.isArray(wasmHints.tags)
      ? wasmHints.tags.map((t) => nonEmptyString(t)).filter(Boolean)
      : [];
    const vtableRefs = Array.isArray(wasmHints.vtableRefs) ? wasmHints.vtableRefs : [];
    const constTableRefs = Array.isArray(wasmHints.constTableRefs) ? wasmHints.constTableRefs : [];
    const rmwHitCount = Number.isFinite(Number(wasmHints.rmwHitCount))
      ? Math.max(0, Math.trunc(Number(wasmHints.rmwHitCount)))
      : 0;
    const jumpTableCount = Number.isFinite(Number(wasmHints.jumpTableCount)) && Number(wasmHints.jumpTableCount) > 0
      ? Math.trunc(Number(wasmHints.jumpTableCount))
      : (Array.isArray(wasmHints.jumpTables) ? wasmHints.jumpTables.length : 0);
    const roleName = resolveCallgraphRoleName(wasmHints.callgraph);

    // 6a. Semantic tags
    const hasCryptoTag = tags.some((t) => CRYPTO_TAG_RE.test(t));
    const hasObfTag = tags.some((t) => OBF_TAG_RE.test(t));
    const hasEntryTag = tags.some((t) => /^(?:entry|entrypoint)$/i.test(t));
    const hasSyscallTag = tags.some((t) => /syscall/i.test(t));

    if (hasCryptoTag) {
      addBadge('wasm-crypto', pick('暗号・ハッシュ処理', 'Crypto / Hash'), 'warn');
      addSummary(pick(
        '暗号化やハッシュ計算に特徴的な処理パターンが検出されています。',
        'Detected patterns typical of cryptographic or hashing routines.',
      ));
      addHighlight(pick(
        '暗号・ハッシュ処理の候補',
        'Candidate crypto / hash routine',
      ));
    }

    if (hasObfTag && !badgeIds.has('deobf')) {
      addBadge('wasm-obf', pick('難読化の可能性', 'Possibly Obfuscated'), 'warn');
      addSummary(pick(
        '読みにくくする難読化（複雑な分岐や高エントロピー処理）の兆候があります。',
        'Shows signs of obfuscation such as complex control flow or high entropy.',
      ));
      addHighlight(pick(
        '難読化の兆候を検出',
        'Signs of obfuscation detected',
      ));
      if (tags.some((t) => /\bcff\b/i.test(t))) addGlossaryKey('cff');
      if (tags.some((t) => /\bmba\b/i.test(t))) addGlossaryKey('mba');
    }

    if (hasEntryTag) {
      addBadge('wasm-entry', pick('開始地点', 'Entrypoint'), 'info');
      addSummary(pick(
        'プログラムまたは処理の入り口（エントリポイント）として機能します。',
        'Acts as a program or execution entrypoint.',
      ));
      addHighlight(pick(
        'プログラム開始地点の候補',
        'Program entrypoint candidate',
      ));
      addGlossaryKey('entrypoint');
    }

    if (hasSyscallTag) {
      addSummary(pick(
        'OS の機能（システムコール）を直接呼び出す処理が含まれています。',
        'Includes direct operating system calls (syscalls).',
      ));
      addGlossaryKey('syscall');
    }

    // 6b. VTable references
    if (vtableRefs.length > 0) {
      addBadge('vtable', pick('仮想関数テーブル参照', 'VTable Reference'), 'info');
      addSummary(pick(
        `クラスやオブジェクトの仮想関数テーブル（vtable）を ${vtableRefs.length} 箇所参照しています。`,
        `References ${vtableRefs.length} virtual function table${vtableRefs.length === 1 ? '' : 's'} (vtable).`,
      ));
      addHighlight(pick(
        `仮想関数テーブル参照: ${vtableRefs.length} 件`,
        `VTable references: ${vtableRefs.length}`,
      ));
      addGlossaryKey('vtable');
      addGlossaryKey('pointer');
    }

    // 6c. Atomic RMW operations
    if (rmwHitCount > 0) {
      addBadge('rmw', pick('アトミック更新あり', 'Atomic RMW'), 'warn');
      addSummary(pick(
        `複数スレッド間で安全に値を書き換えるアトミック操作（RMW）が ${rmwHitCount} 箇所あります。`,
        `Contains ${rmwHitCount} atomic read-modify-write (RMW) operation${rmwHitCount === 1 ? '' : 's'} for concurrency or refcounting.`,
      ));
      addHighlight(pick(
        `アトミック操作 (RMW): ${rmwHitCount} 箇所`,
        `Atomic RMW operations: ${rmwHitCount}`,
      ));
      addGlossaryKey('patch');
    }

    // 6d. Jump tables
    if (jumpTableCount > 0) {
      addBadge('jump-table', pick('分岐テーブルあり', 'Jump Table'), 'info');
      addSummary(pick(
        `switch 文のような多方向の分岐テーブルが ${jumpTableCount} 個含まれています。`,
        `Contains ${jumpTableCount} multi-way jump table${jumpTableCount === 1 ? '' : 's'} (similar to a switch statement).`,
      ));
      addHighlight(pick(
        `分岐テーブル: ${jumpTableCount} 個`,
        `Jump tables: ${jumpTableCount}`,
      ));
      addGlossaryKey('branch');
      addGlossaryKey('cfg');
    }

    // 6e. Constant table references
    if (constTableRefs.length > 0) {
      addSummary(pick(
        `定数テーブル（変換表や固定データ）を ${constTableRefs.length} 箇所参照しています。`,
        `References ${constTableRefs.length} constant lookup table${constTableRefs.length === 1 ? '' : 's'}.`,
      ));
      addGlossaryKey('xref');
    }

    // 6f. Callgraph role (skip 'normal' to avoid noise)
    if (roleName === 'utility_hub') {
      addBadge('cg-role', pick('共通ユーティリティ', 'Utility Hub'), 'warn');
      addSummary(pick(
        '多くの関数から共通して呼び出されるハブ関数です。書き換えると広範囲に影響します。',
        'Shared utility hub called from many places; patching it can have wide impact.',
      ));
      addHighlight(pick(
        '呼び出し元が多い共通ユーティリティ関数',
        'High-impact shared utility hub',
      ));
      addGlossaryKey('xref');
      addGlossaryKey('patch');
    } else if (roleName === 'dispatcher') {
      addBadge('cg-role', pick('振り分け関数', 'Dispatcher'), 'info');
      addSummary(pick(
        '状況に応じて複数の別関数へ処理を振り分ける司令塔の役割を持っています。',
        'Acts as a dispatcher that routes work to multiple sub-functions.',
      ));
      addHighlight(pick(
        '処理を振り分けるディスパッチャ関数',
        'Dispatcher routing to sub-functions',
      ));
      addGlossaryKey('xref');
    } else if (roleName === 'recursive_scc') {
      addBadge('cg-role', pick('再帰処理', 'Recursive'), 'warn');
      addSummary(pick(
        '自分自身または相互に呼び出し合う再帰構造に含まれています。',
        'Part of a recursive call cycle (strongly connected component).',
      ));
      addHighlight(pick(
        '再帰呼び出し構造の一部',
        'Part of a recursive call cycle',
      ));
      addGlossaryKey('cfg');
    } else if (roleName === 'leaf_compute') {
      addBadge('cg-role', pick('末端計算関数', 'Leaf Compute'), 'info');
      addSummary(pick(
        '他の関数を呼ばずに単体で計算を完結させる末端関数です。',
        'Leaf computation function that finishes its work without calling other functions.',
      ));
    }
  }

  // 7. Restored C++ class owner (RTTI), semantic naming, and virtual folder classification
  if (cxxClass) {
    const primaryOwner = nonEmptyString(cxxClass.primaryOwner);
    const sharedOwners = Array.isArray(cxxClass.sharedOwners)
      ? cxxClass.sharedOwners.map(nonEmptyString).filter(Boolean)
      : [];
    const slotIndex = Number.isInteger(cxxClass.slotIndex) && cxxClass.slotIndex >= 0
      ? cxxClass.slotIndex
      : null;

    if (primaryOwner) {
      addBadge('cxx-class', primaryOwner, 'ok');
      if (slotIndex != null) {
        addSummary(pick(
          `復元された C++ クラス「${primaryOwner}」の仮想関数（slot ${slotIndex}）に属しています。`,
          `Belongs to restored C++ class "${primaryOwner}" (vtable slot ${slotIndex}).`,
        ));
      } else {
        addSummary(pick(
          `復元された C++ クラス「${primaryOwner}」のメソッドです。`,
          `Method belonging to restored C++ class "${primaryOwner}".`,
        ));
      }
      addHighlight(pick(
        `所属クラス: ${primaryOwner}`,
        `Owner class: ${primaryOwner}`,
      ));
      addGlossaryKey('vtable');
      addGlossaryKey('demangle');
    } else if (cxxClass.isShared && sharedOwners.length > 0) {
      const sampleOwners = sharedOwners.slice(0, 3).join(', ');
      addBadge('cxx-class', pick('共有メソッド', 'Shared C++ Method'), 'info');
      addSummary(pick(
        `複数の C++ クラス（${sampleOwners} など）で共有されている仮想メソッドです。`,
        `Shared virtual method across multiple C++ classes (${sampleOwners}).`,
      ));
      addHighlight(pick(
        `共有クラス候補: ${sampleOwners}`,
        `Shared owner candidates: ${sampleOwners}`,
      ));
      addGlossaryKey('vtable');
    }
  }

  if (semanticNaming && isTrustedSemanticConfidence) {
    const reasons = Array.isArray(semanticNaming.reasons)
      ? semanticNaming.reasons.map(nonEmptyString).filter(Boolean)
      : [];
    const confTone = semanticConfidence === 'high' ? 'ok' : 'info';
    addBadge(
      'semantic-name',
      semanticConfidence === 'high'
        ? pick('役割推定 (高確信)', 'Semantic Name (High)')
        : pick('役割推定 (中確信)', 'Semantic Name (Medium)'),
      confTone,
    );
    if (semanticDisplayName) {
      addHighlight(pick(
        `推定された役割: ${semanticDisplayName}`,
        `Inferred purpose: ${semanticDisplayName}`,
      ));
    }
    if (reasons.length > 0) {
      const reasonText = reasons.slice(0, 3).join(' / ');
      addSummary(pick(
        `機能の推定根拠: ${reasonText}`,
        `Inference evidence: ${reasonText}`,
      ));
    }
    if (isStrippedFunctionName(effectiveRawName)) {
      addGlossaryKey('stripped');
    }
  }

  if (virtualFolderPath) {
    addSummary(pick(
      `仮想フォルダ分類: ${virtualFolderPath}`,
      `Virtual folder path: ${virtualFolderPath}`,
    ));
    addHighlight(pick(
      `分類フォルダ: ${virtualFolderPath}`,
      `Folder: ${virtualFolderPath}`,
    ));
  }

  return {
    displayName,
    badges,
    summaryLines,
    highlights,
    glossaryKeys,
  };
}
