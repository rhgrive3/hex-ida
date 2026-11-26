import { validateRenderProvenance, renderRecordWitnesses } from '../decompiler/phase8/render-provenance.js';
import { addrHex, parseAddress } from '../format.js';
import { decompiledText } from '../decompile.js';
import { h, uiButton } from './primitives.js';

const EMPTY = Object.freeze([]);

/*
 * Display-only C highlighting. Each token is a child span of its line, so the
 * line's text (what Copy and the provenance map see) stays byte-identical.
 */
const C_TOKEN = /(\/\*.*?\*\/|\/\/.*$)|("(?:\\.|[^"\\])*")|(^\s*#(?:include|define|ifdef|ifndef|if|elif|else|endif|pragma)\b)|(\b0x[0-9a-fA-F]+\b|\b\d+\b)|\b(if|else|while|for|do|return|break|continue|switch|case|default|goto|typedef|struct|union|enum|sizeof|const|static|extern)\b|\b(void|bool|char|short|int|long|float|double|unsigned|signed|size_t|uintptr_t|intptr_t|u?int(?:8|16|32|64|128)(?:_t)?)\b|\b(__hex_(?:state|nzcv|stack_frame)\w*)\b|\b([A-Za-z_]\w*)(?=\s*\()|\b([A-Za-z_]\w*)\b/g;
const C_TOKEN_CLASS = ['tok-cmt', 'tok-str', 'tok-pp', 'tok-num', 'tok-kw', 'tok-type', 'tok-internal', 'tok-fn', 'tok-id'];
const CMT_ADDR_RE = /^(\/\*\s*(?:block|entry|case)\s+)(0x[0-9a-fA-F]+)(\s*\*\/)$/;

export function appendHighlighted(row, content, { isSig = false, resolveCallee = null, onOpenCallee = null, onOpenAddress = null, onBookmarkAddress = null, text = null } = {}) {
  const txt = typeof text === 'function' ? text : ((_ja, en) => en);
  let last = 0;
  C_TOKEN.lastIndex = 0;
  for (let match = C_TOKEN.exec(content); match; match = C_TOKEN.exec(content)) {
    if (!match[0]) { C_TOKEN.lastIndex++; continue; }
    if (match.index > last) row.append(h('span', null, content.slice(last, match.index)));
    const group = match.slice(1).findIndex(value => value !== undefined);
    const cls = C_TOKEN_CLASS[group] || null;
    const tokenText = match[0];
    if (cls === 'tok-cmt' && typeof onOpenAddress === 'function') {
      const addrMatch = CMT_ADDR_RE.exec(tokenText);
      if (addrMatch) {
        let addrBig = null;
        try { addrBig = BigInt(addrMatch[2]); } catch { addrBig = null; }
        if (addrBig != null) {
          const link = h('span', 'tok-cmt tok-addr-link', addrMatch[2]);
          link.setAttribute('role', 'link');
          link.tabIndex = 0;
          link.setAttribute('data-addr', addrMatch[2]);
          link.title = typeof onBookmarkAddress === 'function'
            ? txt(`${addrMatch[2]} の命令へ移動（Shift+クリックでブックマーク）`, `Jump to ${addrMatch[2]} (Shift+click to bookmark)`)
            : txt(`${addrMatch[2]} の命令へ移動`, `Jump to ${addrMatch[2]}`);
          link.addEventListener('click', (event) => {
            event.stopPropagation();
            if (event.shiftKey && typeof onBookmarkAddress === 'function') {
              onBookmarkAddress(addrBig);
              return;
            }
            onOpenAddress(addrBig);
          });
          if (typeof onBookmarkAddress === 'function') {
            link.addEventListener('contextmenu', (event) => {
              event.preventDefault();
              event.stopPropagation();
              onBookmarkAddress(addrBig);
            });
          }
          link.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              onOpenAddress(addrBig);
            }
          });
          row.append(h('span', 'tok-cmt', addrMatch[1]), link, h('span', 'tok-cmt', addrMatch[3]));
          last = match.index + tokenText.length;
          continue;
        }
      }
    }
    if (cls === 'tok-fn' && !isSig && typeof resolveCallee === 'function' && typeof onOpenCallee === 'function') {
      let addr = null;
      try { addr = resolveCallee(tokenText); } catch { addr = null; }
      if (addr != null) {
        const link = h('span', 'tok-fn tok-fn-link', tokenText);
        link.tabIndex = 0;
        link.setAttribute('role', 'link');
        link.setAttribute('data-tok', tokenText);
        link.title = txt(`${tokenText} の疑似Cを開く`, `Open pseudocode for ${tokenText}`);
        link.addEventListener('click', (event) => {
          event.stopPropagation();
          onOpenCallee(addr, tokenText);
        });
        link.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            onOpenCallee(addr, tokenText);
          }
        });
        row.append(link);
        last = match.index + tokenText.length;
        continue;
      }
    }
    const span = h('span', cls, tokenText);
    if (cls === 'tok-id' || cls === 'tok-internal' || cls === 'tok-fn') {
      span.setAttribute('data-tok', tokenText);
    }
    row.append(span);
    last = match.index + tokenText.length;
  }
  if (last < content.length) row.append(h('span', null, content.slice(last)));
}

