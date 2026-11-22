import { pick } from '../i18n.js';
import { functionStory, patchImpactPreview } from '../narrate.js';
import { shortName } from '../rtti.js';

const UI_PRESENTATION_ROUTE = Symbol('canonical-function-ui-presentation');

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

/**
 * 初心者向けの関数サマリーカードを構築する。
 * C やアセンブリの前提知識なしで読める日本語見出し・概要・書き換え影響プレビューを先頭に置き、
 * アーキテクチャ名・ABI・生アドレス・シグネチャ等の技術詳細は technicalDetails に分離する。
 */
export function buildBeginnerFunctionCard(result, name = null) {
  const model = result?.model || result?.pipeline?.legacyV1 || null;
  const cfg = result?.pipeline?.cfg || model?.__canonicalCfg || null;
  const blocks = Array.isArray(model?.basicBlocks)
    ? model.basicBlocks
    : presentationBasicBlocks(model);
  const insts = Array.isArray(model?.instructions) ? model.instructions : [];
  const hasSemantic = Boolean(model && model.facts && Array.isArray(model.semantic));
  const displayName = name ? shortName(String(name)) : null;

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

  return {
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
}

export function decorateFunctionAnalysisForUi(result) {
  if (!result || typeof result !== 'object' || result.model) return result;
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
  decorated.beginnerSummary = Object.freeze(buildBeginnerFunctionCard(decorated));
  return decorated;
}

export function installFunctionAnalysisPresentation(app) {
  const original = app?.analyzeFunctionAt;
  if (typeof original !== 'function' || original[UI_PRESENTATION_ROUTE]) return original;
  const routed = async function canonicalUiAnalyzeFunctionAt(...args) {
    return decorateFunctionAnalysisForUi(await original.apply(this, args));
  };
  Object.defineProperty(routed, UI_PRESENTATION_ROUTE, { value:true });
  app.analyzeFunctionAt = routed;
  return routed;
}
