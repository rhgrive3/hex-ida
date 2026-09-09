/* Conservative switch/jump-table structuring. Verified descriptors only. */
import { mergeSource, sourceOf } from './ast/nodes.js';
import { expressionOriginHistory } from './rewrite/engine.js';
import { captureProjectionIrData, PROJECTION_LIMITS } from './phase8/projection-origin.js';

const switchLines = new WeakMap(), switchHistories = new WeakMap();
const cap = (value, maximum) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : maximum;

export function readSwitchLineHistory(line, ir) {
  const entry = switchLines.get(line);
  return entry && entry.ir === ir && entry.isCurrent() ? entry : null;
}

export function readSwitchRenderHistory(result) {
  const entry = switchHistories.get(result);
  return entry && entry.ir === result.ir && entry.disposition === result.switchRenderHistory ? entry : null;
}

// The existing compatibility spelling transition lives here so it can carry
// an actual switch producer through exactly this normalization, never through
// arbitrary line edits or a public binding-registration function.
export function normalizeCompatibilityLine(line, ir) {
  if (!line || typeof line.text !== 'string') return;
  const text = line.text.replace(/\blocal_([0-9a-f]+)\b/gi, (_m, h) => 'var_' + h.toUpperCase())
    .replace(/\bvar_([0-9a-f]+)\b/gi, (_m, h) => 'var_' + h.toUpperCase());
  if (text === line.text) return;
  const entry = readSwitchLineHistory(line, ir);
  line.text = text;
  if (!entry) return;
  try {
    const observation = captureProjectionIrData([line]);
    switchLines.set(line, Object.freeze({ ...entry,
      isCurrent:() => entry.canonical.matches() && observation.matches(),
    }));
  } catch { /* The old observation stays invalid; never infer continuity. */ }
}

function instructionSource(instruction) {
  return sourceOf({ address:instruction?.address, row:instruction?.row, ir:instruction?.id,
    ssaDef:instruction?.dst?.id, ssaUses:(instruction?.args || []).map(arg => arg?.value?.id).filter(id => id != null) });
}

function captureSwitchInputs(ir, extra, shouldAbort) {
  // Rendering reads instructions and block locations, not the dominator sets
  // or compatibility helper methods on the IR envelope.
  const keys = ['instructions', 'blocks'], prototype = Object.getPrototypeOf(ir);
  const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(ir, key));
  if (descriptors.some(d => d && (!Object.hasOwn(d, 'value') || !d.enumerable))) throw new Error('switch-data-roots-required');
  const observation = captureProjectionIrData([...descriptors.map(d => d?.value), ...extra], shouldAbort);
  return Object.freeze({ metrics:observation.metrics, matches() {
    return Object.getPrototypeOf(ir) === prototype && keys.every((key, index) => {
      const now = Object.getOwnPropertyDescriptor(ir, key), prior = descriptors[index];
      return prior ? !!now && Object.hasOwn(now, 'value') && now.enumerable && Object.is(now.value, prior.value) : now === undefined;
    }) && observation.matches();
  } });
}

