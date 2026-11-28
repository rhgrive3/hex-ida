// Beginner-friendly auto-analysis progress model and starter function ranking.
// Pure, lightweight UI model builder with zero DOM, architecture, or semantics dependencies.

import {
  AUTO_ANALYSIS_STATUS,
  isStrippedFunctionName,
  normalizeVaHex,
  toSafeByteSize,
} from '../../analysis/common/v6-auto-contracts.js';
import { pick } from '../../i18n.js';

const ALL_STATUS_VALUES = new Set(Object.values(AUTO_ANALYSIS_STATUS));

const TERMINAL_STATUSES = new Set([
  AUTO_ANALYSIS_STATUS.DONE,
  AUTO_ANALYSIS_STATUS.SKIPPED,
  AUTO_ANALYSIS_STATUS.OFFLINE,
  AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED,
  AUTO_ANALYSIS_STATUS.MEMORY_LIMIT,
  AUTO_ANALYSIS_STATUS.UNSUPPORTED_ARCH,
  AUTO_ANALYSIS_STATUS.ABORTED,
  AUTO_ANALYSIS_STATUS.STALE,
  AUTO_ANALYSIS_STATUS.ERROR,
]);

const ENTRYPOINT_NAME_RE =
  /^_*(?:main|start|entry(?:point)?|w?winmain|dllmain|jni_onload|uiapplicationmain|nsapplicationmain)$/i;

const CRYPTO_NAME_RE =
  /(?:aes|sha\d*|md5|hmac|rsa|chacha|rc4|des|blowfish|cipher|encrypt|decrypt|crypto|pbkdf|hkdf)/i;

const CRYPTO_TAGS = new Set([
  'crypto',
  'aes',
  'sha',
  'sha1',
  'sha256',
  'sha512',
  'md5',
  'hmac',
  'rsa',
  'chacha',
  'rc4',
  'cipher',
  'hash',
  'encrypt',
  'decrypt',
  'sbox',
]);

const OBFUSCATED_TAGS = new Set([
  'obfuscated',
  'cff',
  'mba',
  'flattened',
  'high_entropy',
  'vm_handler',
  'deobf',
]);

const RMW_TAGS = new Set(['rmw', 'atomic']);

const LIBRARY_TAGS = new Set(['library', 'lib', 'thunk', 'plt', 'import']);

