import assert from 'node:assert/strict';
import { setUiRoot, uiRoot } from '../../js/ui-root.js';
import { lang, setLang } from '../../js/i18n.js';

const hadRoot = Object.prototype.hasOwnProperty.call(globalThis, '__HEX_UI_ROOT__');
const previousRoot = globalThis.__HEX_UI_ROOT__;

try {
  const attributes = new Map();
  const validRoot = {
    classList: {},
    style: {},
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
  };

  assert.equal(setUiRoot(validRoot), validRoot, 'capability-valid UI roots remain supported');
  assert.equal(uiRoot(), validRoot, 'accepted root becomes canonical');

  setLang('en');
  assert.equal(lang(), 'en');
  assert.equal(attributes.get('lang'), 'en', 'language state and root attribute stay synchronized');

  const canonicalBeforeReject = uiRoot();
  for (const setAttribute of [undefined, true, {}]) {
    assert.throws(
      () => setUiRoot({ classList: {}, style: {}, setAttribute }),
      { name: 'TypeError', message: 'Hex UI root must be an Element' },
      'non-callable setAttribute must fail at the root boundary',
    );
    assert.equal(uiRoot(), canonicalBeforeReject, 'rejected roots must not poison canonical UI state');
  }

  setLang('ja');
  assert.equal(lang(), 'ja');
  assert.equal(attributes.get('lang'), 'ja', 'a rejected root cannot leave later language updates broken');
} finally {
  if (hadRoot) globalThis.__HEX_UI_ROOT__ = previousRoot;
  else delete globalThis.__HEX_UI_ROOT__;
}

console.log('issue #5355 UI root contract regression passed');
