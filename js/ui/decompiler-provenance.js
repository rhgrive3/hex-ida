import { validateRenderProvenance } from '../decompiler/phase8/render-provenance.js';
import { addrHex, parseAddress } from '../format.js';
import { decompiledText } from '../decompile.js';
import { h, uiButton } from './primitives.js';

const EMPTY = Object.freeze([]);

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
  const publish = (refs, recordRefs = []) => {
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
      transforms.push(map.ledger[index]);
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
        const record = map.ledger[index];
        const history = record?.originHistory;
        const matches = history
          ? history.consumedRefs?.includes(key) || history.producedRefs?.includes(key)
          : record?.origin?.[{ addr:'addresses', row:'rows', ir:'ir', ssa:value?.startsWith?.('def:') ? 'ssaDefs' : 'ssaUses' }[kind]]
            ?.some(origin => String(origin) === (kind === 'ssa' ? String(value).replace(/^(def|use):/, '') : String(value)));
        if (!matches) return unavailable('inconsistent-transform-reverse-map');
      }
      return publish(refs, recordRefs);
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
  const details = h('div', 'ui-code-toolbar');
  const history = h('div', 'ui-provenance-history');
  const controls = h('div', 'ui-code-toolbar');
  const input = h('input', 'mono');
  input.type = 'text';
  input.placeholder = '0x…';
  input.setAttribute('aria-label', text('対応する命令アドレス', 'Instruction address'));
  const rows = [];
  let action = 0;
  const label = value => addrHex(BigInt(value));
  const show = outcome => {
    details.replaceChildren();
    history.replaceChildren();
    const active = new Set(outcome.entities.map(entity => entity.lineIndex));
    for (let index = 0; index < rows.length; index++) {
      rows[index].classList.toggle('selected', active.has(index));
      rows[index].setAttribute('aria-current', active.has(index) ? 'true' : 'false');
    }
    if (outcome.state !== 'ready') {
      status.textContent = text('対応表を利用できません。再解析してください。', 'Mapping unavailable. Refresh the analysis.') + ` (${outcome.reason})`;
      return;
    }
    const recordsWithHistory = (outcome.transforms ?? EMPTY).filter(record => record.originHistory);
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
        const origins = record.originHistory;
        item.append(h('pre', 'mono',
          text('変換前: ', 'Consumed: ') + origins.consumedRefs.join(', ') + '\n'
          + text('変換後: ', 'Produced: ') + origins.producedRefs.join(', ') + '\n'
          + text('式の出典から除去: ', 'Elided expression origins: ') + origins.elidedRefs.join(', ') + '\n'
          + text('表示行への対応は未確定です。IRの削除を意味しません。',
            'Rendered binding is unresolved. This does not mean canonical IR was deleted.')));
        history.append(item);
      }
      if (offset > 0) history.append(uiButton(text('前の履歴', 'Previous history'), { onClick:() => changeHistoryPage(offset - 16) }));
      if (offset + 16 < recordsWithHistory.length) history.append(uiButton(text('次の履歴', 'Next history'), { onClick:() => changeHistoryPage(offset + 16) }));
    };
    showHistory(0);
    if (!outcome.entities.length) {
      status.textContent = recordsWithHistory.length
        ? text('変換履歴がありますが、表示行への対応は未確定です。', 'Transform history exists, but its rendered binding is unresolved.')
        : text('この命令に対応する表示行はありません。', 'No rendered line maps to this instruction.');
      return;
    }
    status.textContent = `${outcome.entities.length} ` + text('行が対応しています。', 'matching lines.');
    const addresses = [...new Set(outcome.entities.flatMap(entity => entity.origins.addresses).map(String))];
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
  controls.append(input, find);

  const lines = query?.value?.lines;
  if (Array.isArray(lines)) {
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const content = line.kind === 'blank' ? '' : '    '.repeat(Math.max(0, line.indent || 0)) + line.text;
      const row = h('span', 'ui-pseudocode-line', content + (index + 1 < lines.length ? '\n' : ''));
      const entity = query.value.renderProvenance?.entities?.[`L${index}:${line.kind ?? 'null'}`];
      if (navigation.available && entity?.role === 'semantic') {
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', text('行の根拠を見る: ', 'Inspect line origins: ') + content.trim());
        row.addEventListener('click', () => select(() => navigation.selectLine(index)));
        row.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); return select(() => navigation.selectLine(index)); }
        });
      }
      rows.push(row);
      code.append(row);
    }
  } else {
    const value = query?.value;
    const content = typeof value === 'string' ? value : value?.code;
    code.textContent = typeof content === 'string' ? content : decompiledText(content);
  }
  status.textContent = navigation.available
    ? text('行を選ぶと元の命令を表示します。命令アドレスから逆引きもできます。', 'Select a line to inspect its instructions, or look up an instruction address.')
    : text('この結果には利用できる対応表がありません。', 'No usable provenance map is available for this result.') + ` (${navigation.reason})`;
  root.append(controls, code, status, details, history);
  return Object.freeze({ root, code, navigation });
}
