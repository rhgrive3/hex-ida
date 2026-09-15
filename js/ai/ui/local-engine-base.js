/*
 * Fallback engine.
 *
 * The AI core drives the assistant whenever it is available. This module is
 * what answers when it is not: no core build, no network, or a provider error
 * mid-turn. It never fabricates — every fact it prints comes from the same
 * deterministic Hex analysis the rest of the app uses — so a degraded session
 * is still a usable one instead of an apology.
 *
 * Chat  : bounded local context, prose from /api/gemini when reachable.
 * Agent : deterministic goal planner (js/query/planner.js) with live activity.
 */
import { runDeterministicAgent } from '../../agent/runtime.js';
import { globalCandidateAuthority } from '../../agent/candidate-authority.js';
import { plannerGoalWithTargetHint } from '../context/planner-target-hint.js';
import { compactUntrustedTarget } from '../context/broker.js';
import { streamGemini } from '../../gemini.js';
import { addrHex } from '../../format.js';
import { pick } from '../../i18n.js';
import { compactGuidance, composePrompt } from '../prompts/compose.js';
import { analyzeModelAt } from './hex-context.js';

const MAX_ASSEMBLY_LINES = 240;
const FUNCTION_QUESTION_RE = /\b(function|method|caller|callee|call graph|xref|basic block)\b|関数|メソッド|呼び出し元|呼び出し先|コールグラフ|基本ブロック/i;
const ASSEMBLY_QUESTION_RE = /\b(assembly|disassembly|instruction|instructions|opcode|mnemonic|arm64|aarch64)\b|アセンブリ|逆アセンブル|逆アセンブリ|命令|オペコード|ニーモニック/i;

export function localChatDependencies({ question, scope, hasFunction = false } = {}) {
  if (!hasFunction) return { functionContext: false, assembly: false };
  const normalizedScope = String(scope || '').trim().toLowerCase();
  if (normalizedScope === 'file' || normalizedScope === 'project') {
    return { functionContext: false, assembly: false };
  }
  const functionContext = normalizedScope === 'function' || FUNCTION_QUESTION_RE.test(String(question || ''));
  return {
    functionContext,
    assembly: functionContext && ASSEMBLY_QUESTION_RE.test(String(question || '')),
  };
}

function assemblyText(model) {
  const rows = (model && model.instructions) || [];
  return rows.slice(0, MAX_ASSEMBLY_LINES)
    .map((item) => [addrHex(item.address), item.mnemonic, item.operands].filter(Boolean).join(' '))
    .join('\n');
}

function evidenceFromModel(model, addr, name) {
  const out = [];
  if (!model) return out;
  const address = addr == null ? null : addrHex(addr);
  out.push({
    id: 'local:boundary:' + address,
    kind: 'function-boundary',
    status: 'verified',
    title: pick('関数の範囲', 'Function boundary'),
    summary: (model.instructions || []).length + pick(' 命令', ' instructions'),
    functionAddress: address,
    functionName: name,
    sourceTool: 'hex-disassembler',
  });
  const stores = (model.instructions || []).filter((item) => /^str/i.test(item.mnemonic || ''));
  for (const store of stores.slice(0, 4)) {
    out.push({
      id: 'local:store:' + addrHex(store.address),
      kind: 'field-write',
      status: 'supported',
      title: pick('メモリへの書き込み', 'Memory write'),
      summary: [store.mnemonic, store.operands].filter(Boolean).join(' '),
      address: addrHex(store.address),
      functionAddress: address,
      functionName: name,
      sourceTool: 'hex-disassembler',
    });
  }
  return out;
}

function localChatAnswer({ name, address, model, selection }) {
  const lines = [];
  if (selection && selection.text) {
    lines.push(pick(
      `選択中の命令は ${selection.address} の \`${selection.text}\` です。`,
      `The selected instruction is \`${selection.text}\` at ${selection.address}.`));
  }
  if (model) {
    const count = (model.instructions || []).length;
    const blocks = (model.blocks || []).length;
    const calls = (model.instructions || []).filter((item) => /^bl$/i.test(item.mnemonic || '')).length;
    const parts = [pick(`${count} 命令`, `${count} instructions`)];
    if (blocks > 1) parts.push(pick(`${blocks} ブロック`, `${blocks} blocks`));
    if (calls) parts.push(pick(`他の関数を ${calls} 箇所から呼び出し`, `${calls} calls to other functions`));
    lines.push(pick(
      `${name}（${address}）は ${parts.join('・')}です。`,
      `${name} (${address}): ${parts.join(', ')}.`));
  }
  lines.push(pick(
    'AI 応答サービスに接続できないため、ここまでは Hex がバイナリから直接確認した事実だけです。解釈は付けていません。',
    'The AI service is unreachable, so this is only what Hex read directly from the binary — no interpretation was added.'));
  return lines.join('\n\n');
}

