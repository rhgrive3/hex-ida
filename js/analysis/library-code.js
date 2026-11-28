/*
 * Library code classification for folding.
 *
 * A function is library code when its owner class or its own name matches a
 * known SDK / runtime / C++ standard library. Unnamed functions are never
 * classified (no guessing). User-renamed functions are never folded.
 */
import { vendorsOf, vendorOf, classFromSymbol } from '../vendors.js';

const STD_RE = /^_?(?:_ZN?K?St|_ZSt|_ZNKSt|__cxa_|__gxx_|__cxxabiv1|_Unwind_|__clang_|__ubsan_|__asan_)|^(?:std::|__cxxabiv1::|__gnu_cxx::|operator (?:new|delete)\b)/;
const STUB_RE = /^(?:j_|_?objc_msgSend\$)/;
/* Well-known open-source / engine glue classes missing from vendors.js. Folding only. */
const EXTRA_CLASSES = [
  { vendor: 'CocosDenshion', kind: 'engine', re: /^(?:SimpleAudioEngine|CD(?:AudioManager|SoundEngine|SoundSource|LongAudioSource|BufferManager|AsynchInitialiser|AudioInterruptTargetGroup|SoundEngineFX|PropertyModifier\w*|SoundSourceFader|SoundSourcePanner|SoundSourcePitchBender|SoundEngineSoundSource\w*))$/ },
  { vendor: 'Cocos2d-x', kind: 'engine', re: /^(?:CCEAGLView|EAGLView|CCES2Renderer|CCDirectorCaller|EditBoxImplIOS|UIEditBoxImplIOS|CCEditBoxImplIOS|UIWebViewWrapper|UIVideoViewWrapperIos|CCUITextInput)$/ },
  { vendor: 'UICKeyChainStore', kind: 'library', re: /^UICKeyChainStore\w*$/ },
  { vendor: 'Reachability', kind: 'library', re: /^Reachability$/ },
  { vendor: 'LIAPP', kind: 'library', re: /^Liapp[A-Z]\w*$/ },
];
const YIELD_EVERY = 4096;
const cache = new WeakMap();

export const LIBRARY_KIND_LABELS = Object.freeze({
  ads: ['広告 SDK', 'Ads SDK'],
  analytics: ['計測 SDK', 'Analytics SDK'],
  marketing: ['マーケティング SDK', 'Marketing SDK'],
  support: ['サポート SDK', 'Support SDK'],
  purchase: ['課金 SDK', 'Purchase SDK'],
  library: ['ライブラリ', 'Library'],
  engine: ['ゲームエンジン', 'Game engine'],
  runtime: ['実行環境', 'Runtime'],
  system: ['OS', 'OS'],
  crypto: ['暗号ライブラリ', 'Crypto library'],
  media: ['描画ライブラリ', 'Graphics library'],
  test: ['テスト', 'Test'],
  stdlib: ['C++ 標準ライブラリ', 'C++ standard library'],
});

function toBig(value) {
  if (typeof value === 'bigint') return value;
  try { return BigInt(value); } catch { return null; }
}

function learnedOf(app) {
  try { return app?.fields ? vendorsOf(app.fields) : null; } catch { return null; }
}

function isUserRenamed(symbols, addr) {
  const renames = symbols?.renames;
  return renames instanceof Map && renames.has(addr.toString());
}

/** Classify one class name. Returns null for app code. */
export function classifyClassName(app, className, learned = learnedOf(app)) {
  if (typeof className !== 'string' || !className) return null;
  if (STD_RE.test(className)) return { vendor: 'C++ std', kind: 'stdlib', confidence: 'high', via: 'name', owner: className };
  for (const extra of EXTRA_CLASSES) {
    if (extra.re.test(className)) return { vendor: extra.vendor, kind: extra.kind, confidence: 'high', via: 'name', owner: className };
  }
  const hit = vendorOf(className, learned);
  return hit ? { vendor: hit.vendor, kind: hit.kind, confidence: hit.confidence || 'high', via: hit.via || 'name', owner: className } : null;
}

