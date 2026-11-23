/*
 * 「そのクラスは、このアプリが書いたものか。それとも組み込んだ SDK か」。
 *
 * 現代のモバイルゲームには、広告・計測・課金の SDK が 10 個も 20 個も入っている。
 * そして困ったことに、**名前が残っているのはたいてい SDK のほうだけ**になる。
 * ゲーム本体が C++（Cocos2d-x / Unity）で書かれていると、Objective-C のクラス表に
 * 出てくるのは広告 SDK ばかりで、ゲームのクラスは 1 つも載らない。
 *
 * この状態で「所持金はどこ？」と名前で探すと、こうなる:
 *
 *     LPMReward._amount          … 89.6% 確からしい
 *
 * これは LevelPlay（広告 SDK）の「動画を見た報酬の数」であって、
 * ゲームの所持金ではない。名前だけを見ると完璧に一致しているので、
 * 何もしないと **自信満々で間違える**。黙って外すのがいちばん危ない。
 *
 * そこでここでは「そのクラスがどのライブラリのものか」を先に決める。
 * 決め方は 2 段階:
 *
 *   1. 誰が見ても分かる名前で当てる（ironsource / applovin / vungle …）。
 *   2. 1 で当たったクラスの **接頭辞を、このバイナリ自身から学ぶ**。
 *      `ISBannerAdapter` が IronSource だと分かれば、`IS` で始まる 200 個の
 *      クラスもまとめて IronSource だと分かる。表に無い SDK にも効く。
 *
 * 日本語は作らない。返すのは分類だけ。
 */

/*
 * 見ればそれと分かる名前。ここに挙げたものは、ゲーム本体のクラス名としては
 * まず使われない（"vungle" という名前の自作クラスを書く人はいない）。
 */