export function attachTokenHighlight(codeEl, { onHighlightChange } = {}) {
  const notifyChange = typeof onHighlightChange === 'function' ? onHighlightChange : null;
  if (!codeEl || typeof codeEl.addEventListener !== 'function') {
    return {
      clear() {},
      next() {},
      prev() {},
      destroy() {},
      get activeToken() { return null; },
      get count() { return 0; },
      get index() { return -1; },
    };
  }
  let tokenIndex = null;
  let activeToken = null;
  let activeNodes = [];
  let activeIdx = -1;
  const ensureIndex = () => {
    if (tokenIndex) return tokenIndex;
    tokenIndex = new Map();
    for (const node of codeEl.querySelectorAll('[data-tok]')) {
      const tok = node.getAttribute('data-tok');
      if (!tok) continue;
      let list = tokenIndex.get(tok);
      if (!list) { list = []; tokenIndex.set(tok, list); }
      list.push(node);
    }
    return tokenIndex;
  };
  const emit = () => {
    notifyChange?.({ token: activeToken, count: activeNodes.length, index: activeIdx });
  };
  const setCurrent = (nextIdx, scroll = false) => {
    if (!activeNodes.length) {
      activeIdx = -1;
      return;
    }
    if (activeIdx >= 0 && activeIdx < activeNodes.length) {
      activeNodes[activeIdx].classList.remove('tok-hit-current');
    }
    activeIdx = ((nextIdx % activeNodes.length) + activeNodes.length) % activeNodes.length;
    const current = activeNodes[activeIdx];
    current.classList.add('tok-hit-current');
    if (scroll) current.scrollIntoView?.({ block: 'nearest' });
  };
  const clear = ({ silent = false } = {}) => {
    const hadActive = activeToken != null || activeNodes.length > 0;
    for (const node of activeNodes) {
      node.classList.remove('tok-hit');
      node.classList.remove('tok-hit-current');
    }
    activeNodes = [];
    activeToken = null;
    activeIdx = -1;
    if (!silent && hadActive) emit();
  };
  const next = () => {
    if (!activeNodes.length) return;
    setCurrent(activeIdx + 1, true);
    emit();
  };
  const prev = () => {
    if (!activeNodes.length) return;
    setCurrent(activeIdx - 1, true);
    emit();
  };
  const onClick = (event) => {
    const target = event.target?.closest?.('[data-tok]');
    if (!target || !codeEl.contains(target)) {
      if (activeToken != null) clear();
      return;
    }
    if (target.classList.contains('tok-fn-link') || target.classList.contains('tok-addr-link')) return;
    const tok = target.getAttribute('data-tok');
    if (!tok) return;
    if (activeToken === tok) {
      clear();
      return;
    }
    clear({ silent: true });
    const matches = ensureIndex().get(tok) || [];
    for (const node of matches) node.classList.add('tok-hit');
    activeToken = tok;
    activeNodes = matches;
    const clickedIdx = matches.indexOf(target);
    setCurrent(clickedIdx >= 0 ? clickedIdx : 0, false);
    emit();
  };
  const onKeyDown = (event) => {
    if (event.key !== 'Escape' || activeToken == null || event.defaultPrevented) return;
    if (typeof document !== 'undefined' && document.querySelector?.('.sheet, .menu, .dialog')) return;
    event.preventDefault();
    clear();
  };
  codeEl.addEventListener('click', onClick);
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('keydown', onKeyDown);
  }
  return {
    clear: () => clear(),
    next,
    prev,
    destroy: () => {
      clear({ silent: true });
      codeEl.removeEventListener('click', onClick);
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('keydown', onKeyDown);
      }
    },
    get activeToken() { return activeToken; },
    get count() { return activeNodes.length; },
    get index() { return activeIdx; },
  };
}

