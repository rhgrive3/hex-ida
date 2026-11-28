/*
 * Omnibox intent classification, relevance-ranked search scoring, and goal bridging.
 *
 * One field replaces the old search / jump / command / question split. The
 * rules stay small and predictable on purpose: a user must be able to guess
 * what pressing Enter will do before pressing it.
 *
 *   0x100458c00        -> address
 *   0x100458c00+0x10   -> address
 *   sub_100458C00      -> symbol
 *   "reward"           -> string
 *   > rename           -> command
 *   ? コインはどこで増える -> ai
 *   reward             -> search (symbol + string index)
 *
 * Pure module — no DOM. Tested by tests/ai-ui-mode.mjs and
 * tests/ux-review-55-search-relevance.test.mjs.
 */
import { parseGoal, goalLabel } from '../../goals.js';

export const KINDS = Object.freeze(['empty', 'address', 'symbol', 'string', 'command', 'ai', 'search']);

export const SEARCH_CATEGORIES = Object.freeze({
  function: '関数',
  string: '文字列',
  class: 'クラス',
  field: 'フィールド',
});

export const COMMANDS = Object.freeze([
  { id: 'code', ja: 'コードを開く', en: 'Open code', match: /^(code|コード|asm|アセンブリ)$/i },
  { id: 'explorer', ja: '索引を開く', en: 'Open explorer', match: /^(index|explorer|索引|一覧)$/i },
  { id: 'results', ja: '結果を開く', en: 'Open results', match: /^(results?|結果)$/i },
  { id: 'settings', ja: '設定', en: 'Settings', match: /^(settings?|setting|設定|環境設定)$/i },
  { id: 'help', ja: 'ヘルプ', en: 'Help', match: /^(help|ヘルプ|使い方)$/i },
  { id: 'learn', ja: '学ぶ', en: 'Learn', match: /^(learn|学ぶ|学習)$/i },
  { id: 'advanced', ja: '高度な機能', en: 'Advanced', match: /^(advanced|lab|高度)$/i },
  { id: 'search', ja: '命令・バイト列を検索', en: 'Search', match: /^(search|find|検索|探す)$/i },
  { id: 'jump', ja: 'アドレスへジャンプ', en: 'Jump', match: /^(jump|goto|go|ジャンプ|移動)$/i },
  { id: 'patch', ja: 'パッチ一覧を開く', en: 'Patches', match: /^(patch|patches|パッチ|書き換え)$/i },
  { id: 'export', ja: 'プロジェクトを書き出す', en: 'Export', match: /^(export|hexproj|save|書き出し|書き出す|保存)$/i },
  { id: 'import', ja: 'プロジェクトを読み込む', en: 'Import', match: /^(import|load|読み込み|読み込む|復元)$/i },
  { id: 'pseudocode', ja: '疑似Cを開く', en: 'Pseudocode', match: /^(pseudo|pseudocode|decompile|疑似c|逆コンパイル)$/i },
  { id: 'diff', ja: 'バイナリを比較', en: 'Diff', match: /^(diff|差分)$/i },
  { id: 'ai', ja: 'AIに聞く', en: 'Ask AI', match: /^(ai|ask|聞く|質問)$/i },
  { id: 'investigate', ja: '目的から自動解析', en: 'Auto-investigate goal', match: /^(investigate|auto|調査|調べる|自動解析)$/i },
  { id: 'agent', ja: 'AIエージェントを開く', en: 'Open AI Agent', match: /^(agent|エージェント)$/i },
]);

