import { pick } from '../i18n.js';
import { functionStory, patchImpactPreview } from '../narrate.js';
import { shortName } from '../rtti.js';
import { isStrippedFunctionName } from '../analysis/common/v6-auto-contracts.js';
import { narrateV6Enrichment } from './beginner/enrichment-narrator.js';
import { assessPatchRisk } from './beginner/patch-risk-advisor.js';
import { annotateGlossaryTerms } from './beginner/glossary-translator.js';

const UI_PRESENTATION_ROUTE = Symbol('canonical-function-ui-presentation');
const UI_PRESENTATION_INNER = Symbol.for('hex.uiPresentationInner');

function safeRows(block) {
  const rows = [...new Set((block?.insts || [])
    .map((inst) => inst?.row)
    .filter(Number.isSafeInteger))]
    .sort((a, b) => a - b);
  if (!rows.length && Number.isSafeInteger(block?.startRow)) rows.push(block.startRow);
  return rows;
}

export function presentationBasicBlocks(legacy) {
  return (legacy?.blocks || []).map((block) => {
    const rows = safeRows(block);
    return {
      ...block,
      rows,
      startRow:rows[0] ?? block.startRow,
      endRow:rows[rows.length - 1] ?? block.endRow,
    };
  });
}

function detectPrimaryImpactKind(model, cfg) {
  const insts = Array.isArray(model?.instructions) ? model.instructions : [];
  const hasLoop = Array.isArray(model?.backEdges) && model.backEdges.length > 0;
  const hasCond = (cfg?.blocks || []).some((b) =>
    (b?.successors || []).some((s) => s?.kind === 'conditional-true' || s?.kind === 'conditional-false')) ||
    insts.some((i) => i?.isConditional || i?.op === 'cmp');
  if (hasCond) return 'conditional-branch';
  if (hasLoop) return 'loop';
  if (insts.some((i) => i?.isCall || i?.op === 'call')) return 'call';
  if (insts.some((i) => i?.op === 'store' || i?.op === 'str')) return 'write';
  if (insts.some((i) => i?.isReturn || i?.op === 'ret')) return 'return';
  return 'default';
}

function resolveFunctionVaFromResult(rawResult, args) {
  const fromResult = rawResult?.model?.startAddress
    ?? rawResult?.startAddress
    ?? rawResult?.startAddr
    ?? rawResult?.pipeline?.legacyV1?.startAddress
    ?? null;
  if (fromResult != null) return fromResult;
  const firstArg = Array.isArray(args) ? args[0] : null;
  if (firstArg == null) return null;
  if (typeof firstArg === 'object') {
    return firstArg.start ?? firstArg.startAddress ?? firstArg.address ?? firstArg.va ?? null;
  }
  return firstArg;
}

/**
 * 初心者向けの関数サマリーカードを構築する。
 * C やアセンブリの前提知識なしで読める日本語見出し・概要・書き換え影響プレビューを先頭に置き、
 * アーキテクチャ名・ABI・生アドレス・シグネチャ等の技術詳細は technicalDetails に分離する。
 */
export function buildBeginnerFunctionCard(result, name = null, opts = {}) {
  const safeOpts = opts && typeof opts === 'object' ? opts : {};
  const v6Enrichment = safeOpts.v6Enrichment && typeof safeOpts.v6Enrichment === 'object'
    ? safeOpts.v6Enrichment
    : null;

  const model = result?.model || result?.pipeline?.legacyV1 || null;
  const cfg = result?.pipeline?.cfg || model?.__canonicalCfg || null;
  const blocks = Array.isArray(model?.basicBlocks)
    ? model.basicBlocks
    : presentationBasicBlocks(model);
  const insts = Array.isArray(model?.instructions) ? model.instructions : [];
  const hasSemantic = Boolean(model && model.facts && Array.isArray(model.semantic));

  let effectiveName = name;
  if (v6Enrichment && !effectiveName) {
    const candName = v6Enrichment.displayName || v6Enrichment.demangledName || v6Enrichment.rawName || null;
    if (candName && !isStrippedFunctionName(candName)) {
      effectiveName = candName;
    }
  }
  const displayName = effectiveName ? shortName(String(effectiveName)) : null;

  let headline;
  const whatItDoes = [];
  if (hasSemantic) {
    const story = functionStory(model, displayName);
    headline = story.headline;
    if (Array.isArray(story.purpose) && story.purpose.length) {
      whatItDoes.push(...story.purpose.slice(0, 3));
    }
  } else {
    const hasCond = (cfg?.blocks || []).some((b) =>
      (b?.successors || []).some((s) => s?.kind === 'conditional-true' || s?.kind === 'conditional-false')) ||
      insts.some((i) => i?.isConditional || i?.op === 'cmp');
    const hasLoop = Array.isArray(model?.backEdges) && model.backEdges.length > 0;
    if (hasLoop) {
      headline = pick('条件が変わるまで処理を繰り返す関数です。', 'A function that repeats work in a loop.');
    } else if (hasCond) {
      headline = pick('条件によって処理が枝分かれする関数です。', 'A function that branches based on a condition.');
    } else if (insts.length > 0 && insts.length <= 6) {
      headline = pick('短いステップで結果を返すシンプルな関数です。', 'A short, straightforward function.');
    } else {
      headline = pick('手順を順番に実行する関数です。', 'A function that runs steps in sequence.');
    }
    if (hasCond) {
      whatItDoes.push(pick('途中で条件をチェックし、結果に応じて進む先を切り替えます。', 'Checks a condition and chooses between paths.'));
    }
    if (hasLoop) {
      whatItDoes.push(pick('同じ処理を繰り返すループが含まれています。', 'Contains a repeating loop.'));
    }
    if (!whatItDoes.length) {
      whatItDoes.push(pick('大きな枝分かれはなく、上から順に処理を進めて結果を返します。', 'Runs straight through without major branches.'));
    }
  }

  const patchImpact = patchImpactPreview(detectPrimaryImpactKind(model, cfg));
  const startHex = model?.startAddress != null
    ? '0x' + BigInt(model.startAddress).toString(16).toUpperCase()
    : null;

  const baseCard = {
    headline,
    whatItDoes,
    patchImpact,
    technicalDetails: Object.freeze({
      architectureId: result?.architectureId ?? model?.__canonicalArchitectureId ?? null,
      abiId: result?.abiId ?? null,
      startAddress: startHex,
      instructionCount: insts.length,
      blockCount: blocks.length,
      signature: result?.decompiler?.signature ?? null,
    }),
  };

  if (!v6Enrichment) {
    return baseCard;
  }

  const narration = narrateV6Enrichment(v6Enrichment, {
    rawName: v6Enrichment.rawName ?? name ?? null,
  });
  const patchRisk = assessPatchRisk({
    instructions: insts,
    cfg,
    deobfOverlay: v6Enrichment.deobfOverlay ?? null,
    wasmHints: v6Enrichment.wasmHints ?? null,
    isSystemLibrary: Boolean(v6Enrichment.hexsigMatch || v6Enrichment.tilSignature),
  });

  const highlightSet = new Set();
  const v6Highlights = [];
  for (const line of [...(narration.highlights || []), ...(narration.summaryLines || [])]) {
    if (typeof line === 'string' && line && !highlightSet.has(line)) {
      highlightSet.add(line);
      v6Highlights.push(line);
    }
  }

  const glossarySeen = new Set();
  const glossaryMatches = [];
  const pushGlossaryKey = (key) => {
    if (typeof key === 'string' && key && !glossarySeen.has(key)) {
      glossarySeen.add(key);
      glossaryMatches.push(key);
    }
  };
  for (const k of narration.glossaryKeys || []) pushGlossaryKey(k);
  for (const k of patchRisk.glossaryKeys || []) pushGlossaryKey(k);
  const textSample = [headline, ...whatItDoes, ...v6Highlights].filter(Boolean).join(' ');
  const annotated = annotateGlossaryTerms(textSample);
  for (const k of annotated.matchedKeys || []) pushGlossaryKey(k);

  return {
    ...baseCard,
    v6Highlights,
    patchRisk,
    glossaryMatches,
  };
}

