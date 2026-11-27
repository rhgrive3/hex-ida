/*
 * Workbench state -> assistant context.
 *
 * The AI never reads the app object. Everything it is allowed to know about
 * the current screen passes through this one adapter, which keeps the
 * assistant honest (nothing here is an analysis result) and keeps the app
 * free to change shape without touching prompts or renderers.
 */
import { addrHex } from '../../format.js';
import { currentFunctionAddr, prettyName } from '../../tools.js';

const MAX_PATCH_SUMMARIES = 8;

function safe(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

function formatPatchAddress(item) {
  const addr = item?.addr ?? item?.address ?? null;
  if (addr != null) {
    const formatted = safe(() => addrHex(addr));
    if (formatted) return formatted;
  }
  if (item?.offset != null) {
    const hex = safe(() => BigInt(item.offset).toString(16));
    if (hex != null) return '+0x' + hex;
  }
  return null;
}

/** Concise summary of staged patches read from app.patches (without importing patch.js). */
export function stagedPatchesOf(app) {
  const patches = app?.patches;
  if (!patches) return [];
  const items = safe(() => (typeof patches.list === 'function' ? patches.list() : Array.isArray(patches) ? patches : null));
  if (!Array.isArray(items) || !items.length) return [];
  return items.slice(0, MAX_PATCH_SUMMARIES).map((item) => {
    const address = formatPatchAddress(item);
    const bytes = item?.after?.length ?? item?.before?.length ?? item?.length ?? null;
    const byteLength = Number.isFinite(bytes) ? Number(bytes) : null;
    const label = typeof item?.label === 'string' && item.label.trim()
      ? item.label.trim()
      : (typeof item?.text === 'string' && item.text.trim()
        ? item.text.trim()
        : (typeof item?.reason === 'string' && item.reason.trim() ? item.reason.trim() : null));
    return { address, byteLength, label };
  }).filter((entry) => entry.address || entry.byteLength != null || entry.label);
}

export function functionNameOf(app, addr) {
  if (addr == null) return null;
  const raw = safe(() => app.symbols && (app.symbols.nameAt?.(addr) || app.symbols.label?.(addr)));
  if (raw) return prettyName(raw);
  const hex = safe(() => BigInt(addr).toString(16).toUpperCase());
  return hex != null ? 'sub_' + hex : null;
}

/** The instruction or range the user currently has selected, if any. */
export function selectionOf(app) {
  const viewer = app.viewer;
  if (!viewer) return null;
  if (viewer.rangeMode) {
    const range = safe(() => viewer.selectionRange());
    if (range) {
      return {
        kind: 'range',
        address: safe(() => addrHex(viewer.rowAddress(range.start))) || null,
        addressValue: safe(() => viewer.rowAddress(range.start)),
        text: range.count + ' rows',
        rows: range.count,
      };
    }
  }
  const row = viewer.selectedRow;
  if (row == null || row < 0) return null;
  const data = safe(() => viewer.rowData(row)) || {};
  if (data.address == null) return null;
  return {
    kind: 'instruction',
    address: safe(() => addrHex(data.address)) || null,
    addressValue: data.address,
    row,
    text: [data.mnemonic, data.operands].filter(Boolean).join(' ').trim(),
  };
}

export function currentFunctionOf(app) {
  const addr = safe(() => currentFunctionAddr(app));
  if (addr == null) return null;
  const owner = safe(() => app.ownerOf?.(addr));
  const callers = safe(() => (app.program ? app.program.callCountOf(addr) : null));
  const instructions = safe(() => (app.semantic && app.semantic.model && app.semantic.result
    && app.semantic.result.startAddr === addr ? app.semantic.model.instructions.length : null));
  return {
    address: safe(() => addrHex(addr)),
    addressValue: addr,
    name: functionNameOf(app, addr),
    owner: owner && owner.className ? owner.className + (owner.sel ? ' · ' + owner.sel : '') : null,
    callers: Number.isFinite(callers) ? callers : null,
    instructions: Number.isFinite(instructions) ? instructions : null,
  };
}

/**
 * Everything the assistant is allowed to know about the current screen.
 * `state` is for scope resolution; the rest is rendered into the prompt.
 */
export function workbenchContext(app) {
  const info = app.store.get('fileInfo');
  const region = app.store.get('currentRegion');
  const fn = info ? currentFunctionOf(app) : null;
  const selection = info ? selectionOf(app) : null;
  const patches = stagedPatchesOf(app);
  const totalPatches = safe(() => (typeof app?.patches?.size === 'number' ? app.patches.size : patches.length), patches.length);
  const notes = [];
  if (region) notes.push('open region: ' + (region.section || region.name));
  if (app.lastGoal && app.lastGoal.text) notes.push('last investigation: ' + app.lastGoal.text);
  if (app.notes && safe(() => app.notes.commentCount())) notes.push('user comments: ' + app.notes.commentCount());
  if (patches.length) {
    const summary = patches.map((patch) => {
      const parts = [];
      if (patch.address) parts.push(patch.address);
      if (patch.byteLength != null) parts.push(`${patch.byteLength}B`);
      if (patch.label) parts.push(patch.label);
      return parts.join(' ');
    }).join(', ');
    const suffix = totalPatches > patches.length ? ` (+${totalPatches - patches.length} more)` : '';
    notes.push(`staged patches (${totalPatches}): ${summary}${suffix}`);
  }

  return {
    binary: info ? {
      name: info.name,
      format: info.format,
      architecture: app.store.get('architecture') || null,
    } : null,
    function: fn,
    selection,
    patches,
    notes,
    state: {
      fileOpen: !!info,
      functionAddress: fn ? fn.addressValue : null,
      selection: selection ? selection.kind : null,
    },
  };
}

export default workbenchContext;