async function runChat({ app, question, mode, style, scope, context, signal, onActivity, onText }) {
  const fn = context.function || null;
  const dependencies = localChatDependencies({ question, scope, hasFunction: !!fn });
  const activeFn = dependencies.functionContext ? fn : null;
  const addr = activeFn ? activeFn.addressValue : null;
  let model = null;

  if (addr != null) {
    onActivity({ label: pick('現在の関数を読み込み', 'Loading current function'), state: 'running' });
    model = await analyzeModelAt(app, addr, null, { signal });
    onActivity({
      label: pick('現在の関数を読み込み', 'Loading current function'),
      detail: model ? (model.instructions || []).length + pick(' 命令', ' instructions') : pick('解析できません', 'unavailable'),
    });
  }

  const name = activeFn ? activeFn.name : pick('この関数', 'this function');
  const address = activeFn ? activeFn.address : '—';
  const prompt = composePrompt({ mode, style, scope, question, context });
  const assembly = dependencies.assembly ? assemblyText(model) : '';
  const evidence = evidenceFromModel(model, addr, activeFn ? activeFn.name : null);
  const base = {
    mode, style, confidence: null, evidence,
    actions: addr == null ? [] : [{ kind: 'open-function', target: addrHex(addr), label: pick('関数を開く', 'Open function') }],
    followups: [],
  };

  if (!assembly) {
    return { ...base, answer: localChatAnswer({ name, address, model, selection: context.selection }) };
  }

  const payload = {
    question: (compactGuidance(prompt) + '\n\n' + question).slice(0, 6000),
    thinkingLevel: style === 'analyst' ? 'high' : 'medium',
    untrustedTarget: compactUntrustedTarget(context.untrustedTarget),
    currentFunction: { address, name: activeFn ? activeFn.name : null, assembly, pseudocode: null },
    xrefs: [], callers: [], callees: [], strings: [], globals: [],
  };
  let streamed = '';
  try {
    onActivity({ label: pick('AI に問い合わせ', 'Asking the model'), state: 'running' });
    await streamGemini(payload, {
      onText: (chunk) => { streamed += chunk; if (onText) onText(chunk); },
    }, signal);
    onActivity({ label: pick('AI に問い合わせ', 'Asking the model'), detail: pick('完了', 'done') });
  } catch (error) {
    if (signal && signal.aborted) throw error;
    onActivity({ label: pick('AI に問い合わせ', 'Asking the model'), detail: pick('接続できません', 'unreachable'), state: 'error' });
    return { ...base, answer: localChatAnswer({ name, address, model, selection: context.selection }) };
  }
  return { ...base, answer: streamed.trim() || localChatAnswer({ name, address, model, selection: context.selection }) };
}

function candidateEvidence(plan, globallyAuthoritative = true) {
  const out = [];
  for (const candidate of (plan && plan.candidates) || []) {
    const address = candidate.address == null ? null : addrHex(candidate.address);
    const locallyVerified = !!(candidate.verification && candidate.verification.verified);
    // #8673: a positive local verification remains publishable evidence, but
    // while planner/candidate/semantic coverage is incomplete it is explicitly
    // scoped to that candidate instead of minting `verified` candidate
    // authority over the whole candidate universe.
    const verified = locallyVerified && globallyAuthoritative;
    const title = verified
      ? pick('検証済み候補', 'Verified candidate')
      : locallyVerified
        ? pick('候補（候補局所では検証済み・カバレッジ未完了）', 'Candidate (locally verified, incomplete coverage)')
        : pick('候補', 'Ranked candidate');
    out.push({
      id: 'local:candidate:' + address,
      kind: 'candidate',
      status: verified ? 'verified' : 'supported',
      title: title + ': ' + (candidate.name || address),
      summary: pick('決定論的スコア ', 'Deterministic score ') + candidate.score
        + (locallyVerified && !globallyAuthoritative
          ? pick(' · 候補局所の検証のみ（候補宇宙は未完了）', ' · local verification only (candidate universe incomplete)')
          : '')
        + ((candidate.sources || []).length ? ' · ' + candidate.sources.slice(0, 4).join(', ') : ''),
      functionAddress: address,
      functionName: candidate.name || null,
      sourceTool: 'deterministic-goal-planner',
      confidence: verified ? 1 : 0.75,
    });
    if (out.length >= 12) break;
  }
  return out;
}