function classifyName(name, learned) {
  if (typeof name !== 'string' || !name || /^sub_[0-9a-f]+$/i.test(name)) return null;
  if (STD_RE.test(name)) return { vendor: 'C++ std', kind: 'stdlib', confidence: 'high', via: 'name', owner: null };
  const owner = classFromSymbol(name);
  if (owner) {
    if (STD_RE.test(owner) || owner === 'std' || owner.startsWith('std::')) {
      return { vendor: 'C++ std', kind: 'stdlib', confidence: 'high', via: 'name', owner };
    }
    const byOwner = vendorOf(owner, learned);
    if (byOwner) return { vendor: byOwner.vendor, kind: byOwner.kind, confidence: byOwner.confidence || 'high', via: byOwner.via || 'name', owner };
    const extra = EXTRA_CLASSES.find((x) => x.re.test(owner));
    if (extra) return { vendor: extra.vendor, kind: extra.kind, confidence: 'high', via: 'name', owner };
  }
  const direct = vendorOf(name.replace(STUB_RE, ''), learned);
  if (direct) return { vendor: direct.vendor, kind: direct.kind, confidence: direct.confidence || 'high', via: direct.via || 'name', owner };
  return null;
}

function classifyAt(app, addr, learned) {
  const symbols = app?.symbols;
  if (!symbols || isUserRenamed(symbols, addr)) return null;
  const owners = app?.fields?.ownersOf?.(addr) || [];
  if (owners.length) {
    let first = null;
    for (const owner of owners) {
      const hit = classifyClassName(app, owner?.className, learned);
      if (!hit) return null; // shared IMP with app code: keep visible
      if (!first) first = { ...hit, via: 'objc-class' };
    }
    return first;
  }
  let name = null;
  try { name = symbols.nameAt?.(addr) ?? null; } catch { name = null; }
  return classifyName(name, learned);
}

/** Library info for one function, or null. Cheap; safe for render paths. */
export function libraryInfoAt(app, addr) {
  const big = toBig(addr);
  if (big == null) return null;
  return classifyAt(app, big, learnedOf(app));
}

/** Folding hides only confident results. 'low' stays visible. */
export function isFoldable(info) {
  return Boolean(info && info.confidence !== 'low');
}

export function libraryKindLabel(kind, ja = true) {
  const label = LIBRARY_KIND_LABELS[kind] || LIBRARY_KIND_LABELS.library;
  return ja ? label[0] : label[1];
}

function abortError() {
  const error = new Error('Library classification aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Classify every function once per (symbols generation, fields).
 * Result: { folded:Set<string>, byAddr:Map<string,info>, vendors:Map<string,number>, total, foldedCount }
 */
export async function libraryIndexFor(app, { signal = null } = {}) {
  const symbols = app?.symbols;
  const funcs = symbols?.funcs;
  if (!symbols || !funcs || !Number.isSafeInteger(funcs.length)) return emptyIndex();
  const gen = symbols.gen ?? 0;
  const fields = app.fields || null;
  const cached = cache.get(symbols);
  if (cached && cached.gen === gen && cached.fields === fields) return cached.index;
  const learned = learnedOf(app);
  const folded = new Set();
  const byAddr = new Map();
  const vendors = new Map();
  for (let i = 0; i < funcs.length; i++) {
    if ((i % YIELD_EVERY) === 0 && i) {
      if (signal?.aborted) throw abortError();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted) throw abortError();
      if ((symbols.gen ?? 0) !== gen) return libraryIndexFor(app, { signal });
    }
    const addr = toBig(funcs[i]);
    if (addr == null) continue;
    const info = classifyAt(app, addr, learned);
    if (!info) continue;
    const key = addr.toString();
    byAddr.set(key, info);
    if (isFoldable(info)) {
      folded.add(key);
      vendors.set(info.vendor, (vendors.get(info.vendor) || 0) + 1);
    }
  }
  const index = { folded, byAddr, vendors, total: funcs.length, foldedCount: folded.size };
  cache.set(symbols, { gen, fields, index });
  return index;
}

function emptyIndex() {
  return { folded: new Set(), byAddr: new Map(), vendors: new Map(), total: 0, foldedCount: 0 };
}

const RECOGNITION_CLASS = Object.freeze({
  system: 'SYSTEM', runtime: 'RUNTIME',
  stdlib: 'LIBRARY', library: 'LIBRARY', engine: 'LIBRARY', crypto: 'LIBRARY', media: 'LIBRARY',
});

/** Context for recognition/classifier.js classifyFunction(input, context). */
export function recognitionVendorContext(app, addr) {
  const info = libraryInfoAt(app, addr);
  if (!isFoldable(info)) return { notKnownVendor: true };
  return {
    vendor: {
      vendor: info.vendor,
      kind: info.kind,
      confidence: info.confidence,
      classification: RECOGNITION_CLASS[info.kind] || 'SDK',
      evidence: [`vendor:${info.vendor}`],
    },
  };
}
