// Non-destructive post-emit overlay engine (§0.1, §7.3, §9.1, §15.4).
// Applies user renames, type overrides, struct field labels, display hints,
// shifted-pointer ADJ() labels, and inline comments onto decompiled pseudocode
// lines in O(1) per touched line without full re-decompile when possible.
// Pure architecture-neutral core (INV-005).

const IDENT_RE = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;

function toMap(src) {
  if (!src) return new Map();
  if (src instanceof Map) return src;
  return new Map(Object.entries(src));
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatDisplayHint(valueNum, hint) {
  if (!hint || typeof valueNum !== 'number' || !Number.isFinite(valueNum)) return null;
  if (hint.enumLabel) return hint.enumLabel;
  if (hint.radix === 'hex') {
    return valueNum < 0 ? `-0x${Math.abs(valueNum).toString(16)}` : `0x${valueNum.toString(16)}`;
  }
  if (hint.radix === 'dec') {
    return String(valueNum);
  }
  if (hint.signFlip) {
    return String(-valueNum);
  }
  return null;
}

function applyOverlayToSingleLine(baseLine, lineIdx, state) {
  let line = String(baseLine);

  // 1. Struct field deref labels: e.g. *(uint64_t *)(ptr + 0x18) or ptr->field_18
  if (state.structFields.size > 0) {
    for (const [key, fieldLabel] of state.structFields.entries()) {
      const sep = key.indexOf(':');
      if (sep <= 0) continue;
      const baseVar = key.slice(0, sep);
      const offNum = Number(key.slice(sep + 1));
      if (!Number.isFinite(offNum)) continue;
      const hexOff = `0x${Math.abs(offNum).toString(16)}`;
      const escVar = escapeRegExp(baseVar);
      // Rewrite *(T *)(baseVar + 0x18) -> baseVar->fieldLabel
      const derefRe = new RegExp(
        `\\*\\s*\\([^()]+\\*\\s*\\)\\s*\\(\\s*${escVar}\\s*\\+\\s*(?:${escapeRegExp(hexOff)}|${offNum})\\s*\\)`,
        'g'
      );
      line = line.replace(derefRe, `${baseVar}->${fieldLabel}`);
      // Rewrite baseVar->field_18 -> baseVar->fieldLabel
      const defaultFieldRe = new RegExp(
        `\\b${escVar}->field_${Math.abs(offNum).toString(16)}\\b`,
        'g'
      );
      line = line.replace(defaultFieldRe, `${baseVar}->${fieldLabel}`);
    }
  }

  // 2. Shifted pointer ADJ(p)->member projection (§15.4 Path A-1)
  if (state.shiftedPtrs.size > 0) {
    for (const [varName, spec] of state.shiftedPtrs.entries()) {
      const escVar = escapeRegExp(varName);
      if (spec.declType && lineIdx === 0) {
        const paramRe = new RegExp(`\\b(?:void\\s*\\*|uint64_t|int64_t|uintptr_t)\\s+${escVar}\\b`);
        line = line.replace(
          paramRe,
          `${spec.declType} *__shifted(${spec.declType}, 0x${Math.abs(spec.shiftOffset || 0).toString(16)}) ${varName}`
        );
      }
      if (spec.memberName && Number.isFinite(spec.rawAccessOffset)) {
        const off = spec.rawAccessOffset;
        const sign = off < 0 ? '-' : '+';
        const absHex = `0x${Math.abs(off).toString(16)}`;
        const shiftedDerefRe = new RegExp(
          `\\*\\s*\\([^()]+\\*\\s*\\)\\s*\\(\\s*${escVar}\\s*\\${sign}\\s*(?:${escapeRegExp(absHex)}|${Math.abs(off)})\\s*\\)`,
          'g'
        );
        line = line.replace(shiftedDerefRe, `ADJ(${varName})->${spec.memberName}`);
      }
    }
  }

  // 3. Type overrides on declarations (e.g. `int64_t x0` -> `Player *x0`)
  if (state.typeOverrides.size > 0) {
    for (const [sym, newType] of state.typeOverrides.entries()) {
      const escSym = escapeRegExp(sym);
      const declRe = new RegExp(
        `\\b(?:(?:const|unsigned|signed|struct|union|enum)\\s+)*[A-Za-z_][A-Za-z0-9_]*\\s*(?:\\*\\s*)*(?=${escSym}\\b)`,
        'g'
      );
      line = line.replace(declRe, (match) => {
        // Avoid replacing C control keywords like `return `, `if `, `else `
        const trimmed = match.trim();
        if (
          trimmed === 'return' ||
          trimmed === 'else' ||
          trimmed === 'goto' ||
          trimmed === 'case' ||
          trimmed === 'sizeof'
        ) {
          return match;
        }
        return newType.endsWith('*') ? `${newType}` : `${newType} `;
      });
    }
  }

  // 4. Identifier renames (single-pass token replacement to prevent chained collisions)
  if (state.renames.size > 0) {
    line = line.replace(IDENT_RE, (tok) => (state.renames.has(tok) ? state.renames.get(tok) : tok));
  }

  // 5. Display hints (Enum / Bitmask / Hex / Dec / Sign flip)
  if (state.displayHints.size > 0) {
    for (const [key, hint] of state.displayHints.entries()) {
      if (hint.lineIndex !== undefined && hint.lineIndex !== lineIdx) continue;
      if (hint.literalText) {
        const replacement = formatDisplayHint(hint.numericValue, hint);
        if (replacement) {
          line = line.replace(hint.literalText, replacement);
        }
      } else if (key.startsWith(`L${lineIdx}:`)) {
        const lit = key.slice(`L${lineIdx}:`.length);
        const num = Number(lit);
        const replacement = formatDisplayHint(num, hint);
        if (replacement) {
          line = line.replace(lit, replacement);
        }
      }
    }
  }

  // 6. Inline comment (appended on same line — preserves line count & line index 0-diff)
  const comment = state.comments.get(lineIdx) ?? state.comments.get(String(lineIdx));
  if (comment) {
    const cleanComment = String(comment).replace(/[\r\n]+/g, ' ').trim();
    if (cleanComment) {
      line = `${line}  // ${cleanComment}`;
    }
  }

  return line;
}

/**
 * Determine if an edit requires Path A-2 structural re-decompile or can stay on Path A-1 O(1) fast overlay.
 */
export function requiresStructuralReDecompile(edit) {
  if (!edit || typeof edit !== 'object') return false;
  return Boolean(
    edit.argCountChanged ||
      edit.callingConventionChanged ||
      edit.stackFrameStructChanged ||
      edit.arrayIvChanged ||
      edit.pointerPromotionChanged ||
      edit.stackSlotSplitChanged ||
      edit.customAbiChanged
  );
}

/**
 * Non-destructive single-shot overlay projection (§0.1 `projectTypedOverlay`).
 * Guarantees `result.lines.length` and `renderProvenance.entities` keys remain invariant (Gate D-2).
 */
export function projectTypedOverlay(emitResult, overlaySpec = {}) {
  const baseLines = Array.isArray(emitResult?.lines) ? emitResult.lines : [];
  const state = {
    renames: toMap(overlaySpec.renames),
    typeOverrides: toMap(overlaySpec.typeOverrides),
    structFields: toMap(overlaySpec.structFields),
    displayHints: toMap(overlaySpec.displayHints),
    comments: toMap(overlaySpec.comments),
    shiftedPtrs: toMap(overlaySpec.shiftedPtrs),
  };

  const projectedLines = new Array(baseLines.length);
  for (let i = 0; i < baseLines.length; i++) {
    projectedLines[i] = applyOverlayToSingleLine(baseLines[i], i, state);
  }

  // Shallow-clone provenance while preserving exact `L<index>:<kind>` keys untouched
  const baseProv = emitResult?.renderProvenance;
  const renderProvenance = baseProv
    ? {
        ...baseProv,
        entities: baseProv.entities ? { ...baseProv.entities } : undefined,
      }
    : undefined;

  return {
    ...emitResult,
    lines: projectedLines,
    baseLines: baseLines.slice(),
    renderProvenance,
    overlayApplied: true,
    prelude: overlaySpec.prelude || emitResult?.prelude || null,
  };
}

/**
 * Stateful O(1) incremental post-emit overlay engine.
 * Indexes symbol occurrences per line once on load so subsequent single-symbol renames,
 * field label updates, or line comments touch ONLY affected lines in O(k) (O(1) amortized).
 */
export class PostEmitOverlayEngine {
  constructor(emitResult) {
    this.baseResult = emitResult;
    this.baseLines = Array.isArray(emitResult?.lines) ? emitResult.lines.slice() : [];
    this.projectedLines = this.baseLines.slice();
    this.renames = new Map();
    this.typeOverrides = new Map();
    this.structFields = new Map();
    this.displayHints = new Map();
    this.comments = new Map();
    this.shiftedPtrs = new Map();
    this.symbolLineIndex = new Map();
    this.revision = 0;
    this.lastTouchedLines = [];
    this._buildSymbolIndex();
  }

  _buildSymbolIndex() {
    this.symbolLineIndex.clear();
    for (let i = 0; i < this.baseLines.length; i++) {
      const line = String(this.baseLines[i]);
      const seen = new Set();
      let m;
      IDENT_RE.lastIndex = 0;
      while ((m = IDENT_RE.exec(line)) !== null) {
        const tok = m[0];
        if (!seen.has(tok)) {
          seen.add(tok);
          let set = this.symbolLineIndex.get(tok);
          if (!set) {
            set = new Set();
            this.symbolLineIndex.set(tok, set);
          }
          set.add(i);
        }
      }
    }
  }

  _state() {
    return {
      renames: this.renames,
      typeOverrides: this.typeOverrides,
      structFields: this.structFields,
      displayHints: this.displayHints,
      comments: this.comments,
      shiftedPtrs: this.shiftedPtrs,
    };
  }

  _reprojectLines(indices) {
    const state = this._state();
    const touched = [];
    for (const idx of indices) {
      if (idx >= 0 && idx < this.baseLines.length) {
        this.projectedLines[idx] = applyOverlayToSingleLine(this.baseLines[idx], idx, state);
        touched.push(idx);
      }
    }
    this.revision += 1;
    this.lastTouchedLines = touched;
    return touched;
  }

  setRename(oldName, newName) {
    if (newName === null || newName === undefined || newName === oldName) {
      this.renames.delete(oldName);
    } else {
      this.renames.set(oldName, String(newName));
    }
    const lines = this.symbolLineIndex.get(oldName) || [];
    return this._reprojectLines(lines);
  }

  setTypeOverride(sym, newType) {
    if (!newType) this.typeOverrides.delete(sym);
    else this.typeOverrides.set(sym, String(newType));
    const lines = this.symbolLineIndex.get(sym) || [];
    return this._reprojectLines(lines);
  }

  setStructFieldLabel(baseVar, offset, fieldName) {
    const key = `${baseVar}:${offset}`;
    if (!fieldName) this.structFields.delete(key);
    else this.structFields.set(key, String(fieldName));
    const lines = this.symbolLineIndex.get(baseVar) || [];
    return this._reprojectLines(lines);
  }

  setComment(lineIndex, commentText) {
    const idx = Number(lineIndex);
    if (!commentText) this.comments.delete(idx);
    else this.comments.set(idx, String(commentText));
    return this._reprojectLines([idx]);
  }

  setDisplayHint(lineIndex, literalText, hint) {
    const idx = Number(lineIndex);
    const key = `L${idx}:${literalText}`;
    if (!hint) this.displayHints.delete(key);
    else this.displayHints.set(key, { ...hint, lineIndex: idx, literalText });
    return this._reprojectLines([idx]);
  }

  setShiftedPtr(varName, spec) {
    if (!spec) this.shiftedPtrs.delete(varName);
    else this.shiftedPtrs.set(varName, { ...spec });
    const lines = this.symbolLineIndex.get(varName) || [];
    return this._reprojectLines(lines);
  }

  getLine(lineIndex) {
    return this.projectedLines[lineIndex];
  }

  getResult() {
    return {
      ...this.baseResult,
      lines: this.projectedLines.slice(),
      baseLines: this.baseLines.slice(),
      renderProvenance: this.baseResult?.renderProvenance
        ? {
            ...this.baseResult.renderProvenance,
            entities: this.baseResult.renderProvenance.entities
              ? { ...this.baseResult.renderProvenance.entities }
              : undefined,
          }
        : undefined,
      overlayApplied: true,
      revision: this.revision,
    };
  }
}
