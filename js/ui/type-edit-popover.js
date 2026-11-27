/*
 * Track 10 (§9): Contextual Y-key / click Type-Edit Popover.
 *
 * Pure ESM, zero external runtime dependencies, strictly XSS-safe DOM
 * construction (`textContent` only, never `innerHTML`).
 * Testable in Node without a real browser via injected `document` or pure
 * controller API.
 */

export const DEFAULT_UNDO_LIMIT = 50;
export const MAX_SLOT_VALUE_LEN = 80;
export const DEFAULT_DEBOUNCE_MS = 80;

export const TARGET_KINDS = Object.freeze([
  'function',
  'local',
  'param',
  'field',
  'global',
  'struct',
]);

const VALID_TARGET_KIND_SET = new Set(TARGET_KINDS);

const C_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNSAFE_HTML_RE = /[<>]/;
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const KNOWN_CALLING_CONVENTIONS = new Set([
  '__cdecl',
  '__stdcall',
  '__fastcall',
  '__thiscall',
  '__vectorcall',
  '__usercall',
  '__userpurge',
  '__aapcs64',
  '__swiftcc',
]);

const VALID_ARM64_REG_RE = /^(?:[xw](?:[0-9]|[12][0-9]|30)|[vqdshb](?:[0-9]|[12][0-9]|3[01]))$/i;
const VALID_X64_REG_RE = /^(?:r(?:ax|bx|cx|dx|si|di|bp|8|9|1[0-5])|e(?:ax|bx|cx|dx|si|di|bp)|xmm(?:[0-9]|1[0-5]))$/i;
const VALID_STACK_LOC_RE = /^(?:0x[0-9a-f]+|\d+)\[(?:sp|rsp|esp)\]$/i;

function normalizeSpaces(str) {
  return String(str ?? '').trim().replace(/\s+/g, ' ');
}

function checkBalancedDelimiters(str) {
  const stack = [];
  const pairs = { ')': '(', ']': '[' };
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === '(' || ch === '[') {
      stack.push(ch);
    } else if (ch === ')' || ch === ']') {
      if (stack.length === 0 || stack[stack.length - 1] !== pairs[ch]) {
        return false;
      }
      stack.pop();
    }
  }
  return stack.length === 0;
}

function validateUsercallLocation(locRaw) {
  const loc = String(locRaw ?? '').trim();
  if (!loc) return { ok: false, error: 'Empty @<...> register/stack location' };
  if (/^(?:sp|rsp|esp|xzr|wzr)$/i.test(loc)) {
    return { ok: false, error: `Forbidden register location: ${loc}` };
  }
  if (VALID_STACK_LOC_RE.test(loc)) return { ok: true, kind: 'stack', loc };
  // Pair syntax: x0:x1 or rdx:rax
  if (loc.includes(':')) {
    const parts = loc.split(':').map((p) => p.trim());
    if (parts.length !== 2) return { ok: false, error: `Invalid register pair: ${loc}` };
    const [hi, lo] = parts;
    if (hi.toLowerCase() === lo.toLowerCase()) {
      return { ok: false, error: `Duplicate register in pair: ${loc}` };
    }
    const okHi = VALID_ARM64_REG_RE.test(hi) || VALID_X64_REG_RE.test(hi);
    const okLo = VALID_ARM64_REG_RE.test(lo) || VALID_X64_REG_RE.test(lo);
    if (!okHi || !okLo) return { ok: false, error: `Unknown register in pair: ${loc}` };
    return { ok: true, kind: 'pair', loc };
  }
  if (VALID_ARM64_REG_RE.test(loc) || VALID_X64_REG_RE.test(loc)) {
    return { ok: true, kind: 'reg', loc };
  }
  return { ok: false, error: `Invalid ABI location: ${loc}` };
}

function splitTopLevelCommas(str) {
  const parts = [];
  let depth = 0;
  let angle = 0;
  let cur = '';
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === '<' && str[i - 1] === '@') angle += 1;
    else if (ch === '>' && angle > 0) angle -= 1;
    if (ch === ',' && depth === 0 && angle === 0) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() || parts.length > 0) parts.push(cur.trim());
  return parts;
}