const VENDOR_PATTERNS = [
  { vendor: 'IronSource', kind: 'ads', re: /ironsource|supersonic|levelplay/i },
  { vendor: 'AppLovin', kind: 'ads', re: /applovin|\bmax(mediation|adview|reward)/i },
  { vendor: 'Google Mobile Ads', kind: 'ads', re: /admob|googlemobileads|gadmob|interstitialad/i, textRe: /admob|googlemobileads|gadmob/i },
  { vendor: 'Unity Ads', kind: 'ads', re: /unityads|unityservices|unityanalytics/i },
  { vendor: 'Vungle', kind: 'ads', re: /vungle|liftoff/i },
  { vendor: 'Tapjoy', kind: 'ads', re: /tapjoy/i },
  { vendor: 'AdColony', kind: 'ads', re: /adcolony/i },
  { vendor: 'Chartboost', kind: 'ads', re: /chartboost/i },
  { vendor: 'Mintegral', kind: 'ads', re: /mintegral|mtgsdk/i },
  { vendor: 'Pangle', kind: 'ads', re: /pangle|bytedance|pangrowth/i },
  { vendor: 'InMobi', kind: 'ads', re: /inmobi/i },
  { vendor: 'Fyber', kind: 'ads', re: /fyber|digitalturbine/i },
  { vendor: 'Smaato', kind: 'ads', re: /smaato/i },
  { vendor: 'PubMatic', kind: 'ads', re: /pubmatic|openwrap/i },
  { vendor: 'Moloco', kind: 'ads', re: /moloco/i },
  { vendor: 'BidMachine', kind: 'ads', re: /bidmachine/i },
  { vendor: 'Ogury', kind: 'ads', re: /ogury/i },
  { vendor: 'Criteo', kind: 'ads', re: /criteo/i },
  { vendor: 'Meta Audience Network', kind: 'ads', re: /audiencenetwork|fbaudience|fbnativead|fbadwebkit/i },
  { vendor: 'Yandex Ads', kind: 'ads', re: /yandexmobileads/i },

  { vendor: 'Adjust', kind: 'analytics', re: /\badjust(sdk)?\b|adjustattribution/i, textRe: /\badjust(?:sdk|attribution|event|config|tracker)\b|adjust\.com|com\.adjust\./i },
  { vendor: 'AppsFlyer', kind: 'analytics', re: /appsflyer/i },
  { vendor: 'Branch', kind: 'analytics', re: /branchsdk|branchuniversal/i },
  { vendor: 'Singular', kind: 'analytics', re: /singularsdk/i },
  { vendor: 'Kochava', kind: 'analytics', re: /kochava/i },
  { vendor: 'Tenjin', kind: 'analytics', re: /tenjin/i },
  { vendor: 'Amplitude', kind: 'analytics', re: /amplitude/i, textRe: /amplitude(?:\.com|[\s._-]?(?:sdk|analytics|client|api|event|ios|android))|com\.amplitude\./i },
  { vendor: 'Mixpanel', kind: 'analytics', re: /mixpanel/i },
  { vendor: 'GameAnalytics', kind: 'analytics', re: /gameanalytics/i },
  { vendor: 'Flurry', kind: 'analytics', re: /flurry/i, textRe: /flurry(?:\.com|[\s._-]?(?:sdk|analytics|session|agent|ad))|com\.flurry\./i },
  { vendor: 'Adobe', kind: 'analytics', re: /adobemobile|adbmobile/i },
  { vendor: 'Firebase', kind: 'analytics', re: /firebase|\bfirapp\b|firanalytics|googleutilities|googledatatransport/i },
  { vendor: 'Crashlytics', kind: 'analytics', re: /crashlytics/i },
  { vendor: 'Sentry', kind: 'analytics', re: /sentrysdk|sentryclient/i },
  { vendor: 'Bugsnag', kind: 'analytics', re: /bugsnag/i },

  { vendor: 'Braze', kind: 'marketing', re: /\bappboy\b|brazekit/i },
  { vendor: 'Leanplum', kind: 'marketing', re: /leanplum/i },
  { vendor: 'Swrve', kind: 'marketing', re: /swrve/i },
  { vendor: 'OneSignal', kind: 'marketing', re: /onesignal/i },
  { vendor: 'Helpshift', kind: 'support', re: /helpshift/i },
  { vendor: 'Zendesk', kind: 'support', re: /zendesk/i },

  { vendor: 'Google Toolbox', kind: 'library', re: /gtmsession|gtmapp|googletoolbox/i },
  { vendor: 'Protocol Buffers', kind: 'library', re: /swiftprotobuf|google_protobuf/i },
  { vendor: 'Protocol Buffers', kind: 'library', re: /\bgoogle::protobuf\b|_ZN6google8protobuf|(?:^_?|\b)upb_/ },
  { vendor: 'AFNetworking', kind: 'library', re: /afnetworking|afhttp|afurl/i },
  { vendor: 'Alamofire', kind: 'library', re: /alamofire/i },
  { vendor: 'Realm', kind: 'library', re: /realmswift|rlmobject/i },

  /* 非衝突 C/C++ サードパーティライブラリ（std:: / _ZNSt / _ZSt / __cxa_ は登録しない） */
  { vendor: 'Boost', kind: 'library', re: /\bboost::|_ZN5boost/ },
  { vendor: 'FFmpeg', kind: 'library', re: /\blibav[a-z]*\b|^_?(?:av(?:codec|format|filter|util|io|packet|frame|dict|opt|log|pix|sample|hw|buf|mem)_|sws_|swr_|swri_)/ },
  { vendor: 'Qt', kind: 'library', re: /\b(?:QtCore|QtGui|QtWidgets|QtNetwork|QCoreApplication|QWidget|QSaveFile|QAbstract\w+|QXmlStream\w+|QIOS[A-Z][a-z]\w*|QUI[A-Z][a-z]\w*)\b|\bQtPrivate::/ },
  { vendor: 'SDL', kind: 'library', re: /^_?(?:SDL_|HIDAPI_)/ },
  { vendor: 'FreeType', kind: 'library', re: /^_?FTC?_/ },
  { vendor: 'SQLite', kind: 'library', re: /^_?sqlite3_/ },
  { vendor: 'OpenSSL', kind: 'library', re: /^_?(?:SSL|EVP|CRYPTO|OPENSSL|X509|ASN1|BIO|PEM|HMAC|OSSL|BORINGSSL)_|\bbssl::/ },
  { vendor: 'libpng', kind: 'library', re: /^_?png_(?:create|destroy|read|write|set|get)/ },
  { vendor: 'Skia', kind: 'library', re: /\bSk(?:Canvas|Paint|Bitmap|Image|Surface|Shader|Path)\b/ },
  { vendor: 'ICU', kind: 'library', re: /\bicu(?:_\d+)?::/ },
  { vendor: 'libcurl', kind: 'library', re: /^_?curl_(?:easy|multi|share|global)_/ },
  { vendor: 'gRPC', kind: 'library', re: /^_?grpc_|\bgrpc::/ },
  { vendor: 'double-conversion', kind: 'library', re: /\bdouble_conversion::/ },
  { vendor: 'TBB', kind: 'library', re: /\btbb::/ },

  /* Apple システム FW（C++ の C* クラスや UI* と衝突しない明示 API 列挙のみ） */
  { vendor: 'CoreFoundation', kind: 'library', re: /^_?CF(?:String|Array|Dictionary|Data|Number|URL|Bundle|RunLoop|Allocator|Release|Retain|Equal|Hash|Copy|GetTypeID|Preferences|Stream|ReadStream|WriteStream|Socket|NotificationCenter|Error|Date|TimeZone|Locale|Calendar|Set|Bag|Tree|BitVector|BinaryHeap|UUID|PlugIn|MachPort|MessagePort|FileDescriptor)\w*/ },
  { vendor: 'Metal', kind: 'library', re: /^_?MTL(?:Device|CommandQueue|CommandBuffer|CommandEncoder|RenderPipeline|ComputePipeline|Buffer|Texture|Sampler|Library|Function|Heap|Fence|Event)\w*/ },
  { vendor: 'CoreGraphics', kind: 'library', re: /^_?(?:CGContext|CGImage|CGColor|CGPath|CGBitmapContext)\w*/ },
  { vendor: 'AVFoundation', kind: 'library', re: /^_?AVAudio(?:Player|Engine|Session|Node|Format|PCMBuffer|Unit)\w*/ },
  { vendor: 'Darwin Runtime', kind: 'runtime', re: /^_?(?:dispatch_(?:async|sync|once|after|queue|group|semaphore|source|main)|objc_(?:msgSend|retain|release|autorelease|alloc|init|destroyWeak|loadWeak|storeWeak|copyWeak|getClass|lookUpClass|getAssociatedObject|setAssociatedObject)|pthread_(?:create|join|mutex|cond|rwlock|key|once|self|exit|attr))\w*/ },
];

