import { normalizeDyldRuntimeAddress, normalizeDyldRuntimeSlide } from '../binary/dyld-runtime.js';
import { addrHex } from '../format.js';
import { pick } from '../i18n.js';
import { alertDialog, toast } from '../ui.js';

function askExactInteger(message, initial, normalize) {
  if (typeof globalThis.prompt !== 'function') throw new Error('browser prompt is unavailable');
  const value = globalThis.prompt(message, initial);
  if (value == null) return null;
  return normalize(value);
}

function workerLookup(file, slide, runtimeAddress) {
  const worker = new Worker(new URL('./dyld-runtime-worker.js', import.meta.url), { type:'module' });
  return new Promise((resolve, reject) => {
    const cleanup = () => worker.terminate();
    worker.onmessage = (event) => {
      const message = event.data || {};
      cleanup();
      if (message.ok) resolve(message);
      else reject(new Error(message.error || 'dyld runtime lookup failed'));
    };
    worker.onerror = (event) => {
      cleanup();
      reject(event?.error || new Error(event?.message || 'dyld runtime worker failed'));
    };
    worker.postMessage({ id:1, file, slide:String(slide), address:String(runtimeAddress) });
  });
}

function isDyldCache(app) {
  const info = app?.store?.get?.('fileInfo');
  return info?.formatId === 'dyld-shared-cache' || info?.productDescriptor?.formatId === 'dyld-shared-cache';
}

function runtimeLabel(result) {
  const runtime = BigInt(result.runtimeAddress);
  const unslid = result.unslidAddress == null ? null : BigInt(result.unslidAddress);
  const rebase = result.rebase?.role === 'storage'
    ? pick(' · rebase格納位置', ' · rebase storage')
    : result.rebase?.role === 'target'
      ? pick(' · rebase参照先', ' · rebase target')
      : '';
  return unslid == null
    ? `${addrHex(runtime)}${rebase}`
    : `${addrHex(runtime)} → ${addrHex(unslid)}${rebase}`;
}

export function installDyldRuntimeNavigation(app) {
  if (!app || document.getElementById('btn-dyld-runtime')) return null;
  const open = document.getElementById('btn-open-2') || document.getElementById('btn-open');
  const host = open?.parentElement || document.querySelector('.titlebar');
  if (!host) return null;

  const button = document.createElement('button');
  button.id = 'btn-dyld-runtime';
  button.type = 'button';
  button.className = open?.className || 'tb-btn';
  button.textContent = pick('実行時アドレス', 'Runtime address');
  button.title = pick('dyld共有キャッシュの実行時アドレスを開く', 'Open a runtime address in a dyld shared cache');
  button.hidden = !isDyldCache(app);
  host.insertBefore(button, open?.nextSibling || null);

  let lastSlide = 0n;
  let lastFile = app.store.get('file');
  const sync = (_state, patch = {}) => {
    const file = app.store.get('file');
    if (Object.hasOwn(patch, 'file') && file !== lastFile) {
      lastFile = file;
      lastSlide = 0n;
    }
    button.hidden = !isDyldCache(app);
  };
  const unsubscribe = app.store.subscribe(sync);
  sync();

  button.addEventListener('click', async () => {
    const file = app.store.get('file');
    if (!file || !isDyldCache(app)) return;
    let slide;
    let runtimeAddress;
    try {
      slide = askExactInteger(
        pick('この実行で使われたdyld shared cacheのslideを入力してください。\n例: 0x180d8000\n0で通常のキャッシュアドレスに戻せます。',
             'Enter the dyld shared-cache slide used by this run.\nExample: 0x180d8000\nUse 0 for unslid cache addresses.'),
        `0x${lastSlide.toString(16)}`,
        normalizeDyldRuntimeSlide,
      );
      if (slide == null) return;
      runtimeAddress = askExactInteger(
        pick('クラッシュログ・デバッガ等の実行時アドレスを入力してください。',
             'Enter the runtime address from a crash log, debugger, or trace.'),
        '',
        normalizeDyldRuntimeAddress,
      );
      if (runtimeAddress == null) return;
    } catch (error) {
      alertDialog(pick('実行時アドレスを開けません', 'Could not open runtime address'), String(error?.message || error));
      return;
    }

    const previousText = button.textContent;
    button.disabled = true;
    button.textContent = pick('照合中…', 'Mapping…');
    try {
      const response = await workerLookup(file, slide, runtimeAddress);
      if (app.store.get('file') !== file) return;
      lastSlide = slide;
      const result = response.result;
      if (!result?.mapped) {
        alertDialog(
          pick('このアドレスはキャッシュ内にありません', 'Address is outside this cache'),
          pick('入力したslideと実行時アドレスを確認してください。', 'Check the runtime slide and address.'),
        );
        return;
      }
      const unslid = result.unslidAddress == null ? null : BigInt(result.unslidAddress);
      let opened = false;
      if (unslid != null) {
        const target = (app.store.get('regions') || []).find((region) =>
          region?.size > 0n && unslid >= region.vmAddr && unslid < region.vmAddr + region.size);
        if (target) {
          app.selectRegion(target, { silent:true });
          opened = app.goToAddress(unslid, { announce:true, label:pick('実行時アドレス', 'Runtime address') });
        }
      }
      if (!opened) app.goToFileOffset(BigInt(result.fileOffset));
      const cache = response.cache || {};
      const extra = cache.uuid ? ` · UUID ${cache.uuid}` : '';
      toast(`${runtimeLabel(result)}${extra}`);
    } catch (error) {
      alertDialog(pick('実行時アドレスを開けません', 'Could not open runtime address'), String(error?.message || error));
    } finally {
      button.disabled = false;
      button.textContent = previousText;
    }
  });

  return Object.freeze({ button, sync, dispose:unsubscribe });
}