function normalizePhaseStatus(status) {
  if (typeof status === 'string' && ALL_STATUS_VALUES.has(status)) {
    return status;
  }
  return AUTO_ANALYSIS_STATUS.IDLE;
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function computePhasePercent(status, completed, total) {
  if (status === AUTO_ANALYSIS_STATUS.IDLE) return 0;
  if (status === AUTO_ANALYSIS_STATUS.RUNNING) {
    if (Number.isFinite(completed) && Number.isFinite(total) && total > 0) {
      return Math.min(99, Math.max(1, Math.round((completed / total) * 100)));
    }
    return 50;
  }
  return 100;
}

function resolveOverallStatus(statuses) {
  if (statuses.includes(AUTO_ANALYSIS_STATUS.RUNNING)) return AUTO_ANALYSIS_STATUS.RUNNING;
  if (statuses.includes(AUTO_ANALYSIS_STATUS.ERROR)) return AUTO_ANALYSIS_STATUS.ERROR;
  if (statuses.includes(AUTO_ANALYSIS_STATUS.ABORTED)) return AUTO_ANALYSIS_STATUS.ABORTED;
  if (statuses.includes(AUTO_ANALYSIS_STATUS.STALE)) return AUTO_ANALYSIS_STATUS.STALE;

  const allIdle = statuses.every((s) => s === AUTO_ANALYSIS_STATUS.IDLE);
  if (allIdle) return AUTO_ANALYSIS_STATUS.IDLE;

  if (statuses.includes(AUTO_ANALYSIS_STATUS.IDLE)) {
    return AUTO_ANALYSIS_STATUS.RUNNING;
  }

  if (statuses.includes(AUTO_ANALYSIS_STATUS.DONE)) return AUTO_ANALYSIS_STATUS.DONE;
  if (statuses.includes(AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED)) return AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED;
  if (statuses.includes(AUTO_ANALYSIS_STATUS.MEMORY_LIMIT)) return AUTO_ANALYSIS_STATUS.MEMORY_LIMIT;
  if (statuses.includes(AUTO_ANALYSIS_STATUS.OFFLINE)) return AUTO_ANALYSIS_STATUS.OFFLINE;
  if (statuses.includes(AUTO_ANALYSIS_STATUS.UNSUPPORTED_ARCH)) return AUTO_ANALYSIS_STATUS.UNSUPPORTED_ARCH;
  return AUTO_ANALYSIS_STATUS.SKIPPED;
}

function buildPhaseLabel(phaseId) {
  switch (phaseId) {
    case 'til':
      return pick('型ライブラリ (TIL)', 'Type libraries (TIL)');
    case 'hexsig':
      return pick('ライブラリ関数照合 (HexSig)', 'Library signature scan (HexSig)');
    case 'deobf':
      return pick('難読化解除・C++ パターン解析', 'Deobfuscation & C++ pattern analysis');
    default:
      return String(phaseId);
  }
}

function buildDefaultPhaseDetail(phaseId, phaseObj, status) {
  if (typeof phaseObj?.detail === 'string' && phaseObj.detail.trim() !== '') {
    return phaseObj.detail;
  }

  if (status === AUTO_ANALYSIS_STATUS.IDLE) {
    return pick('待機中', 'Waiting');
  }
  if (status === AUTO_ANALYSIS_STATUS.RUNNING) {
    if (Number.isFinite(phaseObj?.completed) && Number.isFinite(phaseObj?.total) && phaseObj.total > 0) {
      return pick(
        `実行中 (${phaseObj.completed}/${phaseObj.total})`,
        `Running (${phaseObj.completed}/${phaseObj.total})`,
      );
    }
    return pick('実行中…', 'Running…');
  }
  if (status === AUTO_ANALYSIS_STATUS.DONE) {
    if (phaseId === 'til') {
      const count = Array.isArray(phaseObj?.loadedPacks) ? phaseObj.loadedPacks.length : 0;
      return count > 0
        ? pick(`${count} 件の型パックを適用しました`, `Loaded ${count} type pack(s)`)
        : pick('完了しました', 'Completed');
    }
    if (phaseId === 'hexsig') {
      const named = Number.isFinite(phaseObj?.named) ? phaseObj.named : 0;
      return named > 0
        ? pick(`${named} 件の関数名を復元しました`, `Named ${named} library function(s)`)
        : pick('照合を完了しました', 'Signature scan complete');
    }
    if (phaseId === 'deobf') {
      const deobfHits = Number.isFinite(phaseObj?.deobfHits) ? phaseObj.deobfHits : 0;
      const stlHits = Number.isFinite(phaseObj?.stlHits) ? phaseObj.stlHits : 0;
      if (deobfHits > 0 || stlHits > 0) {
        return pick(
          `難読化 ${deobfHits} 件・STL ${stlHits} 件を検出しました`,
          `Detected ${deobfHits} obfuscated and ${stlHits} STL pattern(s)`,
        );
      }
      return pick('解析を完了しました', 'Analysis complete');
    }
  }
  if (status === AUTO_ANALYSIS_STATUS.SKIPPED) {
    return pick('スキップしました', 'Skipped');
  }
  if (status === AUTO_ANALYSIS_STATUS.OFFLINE) {
    return pick('オフラインのため外部取得を省略しました', 'Skipped remote fetch while offline');
  }
  if (status === AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED) {
    return pick('時間上限に達したため一部完了しました', 'Partially completed (time budget reached)');
  }
  if (status === AUTO_ANALYSIS_STATUS.MEMORY_LIMIT) {
    return pick('メモリ上限により一部制限しました', 'Limited due to memory ceiling');
  }
  if (status === AUTO_ANALYSIS_STATUS.UNSUPPORTED_ARCH) {
    return pick('このアーキテクチャでは未対応です', 'Not supported for this architecture');
  }
  if (status === AUTO_ANALYSIS_STATUS.ABORTED) {
    return pick('中断されました', 'Canceled');
  }
  if (status === AUTO_ANALYSIS_STATUS.STALE) {
    return pick('バイナリ切替により無効化されました', 'Invalidated after binary switch');
  }
  return pick('エラーが発生しました', 'Encountered an error');
}

function buildOverallCopy(overallStatus, percent) {
  switch (overallStatus) {
    case AUTO_ANALYSIS_STATUS.IDLE:
      return {
        headline: pick('自動解析の準備が整っています', 'Auto-analysis is ready'),
        nextAction: pick(
          'バイナリを開くと型情報・ライブラリ関数・難読化の自動解析が始まります。',
          'Open a binary to automatically resolve types, library functions, and obfuscated code.',
        ),
      };
    case AUTO_ANALYSIS_STATUS.RUNNING:
      return {
        headline: pick(
          `バックグラウンドで自動解析を実行中です (${percent}%)`,
          `Running background auto-analysis (${percent}%)`,
        ),
        nextAction: pick(
          '解析中でも、おすすめ関数からコードを読み始められます。',
          'You can start exploring recommended functions while analysis finishes.',
        ),
      };
    case AUTO_ANALYSIS_STATUS.DONE:
      return {
        headline: pick('自動解析が完了しました', 'Auto-analysis complete'),
        nextAction: pick(
          '下のおすすめ関数から順に開いて処理内容を確認しましょう。',
          'Start with the recommended starter functions below to explore the binary.',
        ),
      };
    case AUTO_ANALYSIS_STATUS.SKIPPED:
      return {
        headline: pick('自動解析はスキップされました', 'Auto-analysis was skipped'),
        nextAction: pick(
          '手動で関数を選んで詳細解析を実行できます。',
          'Select any function manually to inspect and analyze it.',
        ),
      };
    case AUTO_ANALYSIS_STATUS.OFFLINE:
      return {
        headline: pick(
          'オフラインのため外部パックの取得をスキップしました',
          'Skipped remote packs while offline',
        ),
        nextAction: pick(
          'ローカル情報と手動解析を使ってバイナリを読み進められます。',
          'Continue exploring with local symbols and on-demand function analysis.',
        ),
      };
    case AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED:
      return {
        headline: pick(
          '自動解析は時間上限に達したため一部完了しました',
          'Auto-analysis partially completed (time budget reached)',
        ),
        nextAction: pick(
          '優先度の高い関数から結果を確認し、必要な関数を追加解析してください。',
          'Review the highest-priority functions first and analyze additional ones on demand.',
        ),
      };
    case AUTO_ANALYSIS_STATUS.MEMORY_LIMIT:
      return {
        headline: pick(
          'メモリ上限に達したため自動解析を一部制限しました',
          'Auto-analysis paused some work due to memory limits',
        ),
        nextAction: pick(
          '個別の関数を開いて必要な箇所だけ解析してください。',
          'Open individual functions to analyze them one at a time.',
        ),
      };
    case AUTO_ANALYSIS_STATUS.UNSUPPORTED_ARCH:
      return {
        headline: pick(
          'このアーキテクチャでは自動照合の一部が未対応です',
          'Some auto-analysis passes are not supported on this architecture',
        ),
        nextAction: pick(
          '逆アセンブリや文字列検索から主要な処理を探してみてください。',
          'Use disassembly and string search to locate key routines.',
        ),
      };
    case AUTO_ANALYSIS_STATUS.ABORTED:
      return {
        headline: pick('自動解析は中断されました', 'Auto-analysis was canceled'),
        nextAction: pick(
          '必要に応じて別の関数を開くか、バイナリを再読み込みしてください。',
          'Open a function directly or reload the binary to run auto-analysis again.',
        ),
      };
    case AUTO_ANALYSIS_STATUS.STALE:
      return {
        headline: pick(
          'バイナリが切り替わったため古い解析結果を破棄しました',
          'Previous analysis became stale after switching binaries',
        ),
        nextAction: pick(
          '現在のバイナリで最新の解析結果が反映されるのをお待ちください。',
          'Wait for the current binary analysis results to refresh.',
        ),
      };
    case AUTO_ANALYSIS_STATUS.ERROR:
    default:
      return {
        headline: pick(
          '自動解析の一部でエラーが発生しました',
          'Part of auto-analysis encountered an error',
        ),
        nextAction: pick(
          '取得できた情報をもとに、個別の関数を選択して確認できます。',
          'You can still inspect available results and analyze individual functions.',
        ),
      };
  }
}

/**
 * Build a beginner-facing progress view model from AutoAnalysisState.
 * @param {object|null|undefined} state
 * @returns {{
 *   overallStatus: string,
 *   percent: number,
 *   isComplete: boolean,
 *   headline: string,
 *   nextAction: string,
 *   phases: Array<{ id: 'til'|'hexsig'|'deobf', label: string, status: string, detail: string, completed?: number, total?: number }>
 * }}
 */
export function buildAutoAnalysisProgressModel(state) {
  const safeState = state && typeof state === 'object' ? state : {};
  const phaseIds = ['til', 'hexsig', 'deobf'];

  const phases = [];
  const statuses = [];
  const percents = [];

  for (const id of phaseIds) {
    const rawPhase = safeState[id] && typeof safeState[id] === 'object' ? safeState[id] : {};
    const status = normalizePhaseStatus(rawPhase.status);
    const completed = Number.isFinite(rawPhase.completed) ? rawPhase.completed : undefined;
    const total = Number.isFinite(rawPhase.total) ? rawPhase.total : undefined;

    statuses.push(status);
    percents.push(computePhasePercent(status, completed, total));

    const entry = {
      id,
      label: buildPhaseLabel(id),
      status,
      detail: buildDefaultPhaseDetail(id, rawPhase, status),
    };
    if (completed !== undefined) entry.completed = completed;
    if (total !== undefined) entry.total = total;
    phases.push(entry);
  }

  const percent = Math.round((percents[0] + percents[1] + percents[2]) / 3);
  const isComplete = statuses.every(isTerminalStatus);
  const overallStatus = resolveOverallStatus(statuses);
  const { headline, nextAction } = buildOverallCopy(overallStatus, percent);

  return {
    overallStatus,
    percent,
    isComplete,
    headline,
    nextAction,
    phases,
  };
}

function buildNormalizedEnrichmentMap(enrichmentsByVa) {
  const map = new Map();
  if (!enrichmentsByVa) return map;

  if (enrichmentsByVa instanceof Map) {
    for (const [key, value] of enrichmentsByVa.entries()) {
      const hex = normalizeVaHex(key);
      if (hex && value && typeof value === 'object') {
        map.set(hex, value);
      }
    }
    return map;
  }

  if (typeof enrichmentsByVa === 'object') {
    for (const [key, value] of Object.entries(enrichmentsByVa)) {
      const hex = normalizeVaHex(key);
      if (hex && value && typeof value === 'object') {
        map.set(hex, value);
      }
    }
  }

  return map;
}

function collectLowerTags(fn, enrichment) {
  const tags = new Set();
  const sources = [fn?.tags, enrichment?.wasmHints?.tags];
  for (const list of sources) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === 'string' && item.trim() !== '') {
        tags.add(item.trim().toLowerCase());
      }
    }
  }
  return tags;
}