/*
 * よく使われる接頭辞。Objective-C には名前空間が無いので、ライブラリは
 * ぶつからないように 2〜4 文字の大文字を全クラスに付ける、という決まりが定着している。
 * その決まりを逆に使う。ここに挙げたものは、実際に配布されている SDK のもの。
 *
 * ただし接頭辞は短く、偶然ぶつかりやすい（`IS` で始まる自作クラスはありうる）。
 * そこで **同じ接頭辞のクラスが 3 個以上あるとき** だけ SDK とみなす。
 */
const VENDOR_PREFIXES = {
  GAD: { vendor: 'Google Mobile Ads', kind: 'ads' },
  GAM: { vendor: 'Google Mobile Ads', kind: 'ads' },
  GADU: { vendor: 'Google Mobile Ads', kind: 'ads' },
  FIR: { vendor: 'Firebase', kind: 'analytics' },
  FIRCLS: { vendor: 'Crashlytics', kind: 'analytics' },
  GUL: { vendor: 'Firebase', kind: 'analytics' },
  GDT: { vendor: 'Firebase', kind: 'analytics' },
  APM: { vendor: 'Google App Measurement', kind: 'analytics' },
  GTM: { vendor: 'Google Toolbox', kind: 'library' },
  GTMR: { vendor: 'Google Toolbox', kind: 'library' },
  GIN: { vendor: 'Google Sign-In', kind: 'library' },
  GTLR: { vendor: 'Google API Client', kind: 'library' },
  GPB: { vendor: 'Protocol Buffers', kind: 'library' },
  FB: { vendor: 'Meta', kind: 'library' },
  FBSDK: { vendor: 'Meta', kind: 'library' },
  FBAD: { vendor: 'Meta Audience Network', kind: 'ads' },
  IS: { vendor: 'IronSource', kind: 'ads' },
  ISN: { vendor: 'IronSource', kind: 'ads' },
  ISA: { vendor: 'IronSource', kind: 'ads' },
  LPM: { vendor: 'IronSource LevelPlay', kind: 'ads' },
  AL: { vendor: 'AppLovin', kind: 'ads' },
  MA: { vendor: 'AppLovin MAX', kind: 'ads' },
  ALG: { vendor: 'AppLovin', kind: 'ads' },
  UAD: { vendor: 'Unity Ads', kind: 'ads' },
  UADS: { vendor: 'Unity Ads', kind: 'ads' },
  USRV: { vendor: 'Unity Services', kind: 'ads' },
  UMON: { vendor: 'Unity Monetization', kind: 'ads' },
  VG: { vendor: 'Vungle', kind: 'ads' },
  VNG: { vendor: 'Vungle', kind: 'ads' },
  TJ: { vendor: 'Tapjoy', kind: 'ads' },
  CB: { vendor: 'Chartboost', kind: 'ads' },
  CHB: { vendor: 'Chartboost', kind: 'ads' },
  MTG: { vendor: 'Mintegral', kind: 'ads' },
  BU: { vendor: 'Pangle', kind: 'ads' },
  PAG: { vendor: 'Pangle', kind: 'ads' },
  IM: { vendor: 'InMobi', kind: 'ads' },
  FY: { vendor: 'Fyber', kind: 'ads' },
  POB: { vendor: 'PubMatic', kind: 'ads' },
  SML: { vendor: 'Smaato', kind: 'ads' },
  OMID: { vendor: 'IAB Open Measurement', kind: 'ads' },
  OM: { vendor: 'IAB Open Measurement', kind: 'ads' },
  ADJ: { vendor: 'Adjust', kind: 'analytics' },
  AF: { vendor: 'AppsFlyer', kind: 'analytics' },
  BNC: { vendor: 'Branch', kind: 'analytics' },
  ADB: { vendor: 'Adobe', kind: 'analytics' },
  ABK: { vendor: 'Braze', kind: 'marketing' },
  OS: { vendor: 'OneSignal', kind: 'marketing' },
  LP: { vendor: 'Leanplum', kind: 'marketing' },
  HS: { vendor: 'Helpshift', kind: 'support' },
  BSG: { vendor: 'Bugsnag', kind: 'analytics' },
  SNTR: { vendor: 'Sentry', kind: 'analytics' },
  AMP: { vendor: 'Amplitude', kind: 'analytics' },
  AFN: { vendor: 'AFNetworking', kind: 'library' },
  RLM: { vendor: 'Realm', kind: 'library' },
  SD: { vendor: 'SDWebImage', kind: 'library' },
  MB: { vendor: 'MBProgressHUD', kind: 'library' },
};

