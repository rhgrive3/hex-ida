/*
 * Mission guide on the user's own binary. Each step is checked from real
 * state (goal run, function opened, pseudocode read, name/comment saved,
 * report exported). Nothing is persisted here beyond the current session.
 */
const marks = new WeakMap();

function stateOf(app) {
  let s = marks.get(app);
  if (!s) { s = { fileInfo: null, openedFunction: null, readPseudo: false, report: false }; marks.set(app, s); }
  const info = app?.store?.get?.('fileInfo') || null;
  if (s.fileInfo !== info) Object.assign(s, { fileInfo: info, openedFunction: null, readPseudo: false, report: false });
  return s;
}

export function markMission(app, key, value = true) {
  if (!app) return;
  const s = stateOf(app);
  if (key === 'open-function') { try { s.openedFunction = BigInt(value); } catch { /* ignore */ } }
  else if (key === 'read-pseudo') s.readPseudo = true;
  else if (key === 'report') s.report = true;
  try { globalThis.document?.dispatchEvent?.(new CustomEvent('hex:mission')); } catch { /* no DOM */ }
}

function hasUserNames(app) {
  try { return (app?.notes?.nameEntries?.() || []).length > 0; } catch { return false; }
}
function hasNotes(app) {
  try {
    if ((app?.notes?.comments?.size ?? 0) > 0) return true;
    return (app?.bookmarks?.list?.() || []).some((b) => String(b?.note || '').trim());
  } catch { return false; }
}

/** Target function for the next action: the one the user opened, else the last goal's answer. */
export function missionFunction(app) {
  const s = stateOf(app);
  if (s.openedFunction != null) return s.openedFunction;
  const ctx = app?.lastGoalContext;
  try { return ctx?.targetAddr != null ? BigInt(ctx.targetAddr) : null; } catch { return null; }
}

export function missionSteps(app) {
  const s = stateOf(app);
  return [
    { id: 'goal', ja: '目的を選ぶ', en: 'Pick a goal', done: Boolean(app?.lastGoal || app?.lastGoalContext) },
    { id: 'open', ja: '候補の関数を開く', en: 'Open a candidate function', done: s.openedFunction != null },
    { id: 'pseudo', ja: '疑似Cを読む', en: 'Read the pseudocode', done: s.readPseudo },
    { id: 'name', ja: '名前を付ける', en: 'Give it a name', done: hasUserNames(app) },
    { id: 'note', ja: 'メモを書く', en: 'Write a note', done: hasNotes(app) },
    { id: 'report', ja: 'レポートを書き出す', en: 'Export a report', done: s.report },
  ];
}