function hasAnyTag(tagSet, targetSet) {
  for (const t of tagSet) {
    if (targetSet.has(t)) return true;
  }
  return false;
}

function firstNonEmptyString(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') {
      return c.trim();
    }
  }
  return null;
}

function buildStarterReason(category, { hasTrueDemangle, stlRecognized }) {
  switch (category) {
    case 'entrypoint':
      return pick(
        'プログラムの開始地点（エントリーポイント）です。全体の流れを追う最初の関数に適しています。',
        'Program entry point. Ideal first function to trace the overall flow.',
      );
    case 'crypto':
      return pick(
        '暗号・ハッシュ処理や定数テーブル参照を含むため、重要なロジックの候補です。',
        'Contains cryptographic/hash indicators or constant-table references — a likely core routine.',
      );
    case 'obfuscated':
      return pick(
        '難読化パターンが検出されています。自動解析の補助結果と合わせて確認できます。',
        'Obfuscation patterns detected. Review alongside the auto-deobfuscation overlay.',
      );
    case 'rmw':
      return pick(
        'アトミック更新（RMW）を含み、状態管理や同期処理の要になっている可能性があります。',
        'Contains atomic read-modify-write operations, often used in state or synchronization logic.',
      );
    case 'library':
      return pick(
        '既知のライブラリ関数として識別されました。呼び出し元の把握に役立ちます。',
        'Identified as a known library function. Useful for understanding what callers do.',
      );
    case 'app_logic':
    default:
      if (hasTrueDemangle) {
        return pick(
          'C++/Swift の名前が復元されたアプリ固有ロジック候補です。',
          'Application logic candidate with a demangled C++/Swift symbol name.',
        );
      }
      if (stlRecognized) {
        return pick(
          'STL コンテナ操作が検出されたアプリ固有ロジック候補です。',
          'Application logic candidate with recognized STL container operations.',
        );
      }
      return pick(
        'アプリ固有の処理候補です。主要なロジックを読む出発点になります。',
        'Application logic candidate — a good starting point for reading core behavior.',
      );
  }
}