function stripShiftedAnnotation(typeStr) {
  const shiftedRe = /\b__shifted\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([-+]?(?:0x[0-9a-fA-F]+|\d+))\s*\)/g;
  const matches = [];
  const cleaned = typeStr.replace(shiftedRe, (_m, parentType, delta) => {
    matches.push({ parentType, delta: Number.parseInt(delta, 0) });
    return '';
  });
  return { cleaned: normalizeSpaces(cleaned), shifted: matches };
}

function validateSimpleTypeExpr(rawType) {
  const errors = [];
  const { cleaned, shifted } = stripShiftedAnnotation(rawType);
  if (rawType.includes('__shifted') && shifted.length === 0) {
    errors.push('Malformed __shifted(Type, delta) annotation');
  }
  if (!cleaned) {
    errors.push('Empty type expression');
    return { valid: false, errors, normalized: '', shifted };
  }
  if (UNSAFE_HTML_RE.test(cleaned)) {
    errors.push('Invalid characters (< or >) in C type');
  }
  if (/[;{}?`$\\]/.test(cleaned)) {
    errors.push('Disallowed punctuation in C type expression');
  }
  if (!checkBalancedDelimiters(cleaned)) {
    errors.push('Unbalanced parentheses or brackets');
  }
  // Check array dimensions if present
  const arrayMatches = [...cleaned.matchAll(/\[([^\]]*)\]/g)];
  for (const m of arrayMatches) {
    const dim = m[1].trim();
    if (dim !== '' && !/^(?:0x[0-9a-fA-F]+|\d+)$/.test(dim)) {
      errors.push(`Invalid array bound: [${dim}]`);
    }
  }
  // Must contain at least one identifier token
  const stripped = cleaned.replace(/[*[\]()\s,]/g, '');
  if (!stripped || !/[A-Za-z_]/.test(stripped)) {
    errors.push('Type expression must contain a valid C type name');
  }
  return {
    valid: errors.length === 0,
    errors,
    normalized: normalizeSpaces(rawType),
    shifted,
  };
}

/**
 * Live C-type / function signature / struct field syntax validator.
 * Supports standard C11 types, function prototypes, bitfields (`uint32_t f : 4`),
 * `__shifted(T, delta)`, and IDA-style `__usercall` / `__userpurge` locations.
 */
export function validateCTypeSyntax(input, targetKind = 'local') {
  const raw = String(input ?? '');
  const normalized = normalizeSpaces(raw);
  const errors = [];

  if (!normalized) {
    return { valid: false, normalized: '', errors: ['Type expression cannot be empty'] };
  }
  if (CONTROL_CHAR_RE.test(raw)) {
    return { valid: false, normalized, errors: ['Control characters are not allowed'] };
  }
  if (normalized.includes(';')) {
    return { valid: false, normalized, errors: ['Remove trailing semicolons from type expression'] };
  }

  // Strip valid @<...> ABI location tags before checking for unsafe `<` / `>`
  const abiLocations = [];
  let locIndex = 0;
  const withoutValidAbiLocs = normalized.replace(/@<([^<>]+)>/g, (_m, locBody) => {
    const res = validateUsercallLocation(locBody);
    if (!res.ok) errors.push(res.error);
    abiLocations.push({ index: locIndex, raw: locBody.trim(), ...res });
    locIndex += 1;
    return ` @LOC_${locIndex - 1} `;
  });

  if (UNSAFE_HTML_RE.test(withoutValidAbiLocs)) {
    errors.push('Invalid characters (< or >) in C type');
    return { valid: false, normalized, errors };
  }
  if (!checkBalancedDelimiters(withoutValidAbiLocs)) {
    errors.push('Unbalanced parentheses or brackets');
    return { valid: false, normalized, errors };
  }

  if (targetKind === 'function') {
    const fnMatch = withoutValidAbiLocs.match(/^(.+?)\s*\((.*?)\)\s*(?:__purge\s*\(\s*(0x[0-9a-fA-F]+|\d+)\s*\))?$/);
    if (!fnMatch) {
      errors.push('Function signature must have form: ret_type name(arg_types...)');
      return { valid: false, normalized, errors };
    }
    const header = fnMatch[1].trim();
    const argsBody = fnMatch[2].trim();
    const purgeRaw = fnMatch[3];

    if (purgeRaw != null) {
      const purgeBytes = Number.parseInt(purgeRaw, 0);
      if (!Number.isSafeInteger(purgeBytes) || purgeBytes < 0 || purgeBytes % 16 !== 0) {
        errors.push('__purge(N) must be a non-negative 16-byte aligned integer');
      }
    }

    // Extract calling convention, function name, return type
    const headerTokens = header.split(/\s+/).filter(Boolean);
    let cc = 'default';
    const filteredTokens = [];
    for (const tok of headerTokens) {
      if (KNOWN_CALLING_CONVENTIONS.has(tok)) {
        cc = tok;
      } else if (!tok.startsWith('@LOC_')) {
        filteredTokens.push(tok);
      }
    }
    if (filteredTokens.length < 2) {
      errors.push('Function signature requires both return type and function name');
      return { valid: false, normalized, errors };
    }
    const fnNameRaw = filteredTokens[filteredTokens.length - 1].replace(/^\*+/, '');
    if (!C_IDENT_RE.test(fnNameRaw)) {
      errors.push(`Invalid function name: ${fnNameRaw}`);
    }
    const retPart = filteredTokens.slice(0, -1).join(' ');
    const retCheck = validateSimpleTypeExpr(retPart);
    if (!retCheck.valid) errors.push(...retCheck.errors);

    const parsedArgs = [];
    if (argsBody && argsBody !== 'void') {
      const rawArgs = splitTopLevelCommas(argsBody);
      if (rawArgs.length > 12 && (cc === '__usercall' || cc === '__userpurge')) {
        errors.push('Custom ABI supports at most 12 arguments');
      }
      const seenRegs = new Set();
      for (const arg of rawArgs) {
        if (!arg) {
          errors.push('Empty parameter in argument list');
          continue;
        }
        if (arg === '...') {
          parsedArgs.push('...');
          continue;
        }
        const cleanedArg = arg.replace(/@LOC_(\d+)/g, (_m, idx) => {
          const info = abiLocations[Number(idx)];
          if (info?.ok && info.kind === 'reg') {
            const key = info.loc.toLowerCase();
            if (seenRegs.has(key)) errors.push(`Duplicate ABI register: ${info.loc}`);
            seenRegs.add(key);
          }
          return '';
        }).trim();
        const argCheck = validateSimpleTypeExpr(cleanedArg);
        if (!argCheck.valid) errors.push(...argCheck.errors);
        parsedArgs.push(cleanedArg);
      }
    }

    return {
      valid: errors.length === 0,
      normalized,
      errors,
      parsed: {
        kind: 'function',
        name: fnNameRaw,
        cc,
        ret: retPart,
        args: parsedArgs,
        abiLocations,
      },
    };
  }

  if (targetKind === 'field') {
    // Support optional bitfield syntax: `uint32_t flags : 4`
    let baseExpr = withoutValidAbiLocs;
    let bitWidth = null;
    const bfMatch = withoutValidAbiLocs.match(/^(.+?)\s*:\s*(\d+)$/);
    if (bfMatch) {
      baseExpr = bfMatch[1].trim();
      bitWidth = Number.parseInt(bfMatch[2], 10);
      if (!Number.isSafeInteger(bitWidth) || bitWidth < 1 || bitWidth > 64) {
        errors.push('Bitfield width must be between 1 and 64');
      }
    } else if (withoutValidAbiLocs.includes(':')) {
      errors.push('Invalid bitfield syntax (expected `type name : width`)');
    }
    const check = validateSimpleTypeExpr(baseExpr);
    if (!check.valid) errors.push(...check.errors);
    return {
      valid: errors.length === 0,
      normalized,
      errors,
      parsed: {
        kind: 'field',
        baseExpr,
        bitWidth,
        shifted: check.shifted,
      },
    };
  }

  // local / param / global / struct
  const check = validateSimpleTypeExpr(withoutValidAbiLocs);
  if (!check.valid) errors.push(...check.errors);
  return {
    valid: errors.length === 0,
    normalized,
    errors,
    parsed: {
      kind: targetKind,
      shifted: check.shifted,
    },
  };
}

/**
 * Formats a function signature into §9.3 80-character-safe slot keys
 * (`fn:<va>:ret`, `fn:<va>:arg<i>`, `fn:<va>:cc`).
 */
export function buildNotesTypeSlots(va, validationResult) {
  const vaKey = String(va ?? '0x0');
  const slots = Object.create(null);
  if (!validationResult?.valid || !validationResult.parsed) return slots;
  const p = validationResult.parsed;
  if (p.kind === 'function') {
    slots[`fn:${vaKey}:ret`] = String(p.ret ?? 'void').slice(0, MAX_SLOT_VALUE_LEN);
    slots[`fn:${vaKey}:cc`] = String(p.cc ?? 'default').slice(0, MAX_SLOT_VALUE_LEN);
    for (let i = 0; i < (p.args?.length ?? 0); i += 1) {
      slots[`fn:${vaKey}:arg${i}`] = String(p.args[i]).slice(0, MAX_SLOT_VALUE_LEN);
    }
  } else {
    slots[`type:${vaKey}`] = String(validationResult.normalized).slice(0, MAX_SLOT_VALUE_LEN);
  }
  return slots;
}

/**
 * Creates a pure, framework-free controller for the contextual Type-Edit Popover.
 */
export function createTypeEditPopoverController(options = {}) {
  const undoLimit = Number.isSafeInteger(options.undoLimit) && options.undoLimit > 0
    ? options.undoLimit
    : DEFAULT_UNDO_LIMIT;
  const onCommit = typeof options.onCommit === 'function' ? options.onCommit : null;
  const onUndo = typeof options.onUndo === 'function' ? options.onUndo : null;
  const onRedo = typeof options.onRedo === 'function' ? options.onRedo : null;
  const onDirtyConeAbort = typeof options.onDirtyConeAbort === 'function' ? options.onDirtyConeAbort : null;

  let state = {
    open: false,
    target: null,
    draftText: '',
    pinned: false,
    validation: { valid: true, normalized: '', errors: [] },
    diffPreview: null,
    revision: 0,
  };

  const undoStack = [];
  const redoStack = [];
  const listeners = new Set();
  let activeAbortController = null;

  function emit() {
    const snap = getState();
    for (const fn of listeners) fn(snap);
  }

  function computeDiffPreview(target, draftText, pinned) {
    if (!target) return null;
    const beforeType = String(target.currentType ?? '');
    const afterType = normalizeSpaces(draftText);
    const beforePinned = Boolean(target.pinned);
    const afterPinned = Boolean(pinned);
    return {
      changed: beforeType !== afterType || beforePinned !== afterPinned,
      beforeType,
      afterType,
      beforePinned,
      afterPinned,
    };
  }

  function getState() {
    return Object.freeze({
      open: state.open,
      target: state.target ? Object.freeze({ ...state.target }) : null,
      draftText: state.draftText,
      pinned: state.pinned,
      validation: Object.freeze({
        valid: state.validation.valid,
        normalized: state.validation.normalized,
        errors: Object.freeze([...(state.validation.errors ?? [])]),
      }),
      diffPreview: state.diffPreview ? Object.freeze({ ...state.diffPreview }) : null,
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      undoDepth: undoStack.length,
      redoDepth: redoStack.length,
      revision: state.revision,
    });
  }

  function setActiveAbortController(ctrl) {
    activeAbortController = ctrl || null;
  }

  function abortInFlight(reason) {
    if (activeAbortController && typeof activeAbortController.abort === 'function') {
      try { activeAbortController.abort(reason); } catch { /* ignore */ }
    }
    if (onDirtyConeAbort) onDirtyConeAbort(reason);
  }

  function openForTarget(target) {
    if (!target || typeof target !== 'object') {
      throw new Error('openForTarget requires a target descriptor object');
    }
    const kind = VALID_TARGET_KIND_SET.has(target.kind) ? target.kind : 'local';
    const normalizedTarget = {
      kind,
      ref: String(target.ref ?? target.name ?? ''),
      name: String(target.name ?? target.ref ?? ''),
      va: String(target.va ?? '0x0'),
      currentType: String(target.currentType ?? ''),
      pinned: Boolean(target.pinned),
      structName: target.structName != null ? String(target.structName) : null,
      fieldOffset: Number.isFinite(target.fieldOffset) ? target.fieldOffset : null,
      fieldSize: Number.isFinite(target.fieldSize) ? target.fieldSize : null,
    };
    const validation = validateCTypeSyntax(normalizedTarget.currentType, kind);
    state = {
      ...state,
      open: true,
      target: normalizedTarget,
      draftText: normalizedTarget.currentType,
      pinned: normalizedTarget.pinned,
      validation,
      diffPreview: computeDiffPreview(normalizedTarget, normalizedTarget.currentType, normalizedTarget.pinned),
    };
    emit();
    return getState();
  }

  function close() {
    if (!state.open) return getState();
    state = { ...state, open: false };
    emit();
    return getState();
  }

  function setDraft(text) {
    const nextText = String(text ?? '');
    const kind = state.target?.kind ?? 'local';
    const validation = validateCTypeSyntax(nextText, kind);
    state = {
      ...state,
      draftText: nextText,
      validation,
      diffPreview: computeDiffPreview(state.target, nextText, state.pinned),
    };
    emit();
    return state.validation;
  }

  function togglePinned(explicitValue) {
    const nextPinned = typeof explicitValue === 'boolean' ? explicitValue : !state.pinned;
    state = {
      ...state,
      pinned: nextPinned,
      diffPreview: computeDiffPreview(state.target, state.draftText, nextPinned),
    };
    emit();
    return nextPinned;
  }

  function commit() {
    if (!state.target) {
      return { ok: false, errors: ['No active target to commit'] };
    }
    const validation = validateCTypeSyntax(state.draftText, state.target.kind);
    if (!validation.valid) {
      state = { ...state, validation };
      emit();
      return { ok: false, errors: [...validation.errors] };
    }
    const beforeType = state.target.currentType;
    const afterType = validation.normalized;
    const beforePinned = state.target.pinned;
    const afterPinned = state.pinned;

    const tx = Object.freeze({
      id: `type-tx-${state.revision + 1}`,
      target: Object.freeze({ ...state.target }),
      beforeType,
      afterType,
      beforePinned,
      afterPinned,
      pinMaskDelta: { before: beforePinned ? 1 : 0, after: afterPinned ? 1 : 0 },
      notesDelta: buildNotesTypeSlots(state.target.va, validation),
      requiresPathA2ReDecompile: state.target.kind === 'struct' || state.target.kind === 'field' || state.target.kind === 'function',
      parsed: validation.parsed ?? null,
    });

    undoStack.push(tx);
    while (undoStack.length > undoLimit) undoStack.shift();
    redoStack.length = 0;

    state = {
      ...state,
      target: { ...state.target, currentType: afterType, pinned: afterPinned },
      draftText: afterType,
      validation,
      diffPreview: computeDiffPreview({ ...state.target, currentType: afterType, pinned: afterPinned }, afterType, afterPinned),
      revision: state.revision + 1,
    };

    if (onCommit) onCommit(tx);
    emit();
    return { ok: true, transaction: tx };
  }

  function undo() {
    if (undoStack.length === 0) return { ok: false, reason: 'nothing_to_undo' };
    abortInFlight('undo-redo');
    const tx = undoStack.pop();
    redoStack.push(tx);

    const nextTarget = state.target && state.target.ref === tx.target.ref
      ? { ...state.target, currentType: tx.beforeType, pinned: tx.beforePinned }
      : state.target;

    state = {
      ...state,
      target: nextTarget,
      draftText: nextTarget ? nextTarget.currentType : state.draftText,
      pinned: nextTarget ? nextTarget.pinned : state.pinned,
      validation: nextTarget ? validateCTypeSyntax(nextTarget.currentType, nextTarget.kind) : state.validation,
      diffPreview: nextTarget ? computeDiffPreview(nextTarget, nextTarget.currentType, nextTarget.pinned) : null,
      revision: state.revision + 1,
    };

    if (onUndo) onUndo(tx);
    emit();
    return { ok: true, transaction: tx };
  }

  function redo() {
    if (redoStack.length === 0) return { ok: false, reason: 'nothing_to_redo' };
    abortInFlight('undo-redo');
    const tx = redoStack.pop();
    undoStack.push(tx);

    const nextTarget = state.target && state.target.ref === tx.target.ref
      ? { ...state.target, currentType: tx.afterType, pinned: tx.afterPinned }
      : state.target;

    state = {
      ...state,
      target: nextTarget,
      draftText: nextTarget ? nextTarget.currentType : state.draftText,
      pinned: nextTarget ? nextTarget.pinned : state.pinned,
      validation: nextTarget ? validateCTypeSyntax(nextTarget.currentType, nextTarget.kind) : state.validation,
      diffPreview: nextTarget ? computeDiffPreview(nextTarget, nextTarget.currentType, nextTarget.pinned) : null,
      revision: state.revision + 1,
    };

    if (onRedo) onRedo(tx);
    emit();
    return { ok: true, transaction: tx };
  }

  /**
   * Token-scoped keyboard dispatcher (§9.1):
   * - `y`/`Y` on a token element opens the popover for that token's target.
   * - `Escape` closes the popover.
   * - `Ctrl/Cmd+Z` undoes; `Ctrl/Cmd+Shift+Z` or `Ctrl+Y` redoes.
   */
  function handleKeyDown(event, tokenTarget = null) {
    if (!event) return false;
    const key = String(event.key ?? '');
    const mod = Boolean(event.ctrlKey || event.metaKey);

    if (mod && key.toLowerCase() === 'z') {
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
      if (typeof event.preventDefault === 'function') event.preventDefault();
      return true;
    }
    if (mod && key.toLowerCase() === 'y') {
      redo();
      if (typeof event.preventDefault === 'function') event.preventDefault();
      return true;
    }
    if (key === 'Escape' && state.open) {
      close();
      if (typeof event.preventDefault === 'function') event.preventDefault();
      return true;
    }
    if (!mod && !event.altKey && (key === 'y' || key === 'Y') && tokenTarget) {
      openForTarget(tokenTarget);
      if (typeof event.preventDefault === 'function') event.preventDefault();
      return true;
    }
    return false;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    openForTarget,
    close,
    setDraft,
    togglePinned,
    commit,
    undo,
    redo,
    handleKeyDown,
    setActiveAbortController,
    getState,
    subscribe,
  };
}

/**
 * Renders the contextual Type-Edit Popover using strictly safe DOM APIs
 * (`textContent` only; zero `innerHTML`). Supports an injected `document`
 * for headless Node testing.
 */
export function renderTypeEditPopover(controller, options = {}) {
  const doc = options.document ?? globalThis.document;
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('renderTypeEditPopover requires a document with createElement');
  }

  const debounceMs = Number.isFinite(options.debounceMs) && options.debounceMs >= 0
    ? Number(options.debounceMs)
    : DEFAULT_DEBOUNCE_MS;
  const ac = new AbortController();
  const { signal } = ac;
  let debounceTimer = null;
  let pendingDraft = null;

  function flushDebouncedDraft() {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (pendingDraft !== null) {
      const value = pendingDraft;
      pendingDraft = null;
      controller.setDraft(value);
    }
  }

  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  };

  const root = el('div', 'hex-popover hex-type-edit-popover');
  root.setAttribute('role', 'dialog');
  root.setAttribute('data-popover', 'type-edit');
  root.setAttribute('aria-label', 'Edit C Type');

  const header = el('div', 'hex-popover-header');
  const titleEl = el('span', 'hex-popover-title', 'Edit Type (Y)');
  const targetBadge = el('code', 'hex-popover-target-badge', '');
  const closeBtn = el('button', 'hex-popover-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', () => {
    if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
    pendingDraft = null;
    controller.close();
  }, { signal });
  header.appendChild(titleEl);
  header.appendChild(targetBadge);
  header.appendChild(closeBtn);

  const form = el('div', 'hex-popover-body');
  const inputLabel = el('label', 'hex-popover-label', 'C Type / Prototype');
  const input = el('input', 'hex-type-edit-input');
  input.type = 'text';
  input.setAttribute('data-field', 'type-input');
  input.addEventListener('input', (ev) => {
    const nextVal = ev?.target?.value ?? input.value ?? '';
    if (debounceMs === 0) {
      controller.setDraft(nextVal);
      return;
    }
    pendingDraft = nextVal;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (signal.aborted) return;
      const val = pendingDraft;
      pendingDraft = null;
      if (val !== null) controller.setDraft(val);
    }, debounceMs);
  }, { signal });

  const pinRow = el('label', 'hex-pin-toggle-row');
  const pinCheckbox = el('input', 'hex-pin-checkbox');
  pinCheckbox.type = 'checkbox';
  pinCheckbox.setAttribute('data-field', 'user-pinned');
  pinCheckbox.addEventListener('change', () => {
    flushDebouncedDraft();
    controller.togglePinned(Boolean(pinCheckbox.checked));
  }, { signal });
  const pinLabelText = el('span', 'hex-pin-label', 'USER_PINNED (lock against auto-propagation)');
  pinRow.appendChild(pinCheckbox);
  pinRow.appendChild(pinLabelText);

  const statusEl = el('div', 'hex-validation-status', '');
  statusEl.setAttribute('data-role', 'validation-status');

  const diffEl = el('pre', 'hex-diff-preview', '');
  diffEl.setAttribute('data-role', 'diff-preview');

  const actions = el('div', 'hex-popover-actions');
  const undoBtn = el('button', 'hex-btn-undo', 'Undo');
  undoBtn.type = 'button';
  undoBtn.addEventListener('click', () => {
    if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
    pendingDraft = null;
    controller.undo();
  }, { signal });

  const redoBtn = el('button', 'hex-btn-redo', 'Redo');
  redoBtn.type = 'button';
  redoBtn.addEventListener('click', () => {
    if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
    pendingDraft = null;
    controller.redo();
  }, { signal });

  const applyBtn = el('button', 'hex-btn-apply', 'Apply');
  applyBtn.type = 'button';
  applyBtn.addEventListener('click', () => {
    flushDebouncedDraft();
    controller.commit();
  }, { signal });

  actions.appendChild(undoBtn);
  actions.appendChild(redoBtn);
  actions.appendChild(applyBtn);

  form.appendChild(inputLabel);
  form.appendChild(input);
  form.appendChild(pinRow);
  form.appendChild(statusEl);
  form.appendChild(diffEl);
  form.appendChild(actions);

  root.appendChild(header);
  root.appendChild(form);

  function sync(snap) {
    root.setAttribute('data-open', snap.open ? 'true' : 'false');
    if (snap.target) {
      targetBadge.textContent = `${snap.target.kind}: ${snap.target.name} @ ${snap.target.va}`;
    } else {
      targetBadge.textContent = '';
    }
    input.value = snap.draftText;
    pinCheckbox.checked = snap.pinned;
    if (snap.validation.valid) {
      statusEl.className = 'hex-validation-status is-valid';
      statusEl.textContent = 'Valid C type syntax';
    } else {
      statusEl.className = 'hex-validation-status is-invalid';
      statusEl.textContent = snap.validation.errors.join('; ');
    }
    if (snap.diffPreview && snap.diffPreview.changed) {
      diffEl.textContent = `- ${snap.diffPreview.beforeType} [pin=${snap.diffPreview.beforePinned}]\n+ ${snap.diffPreview.afterType} [pin=${snap.diffPreview.afterPinned}]`;
    } else {
      diffEl.textContent = '';
    }
    undoBtn.disabled = !snap.canUndo;
    redoBtn.disabled = !snap.canRedo;
    applyBtn.disabled = !snap.validation.valid;
  }

  sync(controller.getState());
  const unsubscribe = controller.subscribe(sync);

  return {
    element: root,
    destroy: () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      pendingDraft = null;
      unsubscribe();
      ac.abort();
      root.remove?.();
    },
    flushDebouncedDraft,
    sync: () => sync(controller.getState()),
  };
}