/** ゲームの数値を探しているのに、SDK の値を答えてはいけない目的。 */
const GAME_VALUE_GOALS = new Set([
  'hp', 'attack', 'defense', 'damage', 'money', 'level', 'stamina',
  'item', 'score', 'gacha',
]);

/**
 * Swift の記号名から、それが属するモジュール（フレームワーク）名を取り出す。
 *
 *   _TtC12VungleAdsSDK14FirstPartyData  →  VungleAdsSDK
 *   $s12VungleAdsSDK14FirstPartyDataC   →  VungleAdsSDK
 *   $S10IronSource12AdControllerC       →  IronSource
 *   _T012VungleAdsSDK14FirstPartyDataC  →  VungleAdsSDK
 *
 * プレフィックスのあとは「長さ＋名前」の繰り返しになっている。最初の 1 個がモジュール。
 * 読めない形なら null（当てずっぽうの名前は返さない）。
 */
export function swiftModuleOf(name) {
  if (typeof name !== 'string') return null;
  const s = name;
  const m = /^(?:_TtC[VOP]?|_?\$[sS]|_?_T0)(\d+)/.exec(s);
  if (!m) return null;
  const len = Number(m[1]);
  if (!(len > 0) || len > 64) return null;
  const start = m[0].length;
  const mod = s.slice(start, start + len);
  return mod.length === len ? mod : null;
}

