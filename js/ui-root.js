/* Canonical UI state owner. Standalone Hex uses <html>; the userscript host
   installs its private root before application modules execute. */
export function uiRoot() {
  return globalThis.__HEX_UI_ROOT__ || globalThis.document?.documentElement || null;
}

function isUiRoot(value) {
  try {
    const classList = value?.classList;
    const style = value?.style;
    return !!value
      && typeof value === 'object'
      && value.nodeType === 1
      && typeof classList?.add === 'function'
      && typeof classList?.remove === 'function'
      && typeof classList?.toggle === 'function'
      && typeof classList?.contains === 'function'
      && typeof style?.setProperty === 'function'
      && typeof value.setAttribute === 'function'
      && typeof value.removeAttribute === 'function'
      && typeof value.append === 'function';
  } catch {
    return false;
  }
}

export function setUiRoot(root) {
  if (!isUiRoot(root)) throw new TypeError('Hex UI root must be an Element');
  globalThis.__HEX_UI_ROOT__ = root;
  return root;
}