function retainSwitchHistory(result, model, sw, repl, removed, oldIndex, opts, history, index) {
  if (!history.sourceIndex) {
    const rows = new Map(), addresses = new Map();
    for (const inst of result.ir?.instructions || []) {
      if (!rows.has(inst.row)) rows.set(inst.row, []);
      rows.get(inst.row).push(inst);
      if (!addresses.has(inst.address)) addresses.set(inst.address, []);
      addresses.get(inst.address).push(inst);
    }
    history.sourceIndex = { rows, addresses };
  }
  const branch = history.sourceIndex.rows.get(sw.row) || [];
  const rawBranch = (model?.instructions || []).filter(inst => inst.row === sw.row);
  const branchSource = mergeSource(...branch.map(instructionSource),
    ...rawBranch.map(inst => sourceOf({ address:inst.address, row:inst.row })),
    ...removed.map(line => line.source || { address:line.addr, row:line.row }));
  let canonical;
  try {
    if (history.consumers > 0 && history.edges > 0) {
      canonical = captureSwitchInputs(result.ir, [sw, model?.instructions, removed], opts.shouldAbort);
      history.edges -= canonical.metrics.edges;
    }
  }
  catch { history.reasons.add('switch-observation-unavailable'); }
  for (const [position, line] of repl.entries()) {
    if (history.records.length >= history.maximum) { history.reasons.add('switch-history-budget'); break; }
    const targets = line.addr == null ? [] : history.sourceIndex.addresses.get(line.addr) || [];
    const after = mergeSource(branchSource, ...targets.map(instructionSource),
      line.addr == null ? null : { address:line.addr, row:index.rows.get(line.addr.toString()) });
    const record = Object.freeze({ rule:'render-switch', phase:'render', before:`switch-row:${sw.row}`, after:line.text,
      evidence:Object.freeze({ kind:'accepted-switch-descriptor-projection', detail:'existing switch renderer output; not independent control-flow or selector-value proof' }),
      originHistory:expressionOriginHistory({ source:branchSource }, { source:after }),
      ...(position === 0 && removed.length === 1 ? { renderedRemoval:Object.freeze({
        scope:'pre-transform-render', operation:'remove', lineIndex:oldIndex, kind:removed[0].kind || 'raw',
      }) } : {}),
    });
    history.records.push(record);
    if (!canonical || history.consumers <= 0 || history.edges <= 0) {
      history.reasons.add('switch-binding-unavailable'); continue;
    }
    history.consumers--;
    try {
      const observation = captureProjectionIrData([line, targets, record], opts.shouldAbort);
      history.edges -= observation.metrics.edges;
      if (history.edges < 0) { history.reasons.add('switch-binding-budget'); continue; }
      switchLines.set(line, Object.freeze({ ir:result.ir, records:Object.freeze([record]), canonical,
        isCurrent:() => canonical.matches() && observation.matches(),
      }));
    } catch { history.edges = 0; history.reasons.add('switch-observation-unavailable'); }
  }
}

// Block identity in a verified switch descriptor is a primitive safe integer.
// ToNumber coercion (Number([0]) === 0, Number(true) === 1) must never mint a
// verified jump target from a schema-invalid structured value (#5926).
function blockIndexOf(block) {
  if (typeof block !== 'number' || !Number.isSafeInteger(block) || block < 0) return -1;
  return block;
}

function hex(v) { return BigInt(v).toString(16).toUpperCase(); }
function labelForAddress(addr) { return `loc_${hex(addr)}`; }
function textOf(lines) { return (lines || []).map((l) => `${'    '.repeat(Math.max(0, l.indent || 0))}${l.text || ''}`).join('\n'); }

function addressForBlock(result, opts, block, index) {
  const blockIndex = blockIndexOf(block);
  if (blockIndex < 0) return null;
  const b = result?.ir?.blocks?.[blockIndex];
  if (!b) return null;
  return index.addressByRow.get(b.startRow) ?? opts.addrOfRow?.(b.startRow) ?? null;
}

function normalizedCase(c, result, opts, index) {
  if (!c || c.value == null) return null;
  let address = c.address ?? c.target ?? null;
  if (address == null && c.block != null && blockIndexOf(c.block) >= 0) address = addressForBlock(result, opts, c.block, index);
  if (address == null) return null;
  try { address = BigInt(address); } catch { return null; }
  return { value: c.value, address, label: labelForAddress(address) };
}