export function decorateFunctionAnalysisForUi(result, opts = {}) {
  if (!result || typeof result !== 'object') return result;
  const safeOpts = opts && typeof opts === 'object' ? opts : {};
  const v6Enrichment = safeOpts.v6Enrichment && typeof safeOpts.v6Enrichment === 'object'
    ? safeOpts.v6Enrichment
    : null;
  const cardName = typeof safeOpts.name === 'string' && safeOpts.name ? safeOpts.name : null;

  if (result.model) {
    // Case 1: result.model present & no v6Enrichment -> preserve strict === identity.
    if (!v6Enrichment) return result;
    // Case 3: result.model present & v6Enrichment present -> non-destructive shallow copy with beginnerSummary getter.
    const decorated = { ...result };
    Object.defineProperty(decorated, 'beginnerSummary', {
      enumerable:true,
      configurable:true,
      get() {
        return Object.freeze(buildBeginnerFunctionCard(decorated, cardName, { v6Enrichment }));
      },
    });
    return decorated;
  }

  const legacy = result.pipeline?.legacyV1 ?? null;
  if (!legacy || typeof legacy !== 'object') return result;

  const model = {
    ...legacy,
    basicBlocks:presentationBasicBlocks(legacy),
  };
  Object.defineProperties(model, {
    __canonicalDecompiler:{ value:result.decompiler ?? null, enumerable:false },
    __canonicalCfg:{ value:result.pipeline?.cfg ?? null, enumerable:false },
    __canonicalArchitectureId:{ value:result.architectureId ?? null, enumerable:false },
    __analysisPresentationOnly:{ value:true, enumerable:false },
  });

  const decorated = {
    ...result,
    model,
    instructions:Number.isSafeInteger(result.instructions)
      ? result.instructions
      : Array.isArray(model.instructions) ? model.instructions.length : 0,
    presentationProjection:Object.freeze({
      source:'semantic-ir-v2',
      target:'legacy-ui-v1',
      canonical:true,
      analysisAuthority:'AnalysisQueryAPI',
    }),
  };
  Object.defineProperty(decorated, 'beginnerSummary', {
    enumerable:true,
    configurable:true,
    get() {
      return Object.freeze(
        v6Enrichment
          ? buildBeginnerFunctionCard(decorated, cardName, { v6Enrichment })
          : buildBeginnerFunctionCard(decorated, cardName),
      );
    },
  });
  return decorated;
}

export function installFunctionAnalysisPresentation(app) {
  const original = app?.analyzeFunctionAt;
  if (typeof original !== 'function' || original[UI_PRESENTATION_ROUTE]) return original;
  const routed = async function canonicalUiAnalyzeFunctionAt(...args) {
    const rawResult = await original.apply(this, args);
    const funcVa = resolveFunctionVaFromResult(rawResult, args);
    let v6Enrichment = null;
    if (rawResult && typeof rawResult === 'object' && funcVa != null) {
      try {
        v6Enrichment = this?.getFunctionEnrichment?.(funcVa)
          ?? this?.v6?.getFunctionEnrichment?.(funcVa)
          ?? this?.v6Workbench?.getFunctionEnrichment?.(funcVa)
          ?? null;
      } catch {
        v6Enrichment = null;
      }
    }
    const decorated = decorateFunctionAnalysisForUi(
      rawResult,
      v6Enrichment ? { v6Enrichment } : undefined,
    );
    if (decorated && decorated !== rawResult && this?.semantic && this.semantic.result === rawResult) {
      this.semantic = { ...this.semantic, result: decorated };
    }
    if (rawResult != null) {
      try {
        this?._scheduleV6PostAnalyzeHook?.(funcVa, decorated);
      } catch {
        // Post-analyze hook is best-effort and non-fatal.
      }
    }
    return decorated;
  };
  Object.defineProperty(routed, UI_PRESENTATION_ROUTE, { value:true });
  Object.defineProperty(routed, UI_PRESENTATION_INNER, { value:original });
  app.analyzeFunctionAt = routed;
  return routed;
}

/* ── Goal-Candidate Readable Behavioral Summary & Pseudocode Highlighting ── */

