/* Conservative switch/jump-table structuring. Verified descriptors only. */
import { mergeSource, sourceOf } from './ast/nodes.js';
import { expressionOriginHistory } from './rewrite/engine.js';
import { captureProjectionIrData, PROJECTION_LIMITS } from './phase8/projection-origin.js';
import { normalizeSemanticCompatibilityLine } from './semantic-core.js';

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
  const previousText = line.text;
  const entry = readSwitchLineHistory(line, ir);
  normalizeSemanticCompatibilityLine(line, ir);
  if (previousText === line.text) return;
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

function parseCaseInteger(text) {
  const s = String(text).trim();
  const negative = s.startsWith('-');
  const magnitude = negative ? s.slice(1) : s;
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(magnitude)) return null;
  const raw = BigInt(magnitude);
  return negative ? -raw : raw;
}

function caseLiteral(v) {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
  if (typeof v === 'string' && parseCaseInteger(v) != null) return v.trim();
  return null;
}

function caseIdentity(literal, sw = {}, c = {}) {
  const raw = parseCaseInteger(literal);
  if (raw == null) return null;
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


function terminalSwitchCasePlan(result, cases, defaultAddress, at) {
  // A verified descriptor proves selector -> target mapping, but it does not by
  // itself prove that an arbitrary target region can be moved into the switch.
  // Only adopt already-rendered, terminal case bodies when every target has a
  // unique label, no pre-existing textual goto entry, and the body is a closed
  // label-delimited region ending in an explicit return.  Anything less stays
  // in the existing label/goto form.
  if (defaultAddress == null || !Array.isArray(result?.lines)) return null;
  const targets = [...cases.map(c => c.address), defaultAddress];
  const keys = targets.map(address => labelForAddress(address).toUpperCase());
  if (new Set(keys).size !== keys.length) return null;

  const labelAt = new Map();
  for (let i = 0; i < result.lines.length; i++) {
    const m = String(result.lines[i]?.text || '').match(/^\s*(loc_[0-9A-Fa-f]+):\s*$/);
    if (!m) continue;
    const key = m[1].toUpperCase();
    if (labelAt.has(key)) return null;
    labelAt.set(key, i);
  }
  if (keys.some(key => !labelAt.has(key))) return null;

  // A textual predecessor is enough to disqualify relocation.  This is
  // deliberately conservative: descriptor-owned dispatch is the only entry we
  // are willing to replace in this pass.
  for (const key of keys) {
    const needle = `GOTO ${key};`;
    if (result.lines.some(line => String(line?.text || '').toUpperCase().includes(needle))) return null;
  }

  const ranges = [];
  for (const key of keys) {
    const start = labelAt.get(key);
    if (start <= at.start) return null;
    let end = start + 1;
    while (end < result.lines.length) {
      const line = result.lines[end];
      if (line?.kind === 'label') break;
      if (line?.kind === 'ctrl' && String(line.text || '').trim() === '}' && (line.indent || 0) <= (result.lines[start]?.indent || 0)) break;
      end++;
    }
    const body = result.lines.slice(start + 1, end);
    if (!body.length) return null;
    const texts = body.map(line => String(line?.text || '').trim()).filter(Boolean);
    if (!texts.length || !/^return(?:\s+[^;]+)?;$/.test(texts.at(-1))) return null;
    if (texts.some(text => /\b(?:goto|break|continue)\b/.test(text) || /^(?:case\b|default\s*:|switch\s*\()/.test(text))) return null;
    ranges.push({ key, start, end, body });
  }

  const ordered = [...ranges].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) if (ordered[i].start < ordered[i - 1].end) return null;
  return { byKey:new Map(ranges.map(range => [range.key, range])), ranges };
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
    const linesBeforeMaterialization = result.lines.slice();
    const labelsBeforeMaterialization = new Set(index.labels);
    if (!materializeVerifiedLabels(result, index, allTargets)) {
      result.warnings = [...(result.warnings || []), `Switch at row ${sw.row} was not structured because one or more case targets are not exact instruction addresses.`];
      continue;
    }
    const at = insertionIndex(result.lines, sw.row);
    if (!at) {
      // Restore the exact pre-materialization state. Filtering by target text
      // can erase a legitimate label that existed before this switch (#5535).
      result.lines = linesBeforeMaterialization;
      index.labels = labelsBeforeMaterialization;
      continue;
    }
    const expr = String(sw.expr || sw.reg || 'switch_value');
    const terminal = terminalSwitchCasePlan(result, cases, defaultAddress, at);
    if (terminal) {
      // Remove the original label-delimited bodies from the bottom up.  Reuse
      // the exact body line objects in the switch so existing statement/control
      // provenance remains attached; indentation is cosmetic and is therefore
      // intentionally left untouched.
      for (const range of [...terminal.ranges].sort((a, b) => b.start - a.start)) {
        result.lines.splice(range.start, range.end - range.start);
      }
    }
    const generated = [{ kind: 'ctrl', indent: at.indent, text: `switch (${expr}) {`, row: sw.row, addr: null, note: null }];
    const repl = [generated[0]];
    for (let i = 0; i < cases.length; i++) {
      const key = cases[i].label.toUpperCase();
      const caseLine = { kind: 'ctrl', indent: at.indent + 1,
        text: terminal ? `case ${values[i]}:` : `case ${values[i]}: goto ${cases[i].label};`,
        row: sw.row, addr: cases[i].address, note: null };
      generated.push(caseLine); repl.push(caseLine);
      if (terminal) {
        const body = terminal.byKey.get(key).body;
        for (const line of body) line.indent = Math.max(line.indent || 0, at.indent + 2);
        repl.push(...body);
      }
    }
    if (defaultAddress != null) {
      const label = labelForAddress(defaultAddress), key = label.toUpperCase();
      const defaultLine = { kind: 'ctrl', indent: at.indent + 1,
        text: terminal ? 'default:' : `default: goto ${label};`,
        row: sw.row, addr: defaultAddress, note: null };
      generated.push(defaultLine); repl.push(defaultLine);
      if (terminal) {
        const body = terminal.byKey.get(key).body;
        for (const line of body) line.indent = Math.max(line.indent || 0, at.indent + 2);
        repl.push(...body);
      }
    }
    const close = { kind: 'ctrl', indent: at.indent, text: '}', row: sw.row, addr: null, note: null };
    generated.push(close); repl.push(close);
    const removed = result.lines.splice(at.start, at.end - at.start, ...repl);
    try { retainSwitchHistory(result, model, sw, generated, removed, at.start, opts, history, index); }
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