/**
 * 接頭辞になりうる並びを、長いほうから全部返す。
 *
 * `ISLWSProgRvManager` は `ISLWS` とも `IS` とも読める。片方だけ見ていると
 * IronSource の `IS` を取り逃がすので、2〜5 文字を全部候補に出して、
 * どれが実際にまとまっているかは数で決める。
 *
 * 先頭 `_` は剥がし、`UPPER_` 形式（例: `SDL_Init`）は `_` 手前を単一トークン（`SDL_`）
 * 扱いにして `SD` → `SDWebImage` のような誤分割や `SDLoader` との混同を防ぐ。
 */
function prefixesOf(name) {
  if (typeof name !== 'string') return [];
  const s = name.replace(/^_+/, '');
  if (!/^[A-Z]{2}/.test(s)) return [];
  const under = /^([A-Z]{2,})_/.exec(s);
  if (under) return under[1].length <= 5 ? [under[1] + '_'] : [];
  const out = [];
  for (let n = Math.min(5, s.length - 1); n >= 2; n--) {
    const head = s.slice(0, n);
    if (!/^[A-Z]+$/.test(head)) continue;
    const next = s[n];
    // 接頭辞の直後は「大文字＋小文字」か「大文字の続き」。数字始まりは採らない。
    if (!/[A-Za-z]/.test(next)) continue;
    out.push(head);
  }
  return out;
}

/** 名前そのものから当てる（第 1 段階）。 */
function matchPattern(name, opts) {
  if (typeof name !== 'string') return null;
  const s = name;
  const forText = !!(opts && opts.forText);
  for (const p of VENDOR_PATTERNS) {
    const rx = forText && p.textRe ? p.textRe : p.re;
    if (rx.test(s)) return { vendor: p.vendor, kind: p.kind, via: 'name' };
  }
  return null;
}

/** Itanium C++ マングル名の入れ子テンプレート引数 `I...E` を安全にスキップする。 */
function skipItaniumTemplate(s, pos) {
  if (s[pos] !== 'I') return pos;
  let i = pos + 1;
  let depth = 1;
  while (i < s.length && depth > 0) {
    const ch = s[i];
    if (ch >= '0' && ch <= '9') {
      let len = 0;
      while (i < s.length && s[i] >= '0' && s[i] <= '9') {
        len = len * 10 + (s.charCodeAt(i) - 48);
        i++;
      }
      if (len <= 0 || i + len > s.length) return -1;
      i += len;
      continue;
    }
    if (ch === 'L') {
      depth++;
      i++;
      if (i < s.length && s[i] >= 'a' && s[i] <= 'z') {
        i++;
        if (i < s.length && s[i] === 'n') i++;
        while (i < s.length && s[i] >= '0' && s[i] <= '9') i++;
      }
      continue;
    }
    if (ch === 'S' || ch === 'T') {
      i++;
      if (i < s.length && (s[i] === '_' || (ch === 'S' && s[i] >= 'a' && s[i] <= 'z'))) {
        i++;
      } else {
        while (i < s.length && s[i] !== '_') i++;
        if (i < s.length && s[i] === '_') i++;
      }
      continue;
    }
    if (ch === 'I' || ch === 'N' || ch === 'X' || ch === 'J') {
      depth++;
      i++;
      continue;
    }
    if (ch === 'E') {
      depth--;
      i++;
      continue;
    }
    i++;
  }
  return depth === 0 ? i : -1;
}