const GOAL_SYNONYMS = [
  [/ダメージ|damage|だめーじ/i, ['damage', 'dmg', 'hurt']],
  [/攻撃|こうげき|attack|\batk\b/i, ['attack', 'atk']],
  [/防御|ぼうぎょ|defense|defence|\bdef\b/i, ['defense', 'defence', 'def']],
  [/体力|\bhp\b|ヒットポイント|health/i, ['hp', 'health', 'life']],
  [/所持金|お金|資金|通貨|コイン|\bcoins?\b|money|gold|wallet/i, ['coin', 'coins', 'gold', 'money', 'currency', 'wallet']],
  [/スコア|得点|score|point/i, ['score', 'points', 'point']],
  [/時間|タイマー|timer|time|cooldown/i, ['time', 'timer', 'cooldown']],
  [/課金|購入|purchase|buy|price|iap|receipt/i, ['purchase', 'buy', 'price', 'iap', 'receipt', 'store']],
  [/ライセンス|認証|license|auth|token|verify/i, ['license', 'auth', 'token', 'verify']],
];

const VERDICT_LABELS = Object.freeze({
  confirmed: ['確認済み', 'Confirmed'],
  likely: ['ほぼ確実', 'Likely'],
  ambiguous: ['候補あり', 'Ambiguous'],
  none: ['未確認', 'Unverified'],
});

const STOP_KEYWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'value',
  'find', 'get', 'set', 'function', 'func', 'proc', 'check', 'return',
]);

function normalizeOffsetNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'bigint') return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/^#/, '');
    if (!trimmed) return null;
    if (/^0x[0-9a-f]+$/i.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 16);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    }
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    }
  }
  return null;
}

function normalizeAddressBigInt(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^0x[0-9a-f]+$/i.test(trimmed) || /^\d+$/.test(trimmed)) {
      try {
        const bi = BigInt(trimmed);
        return bi >= 0n ? bi : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function formatOffsetHex(offset) {
  const n = normalizeOffsetNumber(offset);
  if (n == null) return null;
  return '0x' + n.toString(16);
}

function resolveGoalLabel(goal) {
  if (!goal) return '';
  if (typeof goal === 'string') return goal.trim();
  if (goal.free && goal.text) return String(goal.text).trim();
  const ja = goal.ja || goal.text || goal.id || '';
  const en = goal.en || goal.text || goal.id || '';
  return String(pick(ja, en) || '').trim();
}

function extractGoalKeywords(goal) {
  const terms = new Set();
  if (!goal) return [];
  const rawParts = [];
  if (typeof goal === 'string') {
    rawParts.push(goal);
  } else if (typeof goal === 'object') {
    for (const key of ['id', 'text', 'ja', 'en']) {
      if (typeof goal[key] === 'string' && goal[key].trim()) rawParts.push(goal[key]);
    }
    for (const listKey of ['words', 'keywords']) {
      if (Array.isArray(goal[listKey])) {
        for (const w of goal[listKey]) {
          if (typeof w === 'string' && w.trim()) rawParts.push(w);
        }
      }
    }
  }
  const combined = rawParts.join(' ');
  for (const [re, syns] of GOAL_SYNONYMS) {
    if (re.test(combined)) {
      for (const s of syns) terms.add(s.toLowerCase());
    }
  }
  for (const part of rawParts) {
    const tokens = String(part)
      .split(/[\s,、。・/()[\]{}:;!?+\-_]+/)
      .map((tok) => tok.trim().toLowerCase())
      .filter(Boolean);
    for (const tok of tokens) {
      if (/^[a-z0-9]+$/.test(tok)) {
        if ((tok.length >= 3 || tok === 'hp' || tok === 'mp') && !STOP_KEYWORDS.has(tok)) {
          terms.add(tok);
        }
      } else if (tok.length >= 2) {
        terms.add(tok);
      }
    }
  }
  return [...terms];
}

function verdictDisplayLabel(verdict) {
  if (!verdict) return null;
  const key = String(verdict).toLowerCase();
  const entry = VERDICT_LABELS[key];
  return entry ? pick(entry[0], entry[1]) : String(verdict);
}

function inferBytesFromRegOrMnemonic(mnemonic, reg) {
  const mn = String(mnemonic || '').toLowerCase();
  if (mn.endsWith('b') || mn.startsWith('ldrb') || mn.startsWith('strb')) return 1;
  if (mn.endsWith('h') || mn.startsWith('ldrh') || mn.startsWith('strh')) return 2;
  const r = String(reg || '').toLowerCase();
  if (/^w\d+|^s\d+/.test(r)) return 4;
  if (/^x\d+|^d\d+/.test(r)) return 8;
  if (/^q\d+|^v\d+/.test(r)) return 16;
  return null;
}

function inferBytesFromCType(typeStr) {
  const t = String(typeStr || '').toLowerCase().replace(/\s+/g, '');
  if (!t) return null;
  if (t.includes('64') || t.includes('double') || t.includes('longlong') || t.includes('size_t') || t.includes('uintptr') || t.includes('intptr')) return 8;
  if (t.includes('32') || t.includes('float') || t === 'int*' || t === 'unsignedint*') return 4;
  if (t.includes('16') || t.includes('short')) return 2;
  if (t.includes('8') || t.includes('char') || t.includes('bool')) return 1;
  return null;
}

function normalizeOpKind(rawOp) {
  if (!rawOp) return null;
  const s = String(rawOp).toLowerCase().trim();
  if (/^(f?subs?|-|sub|subtract|dec|decrement)$/.test(s)) return 'sub';
  if (/^(f?adds?|\+|add|inc|increment)$/.test(s)) return 'add';
  if (/^(f?muls?|\*|mul|multiply)$/.test(s)) return 'mul';
  if (/^([suf]?div|\/|div|divide)$/.test(s)) return 'div';
  if (/^(cmp|fcmp|compare)$/.test(s)) return 'cmp';
  return null;
}

function formatFieldLocation(base, offsetHex, fieldName) {
  const bracket = base && offsetHex
    ? `[${base}+${offsetHex}]`
    : (offsetHex ? `[+${offsetHex}]` : (base ? `[${base}]` : null));
  if (fieldName && bracket) return `${fieldName} (${bracket})`;
  return fieldName || bracket || pick('対象フィールド', 'target field');
}

function formatFieldOperationText(entry) {
  const loc = formatFieldLocation(entry.base, entry.offsetHex, entry.fieldName);
  const bytesJa = entry.size ? `${entry.size} バイト` : '値';
  const bytesEn = entry.size ? `${entry.size} byte${entry.size === 1 ? '' : 's'}` : 'a value';

  if (entry.access === 'modify') {
    switch (entry.op) {
      case 'sub':
        return pick(
          `${loc} から ${bytesJa}読み、減算して書き戻す`,
          `Reads ${bytesEn} from ${loc}, subtracts, and writes back`,
        );
      case 'add':
        return pick(
          `${loc} から ${bytesJa}読み、加算して書き戻す`,
          `Reads ${bytesEn} from ${loc}, adds, and writes back`,
        );
      case 'mul':
        return pick(
          `${loc} から ${bytesJa}読み、乗算して書き戻す`,
          `Reads ${bytesEn} from ${loc}, multiplies, and writes back`,
        );
      case 'div':
        return pick(
          `${loc} から ${bytesJa}読み、除算して書き戻す`,
          `Reads ${bytesEn} from ${loc}, divides, and writes back`,
        );
      default:
        return pick(
          `${loc} から ${bytesJa}読み、変更して書き戻す`,
          `Reads ${bytesEn} from ${loc}, modifies, and writes back`,
        );
    }
  }
  if (entry.access === 'write') {
    return pick(
      `${loc} へ ${bytesJa}書き込む`,
      `Writes ${bytesEn} to ${loc}`,
    );
  }
  return pick(
    `${loc} から ${bytesJa}読む`,
    `Reads ${bytesEn} from ${loc}`,
  );
}

function normalizeDisasmLines(disasm) {
  if (!disasm) return [];
  if (typeof disasm === 'string') {
    return disasm.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(disasm)) {
    return disasm.map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') {
        if (typeof item.text === 'string') return item.text.trim();
        if (typeof item.asm === 'string') return item.asm.trim();
        const mn = item.mnemonic || item.op || '';
        const ops = item.operands || item.args || '';
        return `${mn} ${ops}`.trim();
      }
      return '';
    }).filter(Boolean);
  }
  return [];
}