// The self-contained typedef/comment/preprocessor header every result starts with.
// Folded by default so the function itself is the first thing on screen.
function lineTextOf(line) {
  return typeof line === 'string' ? line : String(line?.text ?? '');
}

function isPreludeLine(line, hasSigAhead) {
  if (typeof line === 'object' && line?.kind === 'sig') return false;
  const text = lineTextOf(line).trim();
  if (!text) return hasSigAhead;
  if (/^(\/\*.*\*\/|\/\/|#(?:if|ifdef|ifndef|elif|else|endif|pragma|include|define)\b)/.test(text)) return true;
  if (/^(?:typedef|static|extern)\b/.test(text) && (hasSigAhead || /;\s*$/.test(text))) return true;
  if (hasSigAhead && /;\s*$/.test(text) && !text.includes('{') && !text.includes('}')) return true;
  return false;
}

export function findSignatureLineIndex(rawLines) {
  if (!Array.isArray(rawLines) || !rawLines.length) return -1;
  let inBlockComment = false;
  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = lineTextOf(rawLines[i]).trim();
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (!trimmed) continue;
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) continue;
    if (/^(?:typedef|static|extern)\b/.test(trimmed) && /;\s*$/.test(trimmed)) continue;
    if (/;\s*$/.test(trimmed) && !trimmed.includes('{') && !trimmed.includes('}')) continue;
    return i;
  }
  return -1;
}

export function preludeLength(lines) {
  if (!Array.isArray(lines) || !lines.length) return 0;
  let firstSig = lines.findIndex((line) => typeof line === 'object' && line?.kind === 'sig');
  if (firstSig < 0 && typeof lines[0] === 'string') {
    firstSig = findSignatureLineIndex(lines);
  }
  const limit = firstSig >= 0 ? firstSig : lines.length;
  let count = 0;
  while (count < limit) {
    if (!isPreludeLine(lines[count], firstSig >= 0)) break;
    count++;
  }
  return count;
}

const REASON_TEXT = {
  'incomplete-map':['この関数は、疑似Cの行と命令の対応表が一部しかありません。', 'The line-to-instruction map for this function is incomplete.'],
  'missing-render-snapshot':['この疑似Cには、命令との対応表が付いていません。', 'This pseudocode carries no line-to-instruction map.'],
  'missing-query-snapshot':['この疑似Cには、命令との対応表が付いていません。', 'This pseudocode carries no line-to-instruction map.'],
  'stale-query-snapshot':['解析結果が更新されました。疑似Cを開き直してください。', 'The analysis changed. Reopen the pseudocode.'],
  'stale-view':['表示が古くなりました。疑似Cを開き直してください。', 'This view is out of date. Reopen the pseudocode.'],
  'invalid-address':['アドレスの形が正しくありません（例: 0x100000450）。', 'Enter an address such as 0x100000450.'],
};

// The render ledger intentionally retains typed BigInt addresses for audit/replay,
// while navigation outcomes cross a UI/query boundary and must be JSON-safe.
// Keep the canonical ledger record untouched and publish only a shallow origin
// view with decimal address identities when necessary.
function navigationWitness(record) {
  const addresses = record?.origin?.addresses;
  if (!Array.isArray(addresses) || !addresses.some(value => typeof value === 'bigint')) return record;
  return Object.freeze({
    ...record,
    origin:Object.freeze({
      ...record.origin,
      addresses:Object.freeze(addresses.map(value => typeof value === 'bigint' ? value.toString() : value)),
    }),
  });
}