/**
 * Rank starter functions for beginners using exclusive category priority and additive scoring.
 * Category priority: entrypoint > crypto > obfuscated > rmw > library > app_logic.
 * @param {Array<object>} [functions=[]]
 * @param {{ limit?: number, enrichmentsByVa?: Map<unknown, object>|Record<string, object>|null }} [opts]
 * @returns {Array<{ vaHex: string, displayName: string, score: number, reason: string, category: 'entrypoint'|'crypto'|'obfuscated'|'rmw'|'app_logic'|'library' }>}
 */
export function rankStarterFunctions(functions = [], { limit = 5, enrichmentsByVa = null } = {}) {
  if (!Array.isArray(functions) || functions.length === 0) return [];

  const parsedLimit = limit == null ? 5 : Number(limit);
  const safeLimit = Number.isFinite(parsedLimit) ? Math.floor(parsedLimit) : 5;
  if (safeLimit <= 0) return [];

  const enrichmentMap = buildNormalizedEnrichmentMap(enrichmentsByVa);
  const rankedByVa = new Map();

  for (const fn of functions) {
    if (!fn || typeof fn !== 'object') continue;
    const vaHex = normalizeVaHex(fn.vaHex ?? fn.va ?? fn.addr ?? fn.address ?? fn.startAddr ?? fn.start);
    if (!vaHex) continue;

    const enrichment = enrichmentMap.get(vaHex)
      ?? (fn.enrichment && typeof fn.enrichment === 'object' ? fn.enrichment : null);

    const rawName = firstNonEmptyString(enrichment?.rawName, fn.rawName, fn.name, fn.symbol);
    const demangledName = firstNonEmptyString(enrichment?.demangledName, fn.demangledName);
    const hasTrueDemangle = Boolean(demangledName && rawName && demangledName !== rawName);

    const displayName = firstNonEmptyString(
      enrichment?.displayName,
      hasTrueDemangle ? demangledName : null,
      enrichment?.hexsigMatch?.newName,
      enrichment?.hexsigMatch?.symbolName,
      fn.displayName,
      rawName,
    ) || `sub_${vaHex.slice(2)}`;

    const tags = collectLowerTags(fn, enrichment);
    const wasmHints = enrichment?.wasmHints && typeof enrichment.wasmHints === 'object'
      ? enrichment.wasmHints
      : null;

    const callgraphRole = typeof wasmHints?.callgraph?.roleName === 'string'
      ? wasmHints.callgraph.roleName.trim().toLowerCase()
      : '';

    const isEntrypoint = Boolean(
      fn.isEntry
      || fn.isEntrypoint
      || tags.has('entrypoint')
      || tags.has('entry')
      || callgraphRole === 'entry'
      || callgraphRole === 'entrypoint'
      || (rawName && ENTRYPOINT_NAME_RE.test(rawName))
      || ENTRYPOINT_NAME_RE.test(displayName),
    );

    const hasConstTableRefs = Array.isArray(wasmHints?.constTableRefs) && wasmHints.constTableRefs.length > 0;
    const isCrypto = Boolean(
      fn.isCrypto
      || hasConstTableRefs
      || hasAnyTag(tags, CRYPTO_TAGS)
      || (rawName && CRYPTO_NAME_RE.test(rawName))
      || CRYPTO_NAME_RE.test(displayName),
    );

    const hasDeobfOverlay = Boolean(enrichment?.deobfOverlay?.hasOverlay);
    const isObfuscated = Boolean(
      fn.isObfuscated
      || hasDeobfOverlay
      || hasAnyTag(tags, OBFUSCATED_TAGS),
    );

    const rmwCount = Number.isFinite(wasmHints?.rmwHitCount)
      ? wasmHints.rmwHitCount
      : (Number.isFinite(fn.rmwHitCount) ? fn.rmwHitCount : 0);
    const isRmw = Boolean(rmwCount > 0 || hasAnyTag(tags, RMW_TAGS));

    const hasHexSig = Boolean(enrichment?.hexsigMatch);
    const hasTil = Boolean(enrichment?.tilSignature);
    const isLibrary = Boolean(
      fn.isLibrary
      || hasHexSig
      || hasTil
      || hasAnyTag(tags, LIBRARY_TAGS),
    );

    // Exclusive 6-category priority: entrypoint > crypto > obfuscated > rmw > library > app_logic
    let category = 'app_logic';
    if (isEntrypoint) category = 'entrypoint';
    else if (isCrypto) category = 'crypto';
    else if (isObfuscated) category = 'obfuscated';
    else if (isRmw) category = 'rmw';
    else if (isLibrary) category = 'library';

    const size = toSafeByteSize(fn.size ?? fn.byteSize, 0);
    const stlRecognized = Boolean(enrichment?.stl?.recognized === true);
    const jumpTableCount = Number.isFinite(wasmHints?.jumpTableCount) ? wasmHints.jumpTableCount : 0;
    const vtableCount = Array.isArray(wasmHints?.vtableRefs) ? wasmHints.vtableRefs.length : 0;
    const hasMeaningfulName = !isStrippedFunctionName(displayName);

    // Additive score across all independent signals; floor at 0.
    let rawScore = 0;
    if (isEntrypoint) rawScore += 100;
    if (isCrypto) rawScore += 65;
    if (isObfuscated) rawScore += 55;
    if (isRmw) rawScore += 45;
    if (category === 'app_logic') rawScore += 10;

    if (hasMeaningfulName) rawScore += 20;
    if (hasTrueDemangle) rawScore += 15;
    if (stlRecognized) rawScore += 15;
    if (jumpTableCount > 0) rawScore += 10;
    if (vtableCount > 0) rawScore += 10;
    if (size >= 64) rawScore += 10;
    if (size >= 512) rawScore += 5;

    if (isLibrary) rawScore -= 20;
    if (size > 0 && size < 16) rawScore -= 15;

    const score = Math.max(0, rawScore);
    const candidate = {
      vaHex,
      vaBig: BigInt(vaHex),
      displayName,
      score,
      reason: buildStarterReason(category, { hasTrueDemangle, stlRecognized }),
      category,
    };

    const existing = rankedByVa.get(vaHex);
    if (!existing || candidate.score > existing.score) {
      rankedByVa.set(vaHex, candidate);
    }
  }

  const sorted = [...rankedByVa.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.vaBig < b.vaBig) return -1;
    if (a.vaBig > b.vaBig) return 1;
    return 0;
  });

  return sorted.slice(0, safeLimit).map(({ vaHex, displayName, score, reason, category }) => ({
    vaHex,
    displayName,
    score,
    reason,
    category,
  }));
}