function insertionIndex(lines, row) {
  let i = lines.findIndex((l) => l?.row === row && /__asm\(["']br\s/i.test(l.text || ''));
  if (i >= 0) return { start: i, end: i + 1, indent: lines[i].indent || 1 };
  let last = -1;
  for (let n = 0; n < lines.length; n++) {
    const r = lines[n]?.row;
    if (r != null && r <= row) last = n;
  }
  if (last < 0) return null;
  const next = lines[last + 1];
  const indent = next?.kind === 'label' ? (next.indent || 1) + 1 : (lines[last].indent || 1);
  return { start: last + 1, end: last + 1, indent };
}

function caseLiteral(v) {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
  if (typeof v === 'string' && /^-?(?:0x[0-9a-f]+|\d+)$/i.test(v.trim())) return v.trim();
  return null;
}

function caseIdentity(literal, sw = {}, c = {}) {
  let raw;
  try { raw = BigInt(literal); } catch { return null; }
  const requestedBits = c.bits ?? c.width ?? sw.bits ?? sw.width ?? sw.valueBits ?? null;
  const numericBits = Number(requestedBits);
  const bits = Number.isInteger(numericBits) && numericBits > 0 && numericBits <= 128 ? numericBits : null;
  const canonical = bits ? BigInt.asUintN(bits, raw) : raw;
  return `n:${bits || 'integer'}:${canonical.toString()}`;
}

function targetIndex(result, model) {
  const labels = new Set();
  for (const l of result.lines || []) {
    const m = String(l?.text || '').match(/^\s*(loc_[0-9A-Fa-f]+):\s*$/);
    if (m) labels.add(m[1].toUpperCase());
  }
  const rows = new Map();
  const addressByRow = new Map();
  for (const i of model?.instructions || []) {
    if (i?.address == null || i?.row == null) continue;
    try {
      const address = BigInt(i.address);
      rows.set(address.toString(), i.row);
      if (!addressByRow.has(i.row)) addressByRow.set(i.row, address);
    } catch { /* malformed instruction address */ }
  }
  return { labels, rows, addressByRow };
}

function materializeVerifiedLabels(result, index, addresses) {
  const missing = [];
  const pendingLabels = new Set();
  for (const addressValue of addresses) {
    const address = BigInt(addressValue);
    const label = labelForAddress(address);
    const key = label.toUpperCase();
    if (index.labels.has(key) || pendingLabels.has(key)) continue;
    const row = index.rows.get(address.toString());
    if (row == null) return false;
    missing.push({ address, label, row });
    pendingLabels.add(key);
  }
  if (!missing.length) return true;
  const targets = [...missing].sort((a, b) => a.row - b.row);
  const placements = [];
  let ti = 0;
  for (let li = 0; li < result.lines.length && ti < targets.length; li++) {
    const row = result.lines[li]?.row;
    if (row == null) continue;
    while (ti < targets.length && targets[ti].row <= row) placements.push({ ...targets[ti++], at: li });
  }
  const closing = result.lines.findIndex((l) => l?.kind === 'ctrl' && l.text === '}');
  if (closing < 0) return false;
  while (ti < targets.length) placements.push({ ...targets[ti++], at: closing });
  placements.sort((a, b) => b.at - a.at || b.row - a.row);
  for (const item of placements) {
    const nearby = result.lines[item.at];
    const indent = nearby?.kind === 'label' ? (nearby.indent || 1) : Math.max(1, nearby?.indent || 1);
    result.lines.splice(item.at, 0, { kind: 'label', indent, text: `${item.label}:`, row: item.row, addr: item.address, note: null });
    index.labels.add(item.label.toUpperCase());
  }
  return true;
}

export function structureKnownSwitches(result, model, opts = {}) {
  if (!result || !Array.isArray(result.lines)) return result;
  const descriptors = opts.switches || opts.jumpTables || model?.switches || model?.jumpTables || [];
  if (!Array.isArray(descriptors) || !descriptors.length) return result;
  const history = { records:[], reasons:new Set(), maximum:cap(opts.renderProvenanceBudget?.maxTransformRecords, 1024),
    consumers:cap(opts.renderProvenanceBindingBudget?.maxConsumers, 4096), edges:cap(opts.renderProvenanceBindingBudget?.maxEdges, PROJECTION_LIMITS.edges) };
  const previous = readSwitchRenderHistory(result);
  if (previous) {
    history.records.push(...previous.records.slice(0, history.maximum));
    for (const reason of previous.reasons) history.reasons.add(reason);
    if (previous.records.length > history.maximum) history.reasons.add('switch-history-budget');
  } else if (result.switchRenderHistory) history.reasons.add('switch-history-unavailable');
  const index = targetIndex(result, model);
  for (const sw of descriptors) {
    if (!sw || sw.row == null || !Array.isArray(sw.cases) || sw.cases.length < 2) continue;
    const cases = sw.cases.map((c) => normalizedCase(c, result, opts, index));
    if (cases.some((c) => !c)) continue;
    const values = cases.map((c) => caseLiteral(c.value));
    const identities = values.map((v, i) => caseIdentity(v, sw, sw.cases[i] || {}));
    if (values.some((v) => v == null) || identities.some((v) => v == null)) continue;
    const seenIdentities = new Map();
    let duplicateIdentity = null;
    for (let i = 0; i < identities.length; i++) {
      const identity = identities[i];
      if (seenIdentities.has(identity)) {
        duplicateIdentity = { first: seenIdentities.get(identity), second: i, identity };
        break;
      }
      seenIdentities.set(identity, i);
    }
    if (duplicateIdentity) {
      result.warnings = [...(result.warnings || []), `Switch at row ${sw.row} descriptor conflict: duplicate case values after integer canonicalization (${duplicateIdentity.identity}).`];
      result.evidence = [...(result.evidence || []), {
        row: sw.row,
        address: sw.address ?? null,
        op: 'switch-conflict',
        reason: 'duplicate case values after width-aware integer canonicalization',
        cases: cases.map((c, i) => ({ value: values[i], target: c.address })),
      }];
      continue;
    }
    const hasExplicitDefault = sw.defaultAddress != null || sw.defaultTarget != null || sw.defaultBlock != null;
    let defaultAddress = sw.defaultAddress ?? sw.defaultTarget ?? null;
    if (defaultAddress == null && sw.defaultBlock != null && blockIndexOf(sw.defaultBlock) >= 0) defaultAddress = addressForBlock(result, opts, sw.defaultBlock, index);
    let invalidDefault = hasExplicitDefault && defaultAddress == null;
    try { if (defaultAddress != null) defaultAddress = BigInt(defaultAddress); } catch { invalidDefault = true; }
    if (invalidDefault) {
      result.warnings = [...(result.warnings || []), `Switch at row ${sw.row} was not structured because its explicit default target is invalid or unresolved.`];
      result.evidence = [...(result.evidence || []), {
        row: sw.row,
        address: sw.address ?? null,
        op: 'switch-conflict',
        reason: 'invalid or unresolved explicit default target',
      }];
      continue;
    }
    const allTargets = cases.map((c) => c.address);
    if (defaultAddress != null) allTargets.push(defaultAddress);
    if (!materializeVerifiedLabels(result, index, allTargets)) {
      result.warnings = [...(result.warnings || []), `Switch at row ${sw.row} was not structured because one or more case targets are not exact instruction addresses.`];
      continue;
    }
    const at = insertionIndex(result.lines, sw.row);
    if (!at) continue;
    const expr = String(sw.expr || sw.reg || 'switch_value');
    const repl = [{ kind: 'ctrl', indent: at.indent, text: `switch (${expr}) {`, row: sw.row, addr: null, note: null }];
    for (let i = 0; i < cases.length; i++) repl.push({ kind: 'ctrl', indent: at.indent + 1, text: `case ${values[i]}: goto ${cases[i].label};`, row: sw.row, addr: cases[i].address, note: null });
    if (defaultAddress != null) repl.push({ kind: 'ctrl', indent: at.indent + 1, text: `default: goto ${labelForAddress(defaultAddress)};`, row: sw.row, addr: defaultAddress, note: null });
    repl.push({ kind: 'ctrl', indent: at.indent, text: '}', row: sw.row, addr: null, note: null });
    const removed = result.lines.splice(at.start, at.end - at.start, ...repl);
    try { retainSwitchHistory(result, model, sw, repl, removed, at.start, opts, history, index); }
    catch { history.reasons.add('switch-history-unavailable'); }
    result.evidence = [...(result.evidence || []), { row: sw.row, address: sw.address ?? null, op: 'switch', reason: 'verified jump-table/switch descriptor', cases: cases.map((c, i) => ({ value: values[i], target: c.address })) }];
    result.pseudocode = textOf(result.lines);
    result.ctx = { ...(result.ctx || {}), structuredSwitches: (result.ctx?.structuredSwitches || 0) + 1 };
  }
  if (history.records.length || history.reasons.size) {
    result.switchRenderHistory = Object.freeze({ scope:'switch-render-producer',
      completeness:history.reasons.size ? 'incomplete' : 'complete', reasons:Object.freeze([...history.reasons]) });
    switchHistories.set(result, Object.freeze({ ir:result.ir, disposition:result.switchRenderHistory,
      records:Object.freeze(history.records), reasons:result.switchRenderHistory.reasons }));
  }
  return result;
}