/** Navigation over the existing C4-03 map, not a new semantic identity/index.
 * The outer AnalysisQueryAPI snapshot and the inner IR snapshot are distinct:
 * the former guards the lifetime of the latter's immutable query projection.
 */
export function createDecompilerNavigation(query, { currentSnapshot, isCurrent = () => true, signal } = {}) {
  const result = query?.value;
  const map = result?.renderProvenance;
  let reason = null;
  let selected = EMPTY;
  let revision = 0;
  try {
    if (typeof query?.snapshotId !== 'string' || !query.snapshotId || typeof currentSnapshot !== 'function') reason = 'missing-query-snapshot';
    else if (typeof map?.snapshotId !== 'string' || !map.snapshotId) reason = 'missing-render-snapshot';
    else if (map.completeness !== 'complete' || validateRenderProvenance(map).state !== 'complete') reason = 'incomplete-map';
    else if (!map.reverse || typeof map.reverse !== 'object' || Array.isArray(map.reverse)) reason = 'invalid-reverse-map';
    else if (!Array.isArray(result.lines)) reason = 'missing-rendered-lines';
  } catch { reason = 'invalid-map'; }

  const unavailable = value => Object.freeze({ state:'unavailable', reason:value, entities:EMPTY, transforms:EMPTY });
  const check = async () => {
    if (reason) return reason;
    if (signal?.aborted || !isCurrent()) return 'stale-view';
    try {
      const fresh = await currentSnapshot();
      if (signal?.aborted || !isCurrent()) return 'stale-view';
      if (fresh?.snapshotId !== query.snapshotId) return 'stale-query-snapshot';
    } catch { return signal?.aborted ? 'cancelled' : 'snapshot-unavailable'; }
    return null;
  };
  const publish = (refs, recordRefs = [], originKey = null) => {
    const entries = [];
    for (const ref of [...new Set(refs)]) {
      const entity = Object.hasOwn(map.entities, ref) ? map.entities[ref] : null;
      const index = entity?.lineIndex;
      if (!entity || entity.complete !== true || !Number.isSafeInteger(index) || index < 0
          || index >= result.lines.length || entity.entityKey !== ref
          || entity.kind !== result.lines[index]?.kind) return unavailable('unresolved-rendered-entity');
      entries.push(entity);
    }
    const transforms = [];
    for (const index of new Set([...recordRefs, ...entries.flatMap(entity => entity.recordRefs)])) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= map.ledger.length) return unavailable('unresolved-transform-record');
      const record = map.ledger[index];
      if (!record || typeof record !== 'object' || Array.isArray(record)) return unavailable('unresolved-transform-record');
      for (const witness of renderRecordWitnesses(record)) {
        if (record.kind !== 'state-consumer-group' || witness.producedRefs.some(ref => refs.includes(ref))
            || originKey && (witness.originHistory.consumedRefs.includes(originKey) || witness.originHistory.producedRefs.includes(originKey))) {
          transforms.push(navigationWitness(witness));
        }
      }
    }
    selected = Object.freeze(entries.sort((a, b) => a.lineIndex - b.lineIndex));
    return Object.freeze({ state:'ready', reason:null, entities:selected, transforms:Object.freeze(transforms) });
  };

  return Object.freeze({
    available:reason == null,
    reason,
    async checkSnapshot() {
      const refusal = await check();
      return refusal ? unavailable(refusal) : Object.freeze({ state:'ready', reason:null, entities:EMPTY, transforms:EMPTY });
    },
    async selectLine(index) {
      const request = ++revision;
      selected = EMPTY;
      const refusal = await check();
      if (request !== revision) return unavailable('superseded-selection');
      if (refusal) return unavailable(refusal);
      if (!Number.isSafeInteger(index) || index < 0 || index >= result.lines.length) return unavailable('invalid-line');
      return publish([`L${index}:${result.lines[index].kind ?? 'null'}`]);
    },
    async selectOrigin(kind, value) {
      const request = ++revision;
      selected = EMPTY;
      const refusal = await check();
      if (request !== revision) return unavailable('superseded-selection');
      if (refusal) return unavailable(refusal);
      if (!['addr', 'row', 'ir', 'ssa'].includes(kind)
          || !['string', 'bigint', 'number'].includes(typeof value)
          || typeof value === 'number' && !Number.isSafeInteger(value)) return unavailable('invalid-origin');
      const key = `${kind}:${value}`;
      const refs = Object.hasOwn(map.reverse, key) ? map.reverse[key] : EMPTY;
      if (!Array.isArray(refs)) return unavailable('invalid-reverse-map');
      // Follow the producer's reverse index, and require its forward edge too.
      const field = { addr:'addresses', row:'rows', ir:'ir', ssa:'ssaRefs' }[kind];
      if (refs.some(ref => !map.entities[ref]?.origins?.[field]?.some(origin => String(origin) === String(value)))) {
        return unavailable('inconsistent-reverse-map');
      }
      const recordRefs = map.transformReverse && Object.hasOwn(map.transformReverse, key) ? map.transformReverse[key] : EMPTY;
      if (!Array.isArray(recordRefs)) return unavailable('invalid-transform-reverse-map');
      for (const index of recordRefs) {
        const record = Array.isArray(map?.ledger) && Number.isInteger(index) && index >= 0 && index < map.ledger.length ? map.ledger[index] : null;
        if (!record || typeof record !== 'object') return unavailable('inconsistent-transform-reverse-map');
        const matches = renderRecordWitnesses(record).some(witness => {
        const history = witness?.originHistory;
        return history
          ? history.consumedRefs?.includes(key) || history.producedRefs?.includes(key)
          : witness?.origin?.[{ addr:'addresses', row:'rows', ir:'ir', ssa:value?.startsWith?.('def:') ? 'ssaDefs' : 'ssaUses' }[kind]]
            ?.some(origin => String(origin) === (kind === 'ssa' ? String(value).replace(/^(def|use):/, '') : String(value)));
        });
        if (!matches) return unavailable('inconsistent-transform-reverse-map');
      }
      return publish(refs, recordRefs, key);
    },
    async openAddress(address, navigate) {
      const selection = selected;
      const request = revision;
      const refusal = await check();
      if (refusal) return unavailable(refusal);
      if (request !== revision || selection !== selected) return unavailable('superseded-selection');
      if (typeof address !== 'bigint' || address < 0n || typeof navigate !== 'function'
          || !selected.some(entity => entity.origins.addresses.some(origin => String(origin) === String(address)))) {
        return unavailable('address-not-in-selection');
      }
      navigate(address);
      return Object.freeze({ state:'ready', reason:null, entities:selected });
    },
  });
}