const ITANIUM_OPERATOR_CODES = new Set([
  'nw', 'na', 'dl', 'da', 'aw',
  'ps', 'ng', 'ad', 'de', 'co',
  'pl', 'mi', 'ml', 'dv', 'rm',
  'an', 'or', 'eo',
  'aS', 'pL', 'mI', 'mL', 'dV', 'rM', 'aN', 'oR', 'eO',
  'ls', 'rs', 'lS', 'rS',
  'eq', 'ne', 'lt', 'gt', 'le', 'ge', 'ss',
  'nt', 'aa', 'oo',
  'pp', 'mm',
  'cm', 'pm', 'pt', 'cl', 'ix', 'qu',
  'cv', 'li',
]);

/** Itanium C++ マングル名 `_ZN...` / `__ZN...` から所有者クラス名を取り出す。 */
function itaniumOwnerOf(name) {
  const m = /^_?_ZN[rVK]*[RO]?/.exec(name);
  if (!m) return null;
  let i = m[0].length;
  const parts = [];
  let isSpecialMember = false;
  while (i < name.length) {
    const ch = name[i];
    if (ch === 'E') break;
    if (ch === 'S' && name[i + 1] === 't') {
      parts.push('std');
      i += 2;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let len = 0;
      while (i < name.length && name[i] >= '0' && name[i] <= '9') {
        len = len * 10 + (name.charCodeAt(i) - 48);
        i++;
      }
      if (len <= 0 || i + len > name.length) return null;
      parts.push(name.slice(i, i + len));
      i += len;
      while (i < name.length && name[i] === 'B') {
        i++;
        let tagLen = 0;
        while (i < name.length && name[i] >= '0' && name[i] <= '9') {
          tagLen = tagLen * 10 + (name.charCodeAt(i) - 48);
          i++;
        }
        if (tagLen <= 0 || i + tagLen > name.length) return null;
        i += tagLen;
      }
      if (i < name.length && name[i] === 'I') {
        i = skipItaniumTemplate(name, i);
        if (i < 0) return null;
      }
      continue;
    }
    if ((ch === 'C' && (name[i + 1] === '1' || name[i + 1] === '2' || name[i + 1] === '3')) ||
        (ch === 'D' && (name[i + 1] === '0' || name[i + 1] === '1' || name[i + 1] === '2'))) {
      isSpecialMember = true;
      i += 2;
      if (i < name.length && name[i] === 'I') {
        i = skipItaniumTemplate(name, i);
        if (i < 0) return null;
      }
      break;
    }
    if (ch === 'C' && name[i + 1] === 'I' && (name[i + 2] === '1' || name[i + 2] === '2')) {
      isSpecialMember = true;
      i += 3;
      break;
    }
    if (i + 1 < name.length && ITANIUM_OPERATOR_CODES.has(name.slice(i, i + 2))) {
      isSpecialMember = true;
      i += 2;
      break;
    }
    if (ch === 'I') {
      i = skipItaniumTemplate(name, i);
      if (i < 0) return null;
      continue;
    }
    break;
  }
  if (isSpecialMember) return parts.length >= 1 ? parts.join('::') : null;
  return parts.length >= 2 ? parts.slice(0, -1).join('::') : null;
}

/** デマングル済み C++ 記号名 `ns::Cls::fn` から所有者クラス名を取り出す。 */
function demangledCxxOwnerOf(name) {
  if (!name.includes('::')) return null;
  let angle = 0;
  let paramStart = name.length;
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (ch === '<') angle++;
    else if (ch === '>' && angle > 0) angle--;
    else if (ch === '(' && angle === 0) {
      const before = name.slice(0, i).trimEnd();
      if (before.endsWith('operator') && name[i + 1] === ')') {
        i++;
        continue;
      }
      paramStart = i;
      break;
    }
  }
  let head = name.slice(0, paramStart).trim();
  if (!head.includes('::')) return null;

  // 先頭の戻り値型・修飾子（例: `void `, `std::string `）を外す
  angle = 0;
  let splitWs = -1;
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (ch === '<') angle++;
    else if (ch === '>' && angle > 0) angle--;
    else if ((ch === ' ' || ch === '\t') && angle === 0) {
      const before = head.slice(0, i).trimEnd();
      if (before.endsWith('operator')) continue;
      splitWs = i;
    }
  }
  if (splitWs >= 0) head = head.slice(splitWs + 1).trim();
  head = head.replace(/^[*&]+/, '');
  if (!head.includes('::')) return null;

  const parts = [];
  angle = 0;
  let segStart = 0;
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (ch === '<') angle++;
    else if (ch === '>' && angle > 0) angle--;
    else if (ch === ':' && head[i + 1] === ':' && angle === 0) {
      const seg = head.slice(segStart, i).trim();
      if (seg) parts.push(seg);
      i++;
      segStart = i + 1;
    }
  }
  const last = head.slice(segStart).trim();
  if (last) parts.push(last);
  return parts.length >= 2 ? parts.slice(0, -1).join('::') : null;
}