function extractFieldOpsFromDisasm(disasm) {
  const lines = normalizeDisasmLines(disasm);
  if (!lines.length) return [];

  const opsByKey = new Map();
  const regOrigin = new Map(); // reg -> { key, op }

  const getOrCreate = (base, offset, size) => {
    const offsetHex = formatOffsetHex(offset);
    const key = `${base || ''}@${offsetHex || ''}`;
    let rec = opsByKey.get(key);
    if (!rec) {
      rec = { base: base || null, offset, offsetHex, size: size || null, read: false, write: false, op: null, fieldName: null };
      opsByKey.set(key, rec);
    }
    if (!rec.size && size) rec.size = size;
    return { key, rec };
  };

  const memRe = /\b(ldur[bh]?|ldr(?:s?[bhw])?|stur[bh]?|str[bh]?)\s+([xwsqdv]\d+)\s*,\s*\[\s*([xw]\d+|sp)\s*(?:,\s*#?(0x[0-9a-f]+|\d+))?\s*\]/i;
  const arithRe = /\b(f?(?:add|sub|mul)s?|[suf]?div)\s+([xwsqdv]\d+)\s*,\s*([xwsqdv]\d+)\s*,/i;

  for (const line of lines) {
    const m = memRe.exec(line);
    if (m) {
      const mnemonic = m[1].toLowerCase();
      const valReg = m[2].toLowerCase();
      const baseReg = m[3].toLowerCase();
      const offset = m[4] != null ? normalizeOffsetNumber(m[4]) : 0;
      const size = inferBytesFromRegOrMnemonic(mnemonic, valReg);
      const { key, rec } = getOrCreate(baseReg, offset, size);
      if (mnemonic.startsWith('ld')) {
        rec.read = true;
        regOrigin.set(valReg, { key, op: null });
      } else {
        rec.write = true;
        const origin = regOrigin.get(valReg);
        if (origin && origin.key === key && origin.op && !rec.op) {
          rec.op = origin.op;
        }
      }
      continue;
    }
    const a = arithRe.exec(line);
    if (a) {
      const opKind = normalizeOpKind(a[1]);
      const dstReg = a[2].toLowerCase();
      const srcReg = a[3].toLowerCase();
      const origin = regOrigin.get(srcReg);
      if (origin && opKind) {
        const nextOrigin = { key: origin.key, op: origin.op || opKind };
        regOrigin.set(dstReg, nextOrigin);
        const rec = opsByKey.get(origin.key);
        if (rec && !rec.op) rec.op = opKind;
      }
    }
  }

  return [...opsByKey.values()].map((r) => ({
    base: r.base,
    offset: r.offset,
    offsetHex: r.offsetHex,
    size: r.size,
    fieldName: r.fieldName,
    access: r.read && r.write ? 'modify' : (r.write ? 'write' : 'read'),
    op: r.op,
  }));
}

function extractFieldOpsFromPseudocode(pseudocode) {
  const text = typeof pseudocode === 'string'
    ? pseudocode
    : (Array.isArray(pseudocode) ? pseudocode.join('\n') : String(pseudocode?.pseudocode || ''));
  if (!text) return [];
  const lines = text.split('\n');
  const opsByKey = new Map();
  const varOrigin = new Map(); // varName -> { key, op }

  const derefRe = /\*\(\s*([^)]+\*)\s*\)\s*\(\s*([a-zA-Z_]\w*)\s*\+\s*(0x[0-9a-f]+|\d+)\s*\)/i;
  const getOrCreate = (base, offset, size) => {
    const offsetHex = formatOffsetHex(offset);
    const key = `${base}@${offsetHex}`;
    let rec = opsByKey.get(key);
    if (!rec) {
      rec = { base, offset, offsetHex, size: size || null, read: false, write: false, op: null, fieldName: null };
      opsByKey.set(key, rec);
    }
    if (!rec.size && size) rec.size = size;
    return { key, rec };
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Compound assignment: *(type *)(base + off) -= rhs;
    const compoundRe = /^\*\(\s*([^)]+\*)\s*\)\s*\(\s*([a-zA-Z_]\w*)\s*\+\s*(0x[0-9a-f]+|\d+)\s*\)\s*([+\-*/])=/i;
    const cm = compoundRe.exec(line);
    if (cm) {
      const offset = normalizeOffsetNumber(cm[3]);
      if (offset != null) {
        const { rec } = getOrCreate(cm[2], offset, inferBytesFromCType(cm[1]));
        rec.read = true;
        rec.write = true;
        rec.op = normalizeOpKind(cm[4]) || rec.op;
      }
      continue;
    }

    // Store assignment: *(type *)(base + off) = rhs;
    const storeRe = /^\*\(\s*([^)]+\*)\s*\)\s*\(\s*([a-zA-Z_]\w*)\s*\+\s*(0x[0-9a-f]+|\d+)\s*\)\s*=\s*(.+);?$/i;
    const sm = storeRe.exec(line);
    if (sm) {
      const offset = normalizeOffsetNumber(sm[3]);
      if (offset != null) {
        const { key, rec } = getOrCreate(sm[2], offset, inferBytesFromCType(sm[1]));
        rec.write = true;
        const rhs = sm[4];
        const rhsDeref = derefRe.exec(rhs);
        if (rhsDeref && rhsDeref[2] === sm[2] && normalizeOffsetNumber(rhsDeref[3]) === offset) {
          rec.read = true;
        }
        for (const [vName, origin] of varOrigin.entries()) {
          if (origin.key === key && new RegExp(`\\b${vName}\\b`).test(rhs)) {
            rec.read = true;
            if (origin.op && !rec.op) rec.op = origin.op;
            const inlineOp = new RegExp(`\\b${vName}\\b\\s*([+\\-*/])`).exec(rhs);
            if (inlineOp && !rec.op) rec.op = normalizeOpKind(inlineOp[1]);
          }
        }
      }
      continue;
    }

    // Load assignment: [type] v1 = *(type *)(base + off);
    const loadRe = /^(?:(?:const|unsigned|signed|struct)\s+)*(?:[a-zA-Z_]\w*\s+\*?\s*)?([a-zA-Z_]\w*)\s*=\s*(.+);?$/;
    const lm = loadRe.exec(line);
    if (lm) {
      const lhs = lm[1];
      const rhs = lm[2];
      const dm = derefRe.exec(rhs);
      if (dm) {
        const offset = normalizeOffsetNumber(dm[3]);
        if (offset != null) {
          const { key, rec } = getOrCreate(dm[2], offset, inferBytesFromCType(dm[1]));
          rec.read = true;
          varOrigin.set(lhs, { key, op: null });
        }
        continue;
      }
      for (const [vName, origin] of varOrigin.entries()) {
        if (new RegExp(`\\b${vName}\\b`).test(rhs)) {
          const opMatch = new RegExp(`\\b${vName}\\b\\s*([+\\-*/])`).exec(rhs);
          const opKind = opMatch ? normalizeOpKind(opMatch[1]) : origin.op;
          varOrigin.set(lhs, { key: origin.key, op: opKind });
          const rec = opsByKey.get(origin.key);
          if (rec && opKind && !rec.op) rec.op = opKind;
          break;
        }
      }
    }
  }

  return [...opsByKey.values()].map((r) => ({
    base: r.base,
    offset: r.offset,
    offsetHex: r.offsetHex,
    size: r.size,
    fieldName: r.fieldName,
    access: r.read && r.write ? 'modify' : (r.write ? 'write' : 'read'),
    op: r.op,
  }));
}

