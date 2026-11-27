const DEFAULT_MOVE_TOLERANCE = 10;

export function installViewerDragReturnGuard(viewer, { moveTolerance = DEFAULT_MOVE_TOLERANCE } = {}) {
  const viewport = viewer?.vp;
  if (!viewer || !viewport || typeof viewport.addEventListener !== 'function') return false;
  if (viewer.__dragReturnGuardInstalled) return true;
  const tolerance = Number(moveTolerance);
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new TypeError('viewer-gesture-move-tolerance-invalid');
  let gesture = null;

  const pointerdown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.isPrimary === false) { if (gesture) gesture.moved = true; return; }
    const row = event.target?.closest?.('.row');
    if (!row || row._row == null || row._row < 0) { gesture = null; return; }
    gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  };
  const pointermove = (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId || gesture.moved) return;
    if (Math.abs(event.clientX - gesture.x) > tolerance || Math.abs(event.clientY - gesture.y) > tolerance) gesture.moved = true;
  };
  const pointerup = (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const moved = gesture.moved;
    gesture = null;
    if (moved) event.stopImmediatePropagation();
  };
  const pointercancel = (event) => {
    if (!gesture || event?.pointerId == null || event.pointerId === gesture.pointerId) gesture = null;
  };

  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const opts = ac ? { capture: true, passive: true, signal: ac.signal } : { capture: true, passive: true };
  viewport.addEventListener('pointerdown', pointerdown, opts);
  viewport.addEventListener('pointermove', pointermove, opts);
  viewport.addEventListener('pointerup', pointerup, opts);
  viewport.addEventListener('pointercancel', pointercancel, opts);
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    gesture = null;
    ac?.abort();
    viewport.removeEventListener?.('pointerdown', pointerdown, true);
    viewport.removeEventListener?.('pointermove', pointermove, true);
    viewport.removeEventListener?.('pointerup', pointerup, true);
    viewport.removeEventListener?.('pointercancel', pointercancel, true);
    delete viewer.__dragReturnGuardInstalled;
    delete viewer.__disposeDragReturnGuard;
  };
  Object.defineProperty(viewer, '__dragReturnGuardInstalled', { value: true, configurable: true });
  Object.defineProperty(viewer, '__disposeDragReturnGuard', { value: cleanup, configurable: true });
  return true;
}