/**
 * `-[BattleManager hp]` → `BattleManager`、`ns::Cls::fn` → `ns::Cls`、
 * `_ZN2ns3Cls2fnEv` → `ns::Cls`。Objective-C / C++ の記号名から持ち主を取る。
 * その形でなければ null（当てずっぽうは返さない）。
 */
export function classFromSymbol(name) {
  if (typeof name !== 'string') return null;
  const objc = /^[-+]\s*\[\s*([^\s\]]+)/.exec(name);
  if (objc) return objc[1];
  const itanium = itaniumOwnerOf(name);
  if (itanium) return itanium;
  return demangledCxxOwnerOf(name);
}

/**
 * 名前でも文字列でもいいから、SDK の名前が中に出てくるか。
 *
 * クラス名が取れない相手（`sub_100B602CC` が `com.ironsource.healthcheck` を
 * 参照しているだけ、というよくある形）でも持ち主を言えるようにするための入口。
 * 当てるのは第 1 段階（誰が見ても分かる名前）だけ。接頭辞での推測はここではしない
 * ——「文字列の中にたまたま `IS` が入っていた」で SDK 扱いされては困るため。
 */
export function vendorInText(text) {
  const direct = matchPattern(text, { forText: true });
  return direct ? Object.assign({ confidence: 'high' }, direct) : null;
}

/**
 * このバイナリに入っているクラス名の一覧から、SDK の見分け方を学ぶ。
 *
 * 表に載っている名前で当たったクラスの接頭辞・モジュール名を集めて、
 * 「その接頭辞を持つクラスは、その SDK のもの」という規則をこのファイル用に作る。
 * ここが効くので、表に無い SDK でもクラスがまとまって除ける。
 *
 * @param {Iterable<string>} classNames
 * @returns {{prefixes:Map<string,object>, modules:Map<string,object>}}
 */
const PREFIX_MIN = 3;        // 名前の分かっている SDK を接頭辞で広げる下限
const CLUSTER_MIN = 10;      // 名前の分からないライブラリを、まとまりだけで見分ける下限

export function learnVendors(classNames) {
  const names = Array.from(classNames || []);
  const prefixCount = new Map();
  const moduleCount = new Map();
  for (const n of names) {
    for (const p of prefixesOf(n)) prefixCount.set(p, (prefixCount.get(p) || 0) + 1);
    const mod = swiftModuleOf(n);
    if (mod) moduleCount.set(mod, (moduleCount.get(mod) || 0) + 1);
  }

  const prefixes = new Map();
  const modules = new Map();

  /* 1. 名前の分かっている SDK。接頭辞の表と、実際に当たったクラスの両方から。 */
  const seed = (p, hit) => {
    if (!p || prefixes.has(p)) return;
    if ((prefixCount.get(p) || 0) < PREFIX_MIN) return;
    prefixes.set(p, Object.assign({}, hit, { via: 'prefix', prefix: p, confidence: 'high' }));
  };
  for (const [p, hit] of Object.entries(VENDOR_PREFIXES)) {
    seed(p, hit);
  }
  for (const n of names) {
    const hit = matchPattern(n);
    if (!hit) continue;
    const mod = swiftModuleOf(n);
    if (mod && !modules.has(mod)) {
      modules.set(mod, Object.assign({}, hit, { via: 'module', confidence: 'high' }));
    }
    // 未登録の2文字接頭辞は誤爆源（CF / FT / QU 等）になるため3文字以上のみ自動昇格
    for (const p of prefixesOf(n)) {
      const baseLen = p.endsWith('_') ? p.length - 1 : p.length;
      if (baseLen < 3 && !Object.hasOwn(VENDOR_PREFIXES, p)) continue;
      seed(p, hit);
    }
  }
  for (const [mod, n] of moduleCount) {
    if (n < 4 || modules.has(mod)) continue;
    const hit = matchPattern(mod);
    if (hit) modules.set(mod, Object.assign({}, hit, { via: 'module', confidence: 'high' }));
  }

  /*
   * 2. 名前は分からないが、**まとまり方がライブラリのそれ** であるもの。
   *
   * Objective-C には名前空間が無い。だから配布されるライブラリは、ぶつからないよう
   * 全クラスに同じ 2〜4 文字の大文字を付ける。アプリが自分のクラス 10 個以上に
   * 同じ接頭辞を律儀に付けることは、まず無い。この偏りだけで見分けられる。
   *
   * ただし名前で裏が取れていないぶん、確信は下げておく（打ち消しも弱くする）。
   */
  for (const [p, n] of prefixCount) {
    const baseLen = p.endsWith('_') ? p.length - 1 : p.length;
    if (n < CLUSTER_MIN || prefixes.has(p) || baseLen > 4) continue;
    prefixes.set(p, {
      vendor: p, kind: 'library', via: 'cluster', prefix: p,
      classes: n, confidence: 'low',
    });
  }
  return { prefixes, modules };
}