function collectExplicitFieldDescriptors(fields, pinpoint, candidate) {
  const list = [];
  const pushDescriptor = (raw, fallbackClass = null) => {
    if (!raw || typeof raw !== 'object') return;
    const nested = raw.field && typeof raw.field === 'object' ? raw.field : null;
    const offset = normalizeOffsetNumber(raw.offset ?? raw.disp ?? nested?.offset ?? nested?.disp);
    const base = typeof (raw.base ?? raw.reg) === 'string' ? String(raw.base ?? raw.reg) : null;
    const size = Number.isFinite(Number(raw.size ?? raw.bytes ?? nested?.size ?? nested?.bytes ?? nested?.type?.bytes))
      ? Number(raw.size ?? raw.bytes ?? nested?.size ?? nested?.bytes ?? nested?.type?.bytes)
      : null;
    const rawName = nested?.name || raw.fieldName || raw.name || null;
    const cls = raw.className || fallbackClass || null;
    const cleanName = rawName ? String(rawName).replace(/^_+/, '') : null;
    const fieldName = cleanName ? (cls ? `${cls}.${cleanName}` : cleanName) : null;

    if (offset == null && !base && !fieldName) return;

    const opsList = Array.isArray(raw.ops) ? raw.ops.map((x) => String(x).toLowerCase()) : [];
    const read = Boolean(
      raw.read || raw.loads > 0 || raw.access === 'read' || raw.access === 'modify' || raw.access === 'rmw'
      || raw.modifies || opsList.some((o) => o.startsWith('ld') || o === 'read')
    );
    const write = Boolean(
      raw.write || raw.writes || raw.stores > 0 || raw.access === 'write' || raw.access === 'modify' || raw.access === 'rmw'
      || raw.modifies || opsList.some((o) => o.startsWith('st') || o === 'write')
    );
    let op = normalizeOpKind(raw.op || raw.action || raw.arith);
    if (!op) {
      for (const o of opsList) {
        const k = normalizeOpKind(o);
        if (k) { op = k; break; }
      }
    }
    const access = (read && write) || raw.modifies || raw.access === 'modify' || raw.access === 'rmw'
      ? 'modify'
      : (write ? 'write' : 'read');

    list.push({
      base,
      offset,
      offsetHex: formatOffsetHex(offset),
      size: size && size > 0 ? size : null,
      fieldName,
      access,
      op,
    });
  };

  if (Array.isArray(fields)) {
    for (const f of fields) pushDescriptor(f);
  } else if (fields && typeof fields === 'object') {
    if (Array.isArray(fields.accesses)) {
      for (const f of fields.accesses) pushDescriptor(f, fields.className);
    } else if (Array.isArray(fields.fields)) {
      for (const f of fields.fields) pushDescriptor(f, fields.className);
    } else {
      pushDescriptor(fields);
    }
  }
  if (pinpoint?.top && typeof pinpoint.top === 'object') {
    pushDescriptor(pinpoint.top, pinpoint.top.className);
  } else if (pinpoint && typeof pinpoint === 'object' && (pinpoint.offset != null || pinpoint.field)) {
    pushDescriptor(pinpoint, pinpoint.className);
  }
  if (candidate && typeof candidate === 'object') {
    if (Array.isArray(candidate.fields)) {
      for (const f of candidate.fields) pushDescriptor(f, candidate.className);
    } else if (candidate.offset != null || candidate.field) {
      pushDescriptor(candidate, candidate.className);
    }
  }
  return list;
}