/** Product pseudocode consumer. Text and navigation share the same logical
 * lines; a wrapped display never changes the canonical line/entity mapping.
 */
export function createDecompilerProvenanceView(query, options = {}) {
  const text = options.text ?? ((_ja, en) => en);
  const navigation = createDecompilerNavigation(query, options);
  const root = h('div', 'ui-decompiler-provenance');
  const code = h('pre', 'ui-pseudocode mono');
  code.tabIndex = 0;
  const status = h('p', 'ui-hint');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const details = h('div', 'ui-code-toolbar ui-provenance-details');
  let currentSelectedAddr = null;
  const history = h('div', 'ui-provenance-history');
  const controls = h('div', 'ui-code-toolbar');
  const input = h('input', 'mono');
  input.type = 'text';
  input.placeholder = '0x…';
  input.setAttribute('aria-label', text('対応する命令アドレス', 'Instruction address'));
  const rows = [];
  let action = 0;
  const label = value => addrHex(BigInt(value));
  const reasonText = reason => {
    const entry = REASON_TEXT[reason];
    return entry ? text(entry[0], entry[1]) : text('対応表を利用できません。', 'Mapping unavailable.');
  };
  const show = outcome => {
    details.replaceChildren();
    history.replaceChildren();
    const active = new Set(outcome.entities.map(entity => entity.lineIndex));
    for (let index = 0; index < rows.length; index++) {
      rows[index].classList.toggle('selected', active.has(index));
      rows[index].setAttribute('aria-current', active.has(index) ? 'true' : 'false');
    }
    if (outcome.state !== 'ready') {
      status.textContent = reasonText(outcome.reason);
      return;
    }
    const recordsWithHistory = (outcome.transforms ?? EMPTY).filter(record => record.originHistory || record.suppressedRender);
    const changeHistoryPage = async offset => {
      const serial = ++action;
      const current = await navigation.checkSnapshot();
      if (serial !== action) return;
      if (current.state !== 'ready') show(current);
      else showHistory(offset);
    };
    const showHistory = offset => {
      history.replaceChildren();
      for (const record of recordsWithHistory.slice(offset, offset + 16)) {
        const item = h('details');
        item.append(h('summary', 'ui-hint', `${record.rule} (${record.proof})`));
        if (record.suppressedRender) {
          item.append(h('p', 'ui-hint', text('初期表示で省略: ', 'Omitted during initial rendering: ') + record.suppressedRender.reason));
          item.append(h('pre', 'mono', text('元の命令: ', 'Original instructions: ') + record.origin.ir.join(', ') + '\n'
            + text('対応する変換前のC行はありません。意味上の削除や等価性の証明ではありません。',
              'No pre-transform C line exists. This is not proof of semantic deletion or equivalence.')));
          history.append(item);
          continue;
        }
        const origins = record.originHistory;
        if (record.renderedRemoval) {
          const removal = record.renderedRemoval;
          item.append(h('p', 'ui-hint',
            (removal.operation === 'suppress' ? text('表示文を非表示化', 'Rendered statement suppressed')
              : text('表示文を削除', 'Rendered statement removed'))
            + text('（変換前の行 ', ' (pre-transform line ') + (removal.lineIndex + 1) + text('）', ')')
            + (record.removedRefs?.length ? '' : text(' — 対応未確定', ' — binding unresolved'))));
        }
        item.append(h('pre', 'mono',
          text('変換前: ', 'Consumed: ') + origins.consumedRefs.join(', ') + '\n'
          + text('変換後: ', 'Produced: ') + origins.producedRefs.join(', ') + '\n'
          + text('式の出典から除去: ', 'Elided expression origins: ') + origins.elidedRefs.join(', ') + '\n'
          + (record.renderedBinding === 'producer-bound'
            ? text('この式を使う表示行に対応しています。IRの削除を意味しません。',
              'Bound to the rendered consumer of this expression. This does not mean canonical IR was deleted.')
            : text('表示行への対応は未確定です。IRの削除を意味しません。',
              'Rendered binding is unresolved. This does not mean canonical IR was deleted.'))));
        history.append(item);
      }
      if (offset > 0) history.append(uiButton(text('前の履歴', 'Previous history'), { onClick:() => changeHistoryPage(offset - 16) }));
      if (offset + 16 < recordsWithHistory.length) history.append(uiButton(text('次の履歴', 'Next history'), { onClick:() => changeHistoryPage(offset + 16) }));
    };
    showHistory(0);
    if (!outcome.entities.length) {
      currentSelectedAddr = null;
      status.textContent = recordsWithHistory.length && recordsWithHistory.every(record => record.suppressedRender)
        ? text('初期表示での省略履歴があります。対応する表示行はありません。', 'Initial-render omission history exists. There is no corresponding rendered line.')
        : recordsWithHistory.length
        ? text('変換履歴がありますが、表示行への対応は未確定です。', 'Transform history exists, but its rendered binding is unresolved.')
        : text('この命令に対応する表示行はありません。', 'No rendered line maps to this instruction.');
      return;
    }
    status.textContent = `${outcome.entities.length} ` + text('行が対応しています。', 'matching lines.');
    const addresses = [...new Set(outcome.entities.flatMap(entity => entity.origins.addresses).map(String))];
    currentSelectedAddr = addresses.length ? BigInt(addresses[0]) : null;
    const records = [...new Set(outcome.entities.flatMap(entity => entity.recordRefs))];
    const kinds = [...new Set(records.map(index => query.value.renderProvenance.ledger[index]?.kind).filter(Boolean))];
    const renderAddresses = offset => {
      details.replaceChildren();
      for (const value of addresses.slice(offset, offset + 64)) {
        details.append(uiButton(label(value), { cls:'ui-secondary-action', onClick:async () => {
          const serial = ++action;
          const opened = await navigation.openAddress(BigInt(value), address => {
            if (serial === action && !options.signal?.aborted && options.isCurrent?.() !== false) options.onNavigate?.(address);
          });
          if (serial === action && opened.state !== 'ready') show(opened);
        } }));
      }
      if (addresses.length > 64) {
        details.append(h('span', 'ui-hint', `${offset + 1}–${Math.min(offset + 64, addresses.length)} / ${addresses.length}`));
        if (offset > 0) details.append(uiButton(text('前の命令', 'Previous addresses'), { onClick:() => { action++; renderAddresses(offset - 64); } }));
        if (offset + 64 < addresses.length) details.append(uiButton(text('次の命令', 'Next addresses'), { onClick:() => { action++; renderAddresses(offset + 64); } }));
      }
      if (kinds.length) details.append(h('span', 'ui-hint', text('変換: ', 'Transforms: ') + kinds.join(', ')));
    };
    renderAddresses(0);
  };
  const select = async operation => {
    const serial = ++action;
    const outcome = await operation();
    if (serial !== action) return;
    show(outcome);
    if (outcome.state === 'ready' && outcome.entities.length) {
      const row = rows[outcome.entities[0].lineIndex];
      row?.scrollIntoView?.({ block:'nearest' });
      row?.focus?.({ preventScroll:true });
    }
  };
  const find = uiButton(text('命令 → 疑似C', 'Instruction → pseudocode'), { cls:'ui-secondary-action', onClick:() => {
    const address = parseAddress(input.value);
    if (address == null || address < 0n) {
      action++;
      show({ state:'unavailable', reason:'invalid-address', entities:EMPTY });
      return;
    }
    return select(() => navigation.selectOrigin('addr', address));
  } });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); find.click(); }
  });
  input.disabled = find.disabled = !navigation.available;
  if (Array.isArray(options.extraToolbarActions)) {
    for (const extra of options.extraToolbarActions) {
      if (extra) controls.append(extra);
    }
  }
  controls.append(input, find);

  let tokenHighlight = null;
  const tokNav = h('span', 'ui-tok-nav');
  tokNav.hidden = true;
  const tokCount = h('span', 'ui-hint mono');
  const tokPrev = uiButton('↑', {
    cls: 'ui-secondary-action',
    ariaLabel: text('前の一致', 'Previous occurrence'),
    onClick: () => tokenHighlight?.prev(),
  });
  const tokNext = uiButton('↓', {
    cls: 'ui-secondary-action',
    ariaLabel: text('次の一致', 'Next occurrence'),
    onClick: () => tokenHighlight?.next(),
  });
  tokNav.append(tokCount, tokPrev, tokNext);
  controls.append(tokNav);

  const lines = query?.value?.lines;
  if (Array.isArray(lines)) {
    const prelude = preludeLength(lines);
    if (prelude > 0) {
      code.classList.add('fold-prelude');
      const toggle = uiButton(text(`型の定義を表示（${prelude} 行）`, `Show type definitions (${prelude} lines)`), { cls:'ui-secondary-action', pressed:false, onClick:() => {
        const shown = !code.classList.contains('show-prelude');
        code.classList.toggle('show-prelude', shown);
        toggle.setAttribute('aria-pressed', String(shown));
        toggle.textContent = shown ? text('型の定義をたたむ', 'Hide type definitions') : text(`型の定義を表示（${prelude} 行）`, `Show type definitions (${prelude} lines)`);
      } });
      controls.append(toggle);
    }
    const fnComment = typeof options.functionComment === 'string' ? options.functionComment.trim() : '';
    const makeCommentRow = () => {
      const commentRow = h('span', 'ui-pseudocode-line is-fn-comment');
      const commentLines = fnComment.split(/\r?\n/).map(part => `// ${part}`).join('\n');
      commentRow.append(h('span', 'tok-cmt', commentLines), h('span', null, '\n'));
      return commentRow;
    };
    let commentInserted = false;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const content = line.kind === 'blank' ? '' : '    '.repeat(Math.max(0, line.indent || 0)) + line.text;
      const rowClasses = ['ui-pseudocode-line'];
      if (index < prelude) rowClasses.push('prelude');
      const isSig = line.kind === 'sig';
      if (isSig) {
        rowClasses.push('is-sig');
        if (fnComment && !commentInserted) {
          code.append(makeCommentRow());
          commentInserted = true;
        }
      }
      if (line.kind === 'decl') {
        rowClasses.push('is-decl');
        if (lines[index + 1]?.kind !== 'decl') rowClasses.push('is-decl-last');
      }
      if (line.kind === 'case' || /^\s*(?:case\b|default\s*:)/.test(String(line.text || ''))) rowClasses.push('is-case');
      const row = h('span', rowClasses.join(' '));
      appendHighlighted(row, content, {
        isSig,
        text,
        resolveCallee: options.resolveCallee || null,
        onOpenCallee: options.onOpenCallee || null,
        onOpenAddress: typeof options.onNavigate === 'function'
          ? (address) => { if (!options.signal?.aborted && options.isCurrent?.() !== false) options.onNavigate(address); }
          : null,
        onBookmarkAddress: typeof options.onBookmarkAddress === 'function'
          ? (address) => { if (!options.signal?.aborted && options.isCurrent?.() !== false) options.onBookmarkAddress(address); }
          : null,
      });
      if (index + 1 < lines.length) row.append(h('span', null, '\n'));
      const entity = query.value.renderProvenance?.entities?.[`L${index}:${line.kind ?? 'null'}`];
      if (navigation.available && entity?.role === 'semantic') {
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', text('行の根拠を見る: ', 'Inspect line origins: ') + content.trim());
        row.addEventListener('click', (event) => {
          if (typeof window !== 'undefined' && window.getSelection?.()?.toString()) return;
          const tokEl = event?.target?.closest?.('[data-tok]');
          if (tokEl && row.contains?.(tokEl) && (tokEl.classList.contains('tok-fn-link') || tokEl.classList.contains('tok-addr-link'))) return;
          select(() => navigation.selectLine(index));
        });
        row.addEventListener('keydown', event => {
          if (event.defaultPrevented) return;
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); return select(() => navigation.selectLine(index)); }
        });
      }
      rows.push(row);
      code.append(row);
    }
    if (fnComment && !commentInserted) {
      code.prepend(makeCommentRow());
    }
    tokenHighlight = attachTokenHighlight(code, {
      onHighlightChange: ({ token, count, index }) => {
        if (!token || !count) {
          tokNav.hidden = true;
          tokCount.textContent = '';
          tokCount.title = '';
          return;
        }
        tokNav.hidden = false;
        tokCount.textContent = `${index + 1}/${count}`;
        tokCount.title = token;
      },
    });
    if (options.signal) {
      if (options.signal.aborted) tokenHighlight.destroy();
      else options.signal.addEventListener?.('abort', () => tokenHighlight?.destroy?.(), { once: true });
    }
  } else {
    const value = query?.value;
    const content = typeof value === 'string' ? value : value?.code;
    code.textContent = typeof content === 'string' ? content : decompiledText(content);
  }
  status.textContent = navigation.available
    ? text('行を選ぶと元の命令を表示します。命令アドレスから逆引きもできます。', 'Select a line to inspect its instructions, or look up an instruction address.')
    : reasonText(navigation.reason) + text('行を選んで元の命令を見る機能は、この関数では使えません。', ' Selecting a line to see its instructions is not available here.') + ` (${navigation.reason})`;
  root.append(controls, code, status, details, history);
  if (options.initialAddr != null && navigation.available) {
    let initAddr = null;
    try { initAddr = typeof options.initialAddr === 'bigint' ? options.initialAddr : BigInt(options.initialAddr); } catch { initAddr = null; }
    if (initAddr != null && initAddr >= 0n) {
      input.value = addrHex(initAddr);
      void select(() => navigation.selectOrigin('addr', initAddr));
    }
  }
  return Object.freeze({ root, code, navigation, tokenHighlight, selectedAddress: () => currentSelectedAddr });
}