/*
 * 学習の結果は、クラス表 1 つにつき 1 回で足りる。
 * 目的 16 個を総当たりするたびに 3,000 クラスを学び直さないための memo。
 */
const LEARNED = new WeakMap();

/** クラス表（FieldIndex）から、学習済みの見分け方を取る。表が無ければ null。 */
export function vendorsOf(fields) {
  if (!fields || !fields.classes) return null;
  let learned = LEARNED.get(fields);
  if (!learned) {
    const names = [];
    for (const [k, v] of fields.classes.entries()) {
      const name = typeof v?.name === 'string' ? v.name : (typeof k === 'string' ? k : null);
      if (name) names.push(name);
    }
    learned = learnVendors(names);
    LEARNED.set(fields, learned);
  }
  return learned;
}

/**
 * クラス 1 つが、どのライブラリのものか。アプリ自身のものなら null。
 *
 * @param {string} className
 * @param {object} [learned] learnVendors の結果（あると精度が上がる）
 */
export function vendorOf(className, learned) {
  if (typeof className !== 'string' || !className) return null;
  const name = className;
  const direct = matchPattern(name);
  if (direct) return Object.assign({ confidence: 'high' }, direct);
  if (learned) {
    const mod = swiftModuleOf(name);
    if (mod && learned.modules && learned.modules.has(mod)) {
      return Object.assign({}, learned.modules.get(mod), { via: 'module', module: mod });
    }
    /*
     * `ISLWSProgRvManager` は `ISLWS` とも `IS` とも読める。どちらも当たったら、
     * 名前で裏の取れているほう（IronSource の `IS`）を採る。長さでは決めない。
     */
    const stripped = name.replace(/^_+/, '');
    let best = null;
    for (const p of prefixesOf(name)) {
      const hit = learned.prefixes ? learned.prefixes.get(p) : null;
      if (!hit) continue;
      if (!p.endsWith('_') && !Object.hasOwn(VENDOR_PREFIXES, p) && !/[a-z]/.test(stripped.slice(p.length))) {
        continue;
      }
      if (!best || (best.confidence !== 'high' && hit.confidence === 'high')) {
        best = Object.assign({}, hit, { via: hit.via, prefix: p });
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * その目的にとって、そのライブラリのクラスは「答えになりうる」か。
 *
 * 広告の SDK は、広告のことを調べているなら正しい答えになる。
 * ゲームの数値（HP・攻撃力・所持金）を調べているときだけ外す。
 */
export function vendorConflicts(goalId, vendor) {
  if (!vendor) return false;
  if (!GAME_VALUE_GOALS.has(goalId)) return false;
  if (vendor.via === 'cluster' || vendor.confidence === 'low') return false;
  return true;
}