function mergeFieldOperations(explicitList, inferredList) {
  const merged = [];
  const findMatch = (item) => merged.find((m) =>
    (item.offset != null && m.offset != null && item.offset === m.offset && (!item.base || !m.base || item.base.toLowerCase() === m.base.toLowerCase()))
    || (item.offset == null && m.offset == null && item.fieldName && m.fieldName === item.fieldName)
  );
  const accessRank = { read: 1, write: 2, modify: 3 };

  for (const item of [...explicitList, ...inferredList]) {
    const existing = findMatch(item);
    if (!existing) {
      merged.push({ ...item });
      continue;
    }
    if (!existing.base && item.base) existing.base = item.base;
    if (existing.offset == null && item.offset != null) {
      existing.offset = item.offset;
      existing.offsetHex = item.offsetHex;
    }
    if (!existing.size && item.size) existing.size = item.size;
    if (!existing.fieldName && item.fieldName) existing.fieldName = item.fieldName;
    if (!existing.op && item.op) existing.op = item.op;
    if ((accessRank[item.access] || 0) > (accessRank[existing.access] || 0)) {
      existing.access = item.access;
    } else if ((existing.access === 'read' && item.access === 'write') || (existing.access === 'write' && item.access === 'read')) {
      existing.access = 'modify';
    }
  }

  return merged.map((entry) => ({
    ...entry,
    text: formatFieldOperationText(entry),
  }));
}

function collectMatchedStrings({ candidate, pinpoint, pseudocode, disasm, goalKeywords }) {
  const out = [];
  const seen = new Set();
  const add = (value) => {
    const s = String(value || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  for (const list of [candidate?.strings, pinpoint?.top?.strings, pinpoint?.strings]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      add(typeof item === 'string' ? item : item?.text);
    }
  }
  if (Array.isArray(candidate?.reasons)) {
    for (const reason of candidate.reasons) {
      if (reason && typeof reason === 'object' && reason.code === 'string-ref') {
        if (typeof reason.text === 'string') add(reason.text);
        if (typeof reason.detail?.text === 'string') add(reason.detail.text);
        if (Array.isArray(reason.detail?.strings)) {
          for (const s of reason.detail.strings) add(typeof s === 'string' ? s : s?.text);
        }
      }
    }
  }

  if (goalKeywords.length) {
    const textBlob = [
      typeof pseudocode === 'string' ? pseudocode : (Array.isArray(pseudocode) ? pseudocode.join('\n') : String(pseudocode?.pseudocode || '')),
      normalizeDisasmLines(disasm).join('\n'),
    ].filter(Boolean).join('\n');

    const literalRe = /"([^"\\\n]{2,120})"/g;
    let m;
    while ((m = literalRe.exec(textBlob)) !== null) {
      const lit = m[1];
      const lower = lit.toLowerCase();
      if (goalKeywords.some((kw) => lower.includes(kw))) {
        add(lit);
      }
    }
  }
  return out;
}