async function runAgent({ app, localContext, question, mode, style, signal, onActivity, context }) {
  if (signal?.aborted) throw new Error('cancelled');

  const anchor = context?.function || null;
  const anchorParts = [];
  if (anchor?.address) anchorParts.push(String(anchor.address));
  if (anchor?.name) anchorParts.push(pick('関数: ' + anchor.name, 'function: ' + anchor.name));
  onActivity({
    label: pick('解析地点を特定', 'Locating analysis target'),
    detail: anchorParts.join(pick('、', ', ')) || pick('現在の解析コンテキスト', 'current analysis context'),
  });

  // The deterministic planner is already demand-driven: it compiles the goal,
  // requests only the search/graph/semantic tools it needs, and forwards its
  // budget AbortSignal to every tool invocation. Do not pre-build whole-file
  // strings or ProgramIndex here; those unrelated global producers were the
  // dominant first-answer cost and could outlive a cancelled Assistant turn.
  onActivity({ label: pick('候補を探索', 'Searching candidates'), state: 'running' });
  const started = Date.now();
  const plannerGoal = plannerGoalWithTargetHint(question, context?.untrustedTarget);
  const result = await runDeterministicAgent(plannerGoal, localContext || {}, {
    maxFunctions: 24, maxDisassembly: 40000, timeoutMs: 20000,
    signal,
    isCancelled: () => !!(signal && signal.aborted),
  });
  const plan = result.plan || {};
  onActivity({
    label: pick('候補を探索', 'Searching candidates'),
    detail: ((plan.candidates || []).length) + pick(' 候補', ' candidates'),
  });
  const best = plan.best || null;
  if (best) {
    onActivity({
      label: pick('検証', 'Verifying'),
      detail: best.verification && best.verification.verified
        ? pick('更新経路を確認', 'update path confirmed')
        : pick('未検証', 'not verified'),
    });
  }

  const address = best && best.address != null ? addrHex(best.address) : null;
  // #8673: the deterministic planner reports its own candidate/semantic/search
  // coverage. Only a plan whose coverage spans the candidate universe may be
  // projected as the goal-level "strongest candidate" conclusion.
  const authority = globalCandidateAuthority(plan);
  const locallyVerifiedBest = !!(best && best.verification && best.verification.verified);
  const answer = best
    ? (authority.authoritative
      ? pick(
        `いちばん有力なのは ${best.name || address}（${address}）です。Hex の決定論的な探索が候補を順位付けし、${locallyVerifiedBest ? '値の更新経路まで確認できました。' : 'この候補はまだ更新経路を確認できていません。'}`,
        `The strongest candidate is ${best.name || address} (${address}). Hex ranked the candidates deterministically and ${locallyVerifiedBest ? 'confirmed the update path.' : 'has not yet confirmed the update path.'}`)
      : pick(
        `現時点で最も有力なのは ${best.name || address}（${address}）です。Hex の決定論的な探索が候補を順位付けし、${locallyVerifiedBest ? 'この候補の値の更新経路を局所的に確認しました' : 'この候補はまだ更新経路を確認できていません'}が、候補探索または意味解析が未完了のため、全局的な結論は保留しています。`,
        `The best candidate so far is ${best.name || address} (${address}). Hex ranked the candidates deterministically and ${locallyVerifiedBest ? 'verified the update path for this candidate locally' : 'has not yet confirmed the update path'}, but candidate/semantic coverage is incomplete so no global conclusion is claimed.`))
    : pick('この目的に合う関数を、確かな根拠つきでは特定できませんでした。', 'No candidate function could be identified with dependable evidence.');

  const missing = (result.missingEvidence || []).slice(0, 4);
  // A verified hypothesis must name its verified supporting evidence — the
  // same invariant HypothesisStore enforces in core (#5797). The verified
  // candidate evidence is the deterministic verification authority here; if
  // it is absent from the published evidence, the hypothesis stays
  // 'supported' instead of claiming verification without support.
  const verifiedBest = locallyVerifiedBest && authority.authoritative;
  const evidenceList = candidateEvidence(plan, authority.authoritative);
  const supportEvidenceIds = verifiedBest && evidenceList.some((item) => item.id === 'local:candidate:' + address && item.status === 'verified')
    ? ['local:candidate:' + address]
    : [];
  return {
    mode, style,
    answer,
    confidence: result.confidence,
    evidence: evidenceList,
    hypotheses: best ? [{
      id: 'local:hyp:' + address,
      claim: pick(`${best.name || address} が目的の処理を行っている`, `${best.name || address} implements the requested behaviour`),
      confidence: result.confidence,
      status: verifiedBest && supportEvidenceIds.length ? 'verified' : 'supported',
      supportEvidenceIds,
      contradictionEvidenceIds: [],
      missingEvidence: missing,
    }] : [],
    actions: address ? [
      { kind: 'open-function', target: address, label: pick('候補関数を開く', 'Open candidate') },
      { kind: 'show-callers', target: address, label: pick('呼び出し元を見る', 'Show callers') },
    ] : [],
    followups: missing,
    usage: { toolCalls: 0, elapsedMs: Date.now() - started, candidateCount: (plan.candidates || []).length },
    activity: [],
  };
}

/**
 * @param {object} app the Hex app
 * @param {object} localContext the shared AI context (also used by the core)
 */
export function createLocalEngine(app, localContext) {
  return {
    id: 'local',
    async run(input) {
      const args = { ...input, app, localContext };
      return input.mode === 'agent' ? runAgent(args) : runChat(args);
    },
  };
}

export default createLocalEngine;
