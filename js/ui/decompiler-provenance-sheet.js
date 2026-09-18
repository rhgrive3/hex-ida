import { Sheet, copyText } from '../ui.js';
import { h, uiButton } from './primitives.js';
import { createDecompilerProvenanceView } from './decompiler-provenance.js';

/** The legacy sheet uses the same query and navigation view as the product
 * tab. No re-decompilation, private source index, or router is required here.
 */
export async function showDecompilerProvenanceSheet(app, address, { SheetClass = Sheet } = {}) {
  const controller = new AbortController();
  const sheet = new SheetClass('疑似Cと命令の対応', { size:'full', onClose:() => controller.abort('provenance-sheet-closed') });
  // The shared component also works in a legacy shell without a product router.
  sheet.body.classList.add('product-ui-ready');
  const status = h('p', 'hint', '同じ解析スナップショットから対応表を取得しています…');
  status.setAttribute('role', 'status');
  sheet.body.append(status);
  const api = app?.analysisQueries;
  const backend = app?.backend;
  const generation = backend?.gen;
  const slice = app?.store?.get('sliceIndex');
  const isCurrent = () => !controller.signal.aborted && sheet.root.isConnected
    && app?.analysisQueries === api && app?.backend === backend
    && backend?.gen === generation && app?.store?.get('sliceIndex') === slice;
  if (typeof api?.snapshot !== 'function' || typeof api?.decompile !== 'function') {
    status.textContent = '解析クエリが利用できないため、対応表を表示できません。';
    return sheet;
  }
  try {
    const snapshot = await api.snapshot({ signal:controller.signal });
    if (!isCurrent()) return sheet;
    const query = await api.decompile(snapshot, address, { signal:controller.signal });
    if (!isCurrent()) return sheet;
    if (query?.completeness === 'unsupported' || query?.value == null) {
      status.textContent = 'この解析結果には表示できる疑似コードがありません。';
      return sheet;
    }
    const view = createDecompilerProvenanceView(query, {
      text:(ja) => ja,
      signal:controller.signal,
      isCurrent,
      currentSnapshot:() => api.snapshot({ signal:controller.signal }),
      onNavigate:target => { sheet.close(); app.goToAddress(target, { announce:true }); },
    });
    const toolbar = h('div', 'ui-code-toolbar');
    let wrap = false;
    toolbar.append(
      uiButton('コピー', { cls:'ui-secondary-action', onClick:() => copyText(view.code.textContent, '疑似C') }),
      uiButton('折り返し', { cls:'ui-secondary-action', pressed:false, onClick:event => {
        wrap = !wrap;
        view.code.classList.toggle('wrap', wrap);
        event.currentTarget.setAttribute('aria-pressed', String(wrap));
      } }),
    );
    sheet.body.replaceChildren(toolbar, view.root);
  } catch (error) {
    if (isCurrent()) status.textContent = `対応表を取得できませんでした: ${error?.message ?? String(error)}`;
  }
  return sheet;
}
