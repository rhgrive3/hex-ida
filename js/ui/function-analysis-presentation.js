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