const HAS_JA = /[぀-ヿ㐀-鿿]/;
const QUESTION_TAIL = /[?？]\s*$/;
const JA_QUESTION = /(どこ|どれ|なに|何|なぜ|どうやって|教えて|ですか|でしょうか|してる|している|したい|探して|調べて)/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:(?:::|\.|->)[\w$]+)*$/;
const OBJC_METHOD = /^[+-]\s*\[[^\]]+\]$/;
const ADDR_EXPR = /^(?:(?:0[xX][0-9a-fA-F]+|(?=[0-9a-fA-F]{6,16}\b)(?=[0-9a-fA-F]*[0-9])[0-9a-fA-F]{6,16})\s*[+-]\s*(?:0[xX][0-9a-fA-F]+|\d+)|[A-Za-z_$][\w$]*(?:(?:::|\.|->)[\w$]+)*\s*(?:\+\s*(?:0[xX][0-9a-fA-F]+|\d+)|-\s*0[xX][0-9a-fA-F]+))$/;
const WORD_SEP_RE = /[\s_\-:[\]/.(),<>*&+?!@#$%^=\\|;'"`~・、。]/;

function isLower(ch) { return ch >= 'a' && ch <= 'z'; }
function isUpper(ch) { return ch >= 'A' && ch <= 'Z'; }
function isDigit(ch) { return ch >= '0' && ch <= '9'; }
function isWordSep(ch) { return !ch || WORD_SEP_RE.test(ch); }

function isWordStartBoundary(str, idx) {
  if (idx <= 0) return true;
  const prev = str[idx - 1];
  const curr = str[idx];
  if (isWordSep(prev)) return true;
  if (isLower(prev) && isUpper(curr)) return true;
  if (isDigit(prev) && (isLower(curr) || isUpper(curr))) return true;
  if (isUpper(prev) && isUpper(curr) && idx + 1 < str.length && isLower(str[idx + 1])) return true;
  return false;
}

function isWordEndBoundary(str, end) {
  if (end >= str.length) return true;
  const prev = str[end - 1];
  const next = str[end];
  if (isWordSep(next)) return true;
  if (isLower(prev) && isUpper(next)) return true;
  if ((isLower(prev) || isUpper(prev)) && isDigit(next)) return true;
  if (isUpper(prev) && isUpper(next) && end + 1 < str.length && isLower(str[end + 1])) return true;
  return false;
}

/**
 * Relevance-ranked search match scorer (word boundary first):
 *   Tier 1 (400): Exact match (case-insensitive)
 *   Tier 2 (300-310): Word-boundary token match (separator or camelCase boundary)
 *   Tier 3 (200): Prefix match
 *   Tier 4 (100): Substring match (e.g., "flushPlayer" matching "HP" across "hP")
 *   0: No match
 *
 * @param {string} name
 * @param {string} query
 * @returns {number}
 */
export function scoreSearchMatch(name, query) {
  if (typeof name !== 'string' || typeof query !== 'string') return 0;
  const rawQuery = query.trim();
  if (!name || !rawQuery) return 0;

  const lowerName = name.toLowerCase();
  const lowerQuery = rawQuery.toLowerCase();
  if (lowerName === lowerQuery) return 400;

  let pos = lowerName.indexOf(lowerQuery);
  if (pos < 0) return 0;

  let best = 100;
  while (pos >= 0) {
    const end = pos + lowerQuery.length;
    if (isWordStartBoundary(name, pos) && isWordEndBoundary(name, end)) {
      const boundaryScore = pos === 0 ? 310 : 300;
      if (boundaryScore > best) best = boundaryScore;
    } else if (pos === 0 && best < 200) {
      best = 200;
    }
    pos = lowerName.indexOf(lowerQuery, pos + 1);
  }
  return best;
}

function toComparableAddr(addr) {
  if (addr == null) return null;
  if (typeof addr === 'bigint') return addr;
  if (typeof addr === 'number' && Number.isSafeInteger(addr)) return BigInt(addr);
  if (typeof addr === 'string' && addr.trim()) {
    try { return BigInt(addr.trim()); } catch { return null; }
  }
  return null;
}

/**
 * Sort comparator: relevance score descending, then shorter name, then address ascending.
 */
export function compareSearchResults(a, b) {
  const scoreDiff = (b?.score ?? 0) - (a?.score ?? 0);
  if (scoreDiff !== 0) return scoreDiff;

  const nameA = String(a?.name ?? a?.text ?? '');
  const nameB = String(b?.name ?? b?.text ?? '');
  const lenDiff = nameA.length - nameB.length;
  if (lenDiff !== 0) return lenDiff;

  const addrA = toComparableAddr(a?.addr);
  const addrB = toComparableAddr(b?.addr);
  if (addrA != null && addrB != null) {
    if (addrA < addrB) return -1;
    if (addrA > addrB) return 1;
  } else if (addrA != null) {
    return -1;
  } else if (addrB != null) {
    return 1;
  }

  return nameA.localeCompare(nameB);
}

/**
 * Score, filter, and sort search candidates by relevance.
 *
 * @template T
 * @param {T[]} items
 * @param {string} query
 * @param {(item: T) => string} [getName]
 * @returns {Array<T & { score: number }>}
 */
export function rankSearchResults(items, query, getName = (item) => String(item?.name ?? item?.text ?? '')) {
  if (!Array.isArray(items) || !items.length) return [];
  const ranked = [];
  for (const item of items) {
    const score = scoreSearchMatch(getName(item), query);
    if (score > 0) ranked.push({ ...item, score });
  }
  ranked.sort(compareSearchResults);
  return ranked;
}

/**
 * Match a search query against preset goals in js/goals.js.
 * Returns a goal-bridge action descriptor or null when no preset goal matches.
 *
 * @param {string} query
 * @returns {{ goal: object, id: string, label: string, actionLabel: string } | null}
 */
export function matchGoalForQuery(query) {
  const raw = String(query ?? '').trim();
  if (!raw) return null;
  const goal = parseGoal(raw);
  if (!goal || goal.free || goal.id === 'free') return null;
  const label = goalLabel(goal);
  return {
    goal,
    id: goal.id,
    label,
    actionLabel: `目的として調べる: ${label}`,
  };
}

/**
 * Build unified omnibox/search items from categorized candidates and prepend
 * the goal-investigation bridge row when the query matches a preset goal.
 *
 * @param {string} query
 * @param {Array<{category?:string, kind?:string, name?:string, text?:string, addr?:bigint|number|null, sub?:string}>} candidates
 * @returns {Array<object>}
 */
export function buildOmniboxSearchItems(query, candidates = []) {
  const ranked = [];
  for (const item of candidates || []) {
    if (!item) continue;
    const category = item.category || item.kind || 'function';
    const badge = item.badge || SEARCH_CATEGORIES[category] || SEARCH_CATEGORIES.function;
    const primaryName = String(item.name ?? item.text ?? '');
    let score = scoreSearchMatch(primaryName, query);
    if (item.altName) {
      const altScore = scoreSearchMatch(String(item.altName), query);
      if (altScore > score) score = altScore;
    }
    if (score <= 0) continue;
    ranked.push({
      ...item,
      kind: item.kind || category,
      category,
      badge,
      name: primaryName,
      score,
    });
  }
  ranked.sort(compareSearchResults);

  const goalMatch = matchGoalForQuery(query);
  if (!goalMatch) return ranked;
  return [
    {
      kind: 'goal',
      category: 'goal',
      badge: '目的',
      name: goalMatch.actionLabel,
      label: goalMatch.actionLabel,
      goal: goalMatch.goal,
      goalId: goalMatch.id,
      goalLabel: goalMatch.label,
      score: Infinity,
    },
    ...ranked,
  ];
}

function stripPrefix(value, re) {
  return value.replace(re, '').trim();
}

/**
 * @param {string} input raw omnibox text
 * @returns {{kind:string, value:string, raw:string, command?:string}}
 */
export function classifyOmnibox(input) {
  const raw = String(input == null ? '' : input);
  const value = raw.trim();
  if (!value) return { kind: 'empty', value: '', raw };

  if (/^[?？]/.test(value)) {
    const q = stripPrefix(value, /^[?？]+\s*/);
    return q ? { kind: 'ai', value: q, raw } : { kind: 'empty', value: '', raw };
  }
  if (/^[>＞]/.test(value)) {
    const body = stripPrefix(value, /^[>＞]+\s*/);
    const hit = COMMANDS.find((command) => command.match.test(body));
    return { kind: 'command', value: body, command: hit ? hit.id : null, raw };
  }
  const QUOTE_PAIRS = { '"': '"', "'": "'", '“': '”', '”': '”', '「': '」' };
  if (value.length >= 2 && Object.hasOwn(QUOTE_PAIRS, value[0]) && QUOTE_PAIRS[value[0]] === value[value.length - 1]) {
    return { kind: 'string', value: value.slice(1, -1), raw };
  }

  if (/^0[xX][0-9a-fA-F]+$/.test(value) || (/^[0-9a-fA-F]{6,16}$/.test(value) && /[0-9]/.test(value)) || ADDR_EXPR.test(value)) {
    return { kind: 'address', value, raw };
  }
  if (/^sub_[0-9a-fA-F]+$/i.test(value) || OBJC_METHOD.test(value)) {
    return { kind: 'symbol', value, raw };
  }

  const words = value.split(/\s+/);
  const naturalLanguage = QUESTION_TAIL.test(value)
    || (HAS_JA.test(value) && (JA_QUESTION.test(value) || value.length >= 8))
    || words.length >= 4;
  if (naturalLanguage) return { kind: 'ai', value, raw };

  if (words.length === 1 && IDENTIFIER.test(value) && (/[_$]|::|\./.test(value) || value.length >= 12)) {
    return { kind: 'symbol', value, raw };
  }
  return { kind: 'search', value, raw };
}

/** Short label describing what Enter will do. Used by the omnibox hint chip. */
export function intentLabel(kind, ja = true) {
  switch (kind) {
    case 'address': return ja ? 'アドレスへ移動' : 'Go to address';
    case 'symbol': return ja ? 'シンボルを開く' : 'Open symbol';
    case 'string': return ja ? '文字列を探す' : 'Find string';
    case 'command': return ja ? 'コマンド' : 'Command';
    case 'ai': return ja ? 'AIに聞く' : 'Ask AI';
    case 'search': return ja ? '検索' : 'Search';
    default: return '';
  }
}

export default classifyOmnibox;