function collectMatchedSymbols({ candidate, pinpoint, pseudocode, goalKeywords }) {
  const out = [];
  const seen = new Set();
  const add = (value) => {
    const s = String(value || '').trim();
    if (!s || isStrippedFunctionName(s) || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  const rawNames = [
    candidate?.name,
    pinpoint?.top?.name,
    pinpoint?.top?.className && pinpoint?.top?.field?.name
      ? `${pinpoint.top.className}.${String(pinpoint.top.field.name).replace(/^_+/, '')}`
      : null,
  ];
  for (const name of rawNames) {
    if (!name) continue;
    const lowered = String(name).toLowerCase();
    if (!goalKeywords.length || goalKeywords.some((kw) => lowered.includes(kw))) {
      add(shortName(String(name)));
    }
  }

  if (goalKeywords.length && pseudocode) {
    const codeText = typeof pseudocode === 'string'
      ? pseudocode
      : (Array.isArray(pseudocode) ? pseudocode.join('\n') : String(pseudocode?.pseudocode || ''));
    const callRe = /\b([A-Za-z_][A-Za-z0-9_:]{2,80})\s*\(/g;
    let m;
    while ((m = callRe.exec(codeText)) !== null) {
      const sym = m[1];
      const lowered = sym.toLowerCase();
      if (goalKeywords.some((kw) => lowered.includes(kw))) {
        add(shortName(sym));
      }
    }
  }
  return out;
}

/**
 * 目的検索から候補関数を開いたとき、その関数が対象概念に対して何をしているかを
 * 初心者にも読める日本語（英語フォールバック付き）で要約する。
 */
export function buildGoalCandidateSummary({
  goal = null,
  candidate = null,
  pinpoint = null,
  fields = null,
  pseudocode = null,
  disasm = null,
} = {}) {
  const goalText = resolveGoalLabel(goal);
  const goalKeywords = extractGoalKeywords(goal);

  const explicitFields = collectExplicitFieldDescriptors(fields, pinpoint, candidate);
  const inferredFromDisasm = extractFieldOpsFromDisasm(disasm);
  const inferredFromPseudo = extractFieldOpsFromPseudocode(pseudocode);
  const fieldOperations = mergeFieldOperations(explicitFields, [...inferredFromDisasm, ...inferredFromPseudo]);

  const matchedStrings = collectMatchedStrings({ candidate, pinpoint, pseudocode, disasm, goalKeywords });
  const matchedSymbols = collectMatchedSymbols({ candidate, pinpoint, pseudocode, goalKeywords });

  const verdict = pinpoint?.verdict ? String(pinpoint.verdict).toLowerCase() : null;
  const verdictLabel = verdictDisplayLabel(verdict);

  const hasAnySignal = Boolean(
    goalText
    || candidate
    || pinpoint
    || fieldOperations.length
    || matchedStrings.length
    || matchedSymbols.length
  );
  if (!hasAnySignal) return null;

  const bullets = [];
  for (const op of fieldOperations.slice(0, 3)) {
    bullets.push(op.text);
  }
  if (matchedStrings.length) {
    const quoted = matchedStrings.slice(0, 4).map((s) => `"${s}"`).join(', ');
    bullets.push(pick(
      `関連文字列を参照: ${quoted}`,
      `References matching strings: ${quoted}`,
    ));
  }
  if (matchedSymbols.length) {
    const syms = matchedSymbols.slice(0, 4).join(', ');
    bullets.push(pick(
      `関連シンボル: ${syms}`,
      `Matching symbols: ${syms}`,
    ));
  }
  if (verdictLabel) {
    const targetName = pinpoint?.top?.name
      ? ` (${shortName(String(pinpoint.top.name))})`
      : '';
    bullets.push(pick(
      `特定判定: ${verdictLabel}${targetName}`,
      `Pinpoint verdict: ${verdictLabel}${targetName}`,
    ));
  }

  let headline;
  if (fieldOperations.length) {
    const primary = fieldOperations[0].text;
    headline = goalText
      ? pick(`「${goalText}」に関して、${primary}処理です。`, `For "${goalText}": ${primary}.`)
      : pick(`${primary}処理です。`, `${primary}.`);
  } else if (matchedStrings.length) {
    const firstStr = matchedStrings[0];
    headline = goalText
      ? pick(`「${goalText}」に関連する文字列 "${firstStr}" を参照する関数です。`, `References "${firstStr}" related to "${goalText}".`)
      : pick(`文字列 "${firstStr}" を参照する関数です。`, `References string "${firstStr}".`);
  } else if (matchedSymbols.length) {
    const firstSym = matchedSymbols[0];
    headline = goalText
      ? pick(`「${goalText}」に関連する処理 (${firstSym}) を扱う関数です。`, `Handles "${goalText}" via ${firstSym}.`)
      : pick(`${firstSym} に関わる関数です。`, `Involves ${firstSym}.`);
  } else if (verdictLabel) {
    headline = goalText
      ? pick(`「${goalText}」の候補として特定された関数です（${verdictLabel}）。`, `Identified candidate for "${goalText}" (${verdictLabel}).`)
      : pick(`特定判定: ${verdictLabel} の候補関数です。`, `Candidate function (${verdictLabel}).`);
  } else {
    headline = pick(
      `「${goalText}」の候補として開かれた関数です。`,
      `Opened as a candidate for "${goalText}".`,
    );
  }

  return {
    hasContext: true,
    goalLabel: goalText,
    headline,
    bullets,
    fieldOperations,
    matchedStrings,
    matchedSymbols,
    verdict,
    verdictLabel,
  };
}

function normalizePseudocodeEntries(pseudocode) {
  if (!pseudocode) return [];
  if (typeof pseudocode === 'string') {
    return pseudocode.split('\n').map((text, index) => ({ index, text, addr: null }));
  }
  if (Array.isArray(pseudocode)) {
    return pseudocode.map((item, index) => {
      if (typeof item === 'string') return { index, text: item, addr: null };
      if (item && typeof item === 'object') {
        return {
          index,
          text: String(item.text ?? item.line ?? ''),
          addr: normalizeAddressBigInt(item.addr ?? item.address),
        };
      }
      return { index, text: '', addr: null };
    });
  }
  if (typeof pseudocode === 'object') {
    if (Array.isArray(pseudocode.lines)) return normalizePseudocodeEntries(pseudocode.lines);
    if (typeof pseudocode.pseudocode === 'string') return normalizePseudocodeEntries(pseudocode.pseudocode);
  }
  return [];
}

function isSignatureLine(line, index) {
  if (index > 1) return false;
  const t = line.trim();
  if (!t || t.endsWith(';')) return false;
  return /^[a-zA-Z_][\w\s*:<>~]*\([^)]*\)\s*\{?\s*$/.test(t);
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 疑似Cコードから目的・特定結果に関連する行インデックス（0始まり・昇順）を返す純粋関数。
 * オフセット・アドレス・文字列参照・シンボル呼び出し・対象レジスタ/変数への演算やストアを検出する。
 */
export function findGoalHighlightLines(pseudocode, context = {}) {
  const entries = normalizePseudocodeEntries(pseudocode);
  if (!entries.length || !context || typeof context !== 'object') return [];

  const {
    goal = null,
    candidate = null,
    pinpoint = null,
    fields = null,
    addresses = null,
    offsets = null,
    registers = null,
    strings = null,
    symbols = null,
  } = context;

  const targetAddrs = new Set();
  const addAddr = (v) => {
    const bi = normalizeAddressBigInt(v);
    if (bi != null) targetAddrs.add(bi);
  };
  for (const list of [addresses, candidate?.hitAddresses, pinpoint?.sites, pinpoint?.changeSites, pinpoint?.top?.sites]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item && typeof item === 'object') {
        addAddr(item.addr ?? item.address ?? item.first);
      } else {
        addAddr(item);
      }
    }
  }
  addAddr(pinpoint?.siteAddr ?? pinpoint?.hitAddr);

  const targetOffsets = new Set();
  const targetRegisters = new Set();
  const targetFieldNames = new Set();
  const addOffset = (v) => {
    const n = normalizeOffsetNumber(v);
    if (n != null) targetOffsets.add(n);
  };
  const addRegister = (v) => {
    if (typeof v === 'string' && v.trim()) targetRegisters.add(v.trim().toLowerCase());
  };
  const addFieldName = (v) => {
    if (typeof v !== 'string' || !v.trim()) return;
    const raw = v.trim();
    const plain = raw.replace(/^_+/, '');
    if (raw.length >= 2) targetFieldNames.add(raw.toLowerCase());
    if (plain.length >= 2) targetFieldNames.add(plain.toLowerCase());
  };

  if (Array.isArray(offsets)) {
    for (const o of offsets) addOffset(o);
  }
  if (Array.isArray(registers)) {
    for (const r of registers) addRegister(r);
  }
  addRegister(pinpoint?.reg ?? pinpoint?.base ?? pinpoint?.top?.base);
  addOffset(pinpoint?.offset ?? pinpoint?.disp ?? pinpoint?.top?.offset ?? pinpoint?.top?.field?.offset);
  addFieldName(pinpoint?.top?.field?.name ?? pinpoint?.field?.name);
  addOffset(candidate?.offset ?? candidate?.disp ?? candidate?.field?.offset);
  addFieldName(candidate?.field?.name);

  const explicitFields = collectExplicitFieldDescriptors(fields, pinpoint, candidate);
  for (const f of explicitFields) {
    addOffset(f.offset);
    addRegister(f.base);
    if (f.fieldName) {
      const parts = f.fieldName.split('.');
      addFieldName(parts[parts.length - 1]);
    }
  }

  const goalKeywords = extractGoalKeywords(goal);

  const targetStrings = new Set();
  const addString = (v) => {
    const s = String(v || '').trim().toLowerCase();
    if (s.length >= 2) targetStrings.add(s);
  };
  for (const list of [strings, candidate?.strings, pinpoint?.top?.strings, pinpoint?.strings]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) addString(typeof item === 'string' ? item : item?.text);
  }
  for (const kw of goalKeywords) addString(kw);

  const targetSymbols = new Set();
  const addSymbol = (v) => {
    const s = String(v || '').trim();
    if (!s || isStrippedFunctionName(s)) return;
    const short = shortName(s).toLowerCase();
    if (short.length >= 2) targetSymbols.add(short);
    const tail = short.split('::').pop();
    if (tail && tail.length >= 2) targetSymbols.add(tail);
  };
  if (Array.isArray(symbols)) {
    for (const s of symbols) addSymbol(s);
  }
  if (Array.isArray(candidate?.callees)) {
    for (const c of candidate.callees) addSymbol(typeof c === 'string' ? c : c?.name);
  }
  for (const kw of goalKeywords) {
    if (kw.length >= 3 || kw === 'hp' || kw === 'mp') targetSymbols.add(kw);
  }

  const hasAnyCriteria = Boolean(
    targetAddrs.size || targetOffsets.size || targetRegisters.size
    || targetFieldNames.size || targetStrings.size || targetSymbols.size
  );
  if (!hasAnyCriteria) return [];

  const matched = new Set();
  const taintedVars = new Set();

  const offsetRegexes = [...targetOffsets].map((off) => {
    const hex = off.toString(16);
    const parts = [
      `(?:\\+|\\s|\\[|field_|off_)0x0*${hex}(?![0-9a-f])`,
      `(?:->|\\.)(?:field_|off_|m_)?(?:0x)?${hex}(?![0-9a-f])`,
    ];
    if (off >= 8) {
      parts.push(`(?:\\+\\s*${off}(?!\\d))`);
    }
    return new RegExp(parts.join('|'), 'i');
  });

  const addrHexStrings = [...targetAddrs].map((bi) => bi.toString(16));
  const assignLhsRe = /^(?:(?:const|unsigned|signed|struct)\s+)*(?:[a-zA-Z_]\w*\s+\*?\s*)?([a-zA-Z_]\w*)\s*=/;

  for (const entry of entries) {
    const trimmed = entry.text.trim();
    if (!trimmed || trimmed === '{' || trimmed === '}') continue;
    const isSig = isSignatureLine(trimmed, entry.index);

    let hit = false;

    // 1. Address match
    if (entry.addr != null && targetAddrs.has(entry.addr)) {
      hit = true;
    } else if (addrHexStrings.length) {
      for (const hex of addrHexStrings) {
        if (new RegExp(`\\b0x0*${hex}\\b`, 'i').test(trimmed)) {
          hit = true;
          break;
        }
      }
    }

    // 2. Offset match
    if (!hit && offsetRegexes.length && !isSig) {
      for (const re of offsetRegexes) {
        if (re.test(trimmed)) {
          hit = true;
          break;
        }
      }
    }

    // 3. String literal match
    if (!hit && targetStrings.size) {
      const litRe = /"([^"\\]*)"/g;
      let m;
      while ((m = litRe.exec(trimmed)) !== null) {
        const lowerLit = m[1].toLowerCase();
        for (const s of targetStrings) {
          if (lowerLit.includes(s)) {
            hit = true;
            break;
          }
        }
        if (hit) break;
      }
    }

    // 4. Member field name or goal-related symbol call match
    if (!hit && !isSig && targetFieldNames.size) {
      const memberRe = /(?:->|\.)([a-zA-Z_]\w*)/g;
      let m;
      while ((m = memberRe.exec(trimmed)) !== null) {
        const nameLower = m[1].toLowerCase();
        const plainLower = nameLower.replace(/^_+/, '');
        if (targetFieldNames.has(nameLower) || targetFieldNames.has(plainLower)) {
          hit = true;
          break;
        }
      }
    }

    if (!hit && !isSig && targetSymbols.size) {
      const callRe = /\b([a-zA-Z_][a-zA-Z0-9_:]*)\s*\(/g;
      let m;
      while ((m = callRe.exec(trimmed)) !== null) {
        const calleeLower = m[1].toLowerCase();
        for (const sym of targetSymbols) {
          if (calleeLower === sym || calleeLower.includes(sym)) {
            hit = true;
            break;
          }
        }
        if (hit) break;
      }
    }

    // 5. Dataflow / arithmetic / store lines touching tainted variables or explicit pinpointed registers
    if (!hit && !isSig && taintedVars.size) {
      const isArithOrStore = /[+\-*/]=|[+\-*/]|^\s*\*\(/.test(trimmed);
      if (isArithOrStore) {
        for (const v of taintedVars) {
          if (new RegExp(`\\b${escapeRegExp(v)}\\b`).test(trimmed)) {
            hit = true;
            break;
          }
        }
      }
    }

    if (!hit && !isSig && targetRegisters.size && !targetOffsets.size) {
      const isMemOrArith = /\*\(|[+\-*/]=|[+\-*/]/.test(trimmed);
      if (isMemOrArith) {
        for (const reg of targetRegisters) {
          if (new RegExp(`\\b${escapeRegExp(reg)}\\b`, 'i').test(trimmed)) {
            hit = true;
            break;
          }
        }
      }
    }

    if (hit) {
      matched.add(entry.index);
      const lhsMatch = assignLhsRe.exec(trimmed);
      if (lhsMatch && lhsMatch[1] && !/^(if|while|for|switch|return)$/.test(lhsMatch[1])) {
        taintedVars.add(lhsMatch[1]);
      }
    }
  }

  return [...matched].sort((a, b) => a - b);
}
