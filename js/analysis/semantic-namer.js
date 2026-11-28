/**
 * Evidence-card aggregator and semantic function namer (Track T4).
 *
 * Pure zero-dependency ES module. Aggregates per-function evidence from:
 * - Tier 1 class ownership (`unifiedMetadata`, `cxxRtti`, `xrefLinks`)
 * - Virtual folder hierarchy (`virtualTree`)
 * - Function-local and sibling-method strings (`stringsByFunc`)
 * - API calls (`apisByFunc`)
 * - Crypto types / hints (`cryptoHints`, class/string/API crypto markers)
 * - State mutation / singleton writes (`rmw`, `x86Rmw`, `xrefLinks` tags)
 * - Callgraph caller owners (`callgraph`)
 *
 * Produces human-understandable "target + purpose" Japanese labels (`labelJa`),
 * English identifiers (`nameEn`), grounded `reasons`, and calibrated confidence
 * (`high` | `medium` | `low`). Never fabricates names when evidence is missing.
 */

const DEFAULT_MAX_FUNCTIONS = 250_000;
const MAX_OWN_STRINGS = 16;
const MAX_SIBLING_STRINGS = 12;
const MAX_CLASS_STRING_POOL = 24;
const MAX_API_CALLS = 16;
const MAX_CRYPTO_TYPES = 12;
const MAX_CALLER_OWNERS = 8;

const HEX_VA_RE = /^0[xX][0-9a-fA-F]+$/;
const DEC_VA_RE = /^[0-9]+$/;

const LOW_CONFIDENCE_LABEL_JA = '役割未確定の処理';
const EMPTY_ARR = Object.freeze([]);

function binarySearchBigInt(sortedArr, target) {
  let lo = 0;
  let hi = sortedArr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = sortedArr[mid];
    if (v === target) return true;
    if (v < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

class LazySemanticNameMap extends Map {
  constructor(emptyEvidence, defaultLowNaming) {
    super();
    this._emptyEvidence = emptyEvidence;
    this._defaultLowNaming = defaultLowNaming;
    this._unclassifiedAddrs = null;
    this._rttiByFunc = null;
    this._rttiCardBuilder = null;
    this._rttiLazyCount = 0;
    this._initialSuperKeys = null;
    this._tombstones = null;
    this._excludedLazy = null;
  }
  _attachUnclassified(rawAddrs) {
    if (!Array.isArray(rawAddrs) || rawAddrs.length === 0) {
      this._unclassifiedAddrs = null;
      return 0;
    }
    let strictlyAsc = true;
    let hasOverlap = false;
    let prev = -1n;
    const rttiMap = this._rttiByFunc;
    for (let i = 0; i < rawAddrs.length; i++) {
      const va = rawAddrs[i];
      if (typeof va !== 'bigint' || va < 0n || va <= prev) {
        strictlyAsc = false;
        break;
      }
      if (rttiMap !== null && rttiMap.has(va)) {
        hasOverlap = true;
        break;
      }
      prev = va;
    }
    if (strictlyAsc && !hasOverlap && super.size > 0) {
      for (const k of super.keys()) {
        if (binarySearchBigInt(rawAddrs, k)) { hasOverlap = true; break; }
      }
    }
    if (strictlyAsc && !hasOverlap) {
      this._unclassifiedAddrs = rawAddrs;
      return rawAddrs.length;
    }
    const filtered = [];
    for (let i = 0; i < rawAddrs.length; i++) {
      const va = rawAddrs[i];
      if (typeof va !== 'bigint' || va < 0n) continue;
      if (super.has(va) || (rttiMap !== null && rttiMap.has(va))) continue;
      filtered.push(va);
    }
    filtered.sort((a, b) => (a < b ? -1 : (a > b ? 1 : 0)));
    let w = 0;
    for (let r = 0; r < filtered.length; r++) {
      if (w === 0 || filtered[r] !== filtered[w - 1]) filtered[w++] = filtered[r];
    }
    filtered.length = w;
    this._unclassifiedAddrs = w > 0 ? filtered : null;
    return w;
  }
  _attachLazyRtti(rttiByFunc, cardBuilder, lazyCount) {
    this._rttiByFunc = rttiByFunc;
    this._rttiCardBuilder = cardBuilder;
    this._rttiLazyCount = lazyCount;
    this._initialSuperKeys = super.size > 0 ? new Set(super.keys()) : null;
  }
  _wasCountedInLazy(key) {
    if (
      this._rttiByFunc !== null
      && this._rttiByFunc.has(key)
      && (this._initialSuperKeys === null || !this._initialSuperKeys.has(key))
    ) {
      return true;
    }
    return this._unclassifiedAddrs !== null
      && typeof key === 'bigint'
      && binarySearchBigInt(this._unclassifiedAddrs, key);
  }
  _isLazyPresent(key) {
    if (this._tombstones !== null && this._tombstones.has(key)) return false;
    if (this._rttiByFunc !== null && this._rttiByFunc.has(key)) return true;
    return this._unclassifiedAddrs !== null
      && typeof key === 'bigint'
      && binarySearchBigInt(this._unclassifiedAddrs, key);
  }
  get size() {
    const excludedCount = this._excludedLazy ? this._excludedLazy.size : 0;
    return super.size
      + this._rttiLazyCount
      + (this._unclassifiedAddrs ? this._unclassifiedAddrs.length : 0)
      - excludedCount;
  }
  has(key) {
    if (super.has(key)) return true;
    return this._isLazyPresent(key);
  }
  get(key) {
    const v = super.get(key);
    if (v !== undefined) return v;
    if (this._tombstones !== null && this._tombstones.has(key)) return undefined;
    if (this._rttiByFunc !== null) {
      const rRef = this._rttiByFunc.get(key);
      if (rRef !== undefined) return this._rttiCardBuilder(key, rRef);
    }
    if (
      this._unclassifiedAddrs !== null
      && typeof key === 'bigint'
      && binarySearchBigInt(this._unclassifiedAddrs, key)
    ) {
      return new SemanticCard(key, null, 'Unclassified', null, this._emptyEvidence, this._defaultLowNaming);
    }
    return undefined;
  }
  set(key, value) {
    if (this._tombstones !== null) this._tombstones.delete(key);
    if (this._wasCountedInLazy(key)) {
      if (this._excludedLazy === null) this._excludedLazy = new Set();
      this._excludedLazy.add(key);
    }
    return super.set(key, value);
  }
  delete(key) {
    const hadSuper = super.delete(key);
    const countedLazy = this._wasCountedInLazy(key);
    const inRtti = this._rttiByFunc !== null && this._rttiByFunc.has(key);
    if (countedLazy) {
      const alreadyTombstoned = this._tombstones !== null && this._tombstones.has(key);
      if (!hadSuper && alreadyTombstoned) return false;
      if (this._tombstones === null) this._tombstones = new Set();
      this._tombstones.add(key);
      if (this._excludedLazy === null) this._excludedLazy = new Set();
      this._excludedLazy.add(key);
      return true;
    }
    if (hadSuper) {
      if (inRtti) {
        if (this._tombstones === null) this._tombstones = new Set();
        this._tombstones.add(key);
      }
      return true;
    }
    return false;
  }
  clear() {
    super.clear();
    this._unclassifiedAddrs = null;
    this._rttiByFunc = null;
    this._rttiCardBuilder = null;
    this._rttiLazyCount = 0;
    this._initialSuperKeys = null;
    this._tombstones = null;
    this._excludedLazy = null;
  }
  *keys() {
    yield* super.keys();
    if (this._rttiByFunc !== null) {
      for (const va of this._rttiByFunc.keys()) {
        if (!super.has(va) && (this._tombstones === null || !this._tombstones.has(va))) yield va;
      }
    }
    if (this._unclassifiedAddrs) {
      for (let i = 0; i < this._unclassifiedAddrs.length; i++) {
        const va = this._unclassifiedAddrs[i];
        if (!super.has(va) && (this._tombstones === null || !this._tombstones.has(va))) yield va;
      }
    }
  }
  *values() {
    yield* super.values();
    if (this._rttiByFunc !== null) {
      for (const [va, rRef] of this._rttiByFunc.entries()) {
        if (!super.has(va) && (this._tombstones === null || !this._tombstones.has(va))) yield this._rttiCardBuilder(va, rRef);
      }
    }
    if (this._unclassifiedAddrs) {
      for (let i = 0; i < this._unclassifiedAddrs.length; i++) {
        const va = this._unclassifiedAddrs[i];
        if (!super.has(va) && (this._tombstones === null || !this._tombstones.has(va))) {
          yield new SemanticCard(va, null, 'Unclassified', null, this._emptyEvidence, this._defaultLowNaming);
        }
      }
    }
  }
  *entries() {
    yield* super.entries();
    if (this._rttiByFunc !== null) {
      for (const [va, rRef] of this._rttiByFunc.entries()) {
        if (!super.has(va) && (this._tombstones === null || !this._tombstones.has(va))) yield [va, this._rttiCardBuilder(va, rRef)];
      }
    }
    if (this._unclassifiedAddrs) {
      for (let i = 0; i < this._unclassifiedAddrs.length; i++) {
        const va = this._unclassifiedAddrs[i];
        if (!super.has(va) && (this._tombstones === null || !this._tombstones.has(va))) {
          yield [va, new SemanticCard(va, null, 'Unclassified', null, this._emptyEvidence, this._defaultLowNaming)];
        }
      }
    }
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  forEach(cb, thisArg) {
    super.forEach(cb, thisArg);
    if (this._rttiByFunc !== null) {
      for (const [va, rRef] of this._rttiByFunc.entries()) {
        if (!super.has(va) && (this._tombstones === null || !this._tombstones.has(va))) {
          cb.call(thisArg, this._rttiCardBuilder(va, rRef), va, this);
        }
      }
    }
    if (this._unclassifiedAddrs) {
      for (let i = 0; i < this._unclassifiedAddrs.length; i++) {
        const va = this._unclassifiedAddrs[i];
        if (!super.has(va) && (this._tombstones === null || !this._tombstones.has(va))) {
          cb.call(thisArg, new SemanticCard(va, null, 'Unclassified', null, this._emptyEvidence, this._defaultLowNaming), va, this);
        }
      }
    }
  }
}

class SemanticCard {
  constructor(addr, ownerClass, folderPath, slotIndex, evidence, naming) {
    this.addr = addr;
    this.ownerClass = ownerClass;
    this.folderPath = folderPath;
    this.slotIndex = slotIndex;
    this.evidence = evidence;
    this.naming = naming;
  }
}

const GENERIC_CLASS_SEGMENTS = new Set([
  'game',
  'app',
  'core',
  'common',
  'system',
  'systems',
  'module',
  'modules',
  'service',
  'services',
  'manager',
  'mgr',
  'controller',
  'ctrl',
  'handler',
  'helper',
  'helpers',
  'util',
  'utils',
  'utility',
  'base',
  'abstract',
  'abstruct', // Intentional: common typo in real mobile binaries (e.g. Game::System::Coin::Abstruct)
  'interface',
  'iface',
  'impl',
  'detail',
  'internal',
  'private',
  'public',
  'default',
  'standard',
  'std',
  'objc',
  'roles',
  'root',
  'unclassified',
  'anonymous',
  'data',
  'model',
  'component',
  'object',
  'entity',
  'class',
  'type',
  'value',
  'info',
  'node',
  'itembase',
]);

const SUBJECT_PREFILTER_RE = /(?:coin|gem|diamond|crystal|jewel|stone|orb|gold|money|currency|wallet|cash|credit|stamina|energy|vitality|actionpoint|hp|health|hitpoint|life|mp|mana|magicpoint|damage|attack|atk|combat|weapon|skill|defense|def|armor|shield|score|point|exp|experience|level|rank|gacha|lottery|summon|loot|drop|reward|bonus|present|gift|shop|store|purchase|iap|billing|receipt|payment|product|item|inventory|bag|equip|deck|card|unit|character|chara|hero|quest|stage|mission|battle|dungeon|event|raid|arena|pvp|player|user|account|profile|member|save|storage|pref|cache|database|sqlite|archive|file|crypto|cipher|aes|sha|hmac|hash|key|token|auth|session|login|oauth|jwt|cheat|tamper|integrity|jailbreak|rootcheck|detect|guard|protect|network|http|socket|packet|request|response|api|server|sync|download|upload|audio|sound|bgm|voice|music|mixer|ui|view|window|dialog|popup|modal|button|menu|screen|hud|scene|canvas|render|ad|admob|applovin|ironsource|unityads|analytics|telemetry|tracking|firebase|adjust|appsflyer)/i;
const CRYPTO_PREFILTER_RE = /(?:crypto|aes|sha|hmac|md5|chacha|pbkdf|rsa|cccrypt|evp_|seckey|crc32|checksum|iv1,|cd1,)/i;

const SUBJECT_DICTIONARY = [
  { re: /\bcoin(?:s)?\b/i, ja: 'コイン', en: 'Coin' },
  { re: /\b(?:gem|gems|diamond|crystal|jewel|stone|orb)(?:s)?\b/i, ja: '課金石', en: 'Gem' },
  { re: /\b(?:gold|money|currency|wallet|cash|credit)(?:s)?\b/i, ja: '通貨', en: 'Currency' },
  { re: /\b(?:stamina|energy|vitality|actionpoint)\b/i, ja: 'スタミナ', en: 'Stamina' },
  { re: /\b(?:hp|health|hitpoint|life)\b/i, ja: '体力', en: 'Health' },
  { re: /\b(?:mp|mana|magicpoint)\b/i, ja: 'MP', en: 'Mana' },
  { re: /\b(?:damage|attack|atk|combat|weapon|skill)\b/i, ja: '戦闘・ダメージ', en: 'CombatDamage' },
  { re: /\b(?:defense|def|armor|shield)\b/i, ja: '防御ステータス', en: 'Defense' },
  { re: /\b(?:score|point|points|exp|experience|level|rank)\b/i, ja: 'スコア・成長値', en: 'Score' },
  { re: /\b(?:gacha|lottery|summon|loot|drop|reward|bonus|present|gift)\b/i, ja: 'ガチャ・報酬', en: 'Reward' },
  { re: /\b(?:shop|store|purchase|iap|billing|receipt|payment|product)\b/i, ja: '課金・ショップ', en: 'Purchase' },
  { re: /\b(?:item|inventory|bag|equip|equipment|deck|card|unit|character|chara|hero)\b/i, ja: 'アイテム・編成', en: 'Inventory' },
  { re: /\b(?:quest|stage|mission|battle|dungeon|event|raid|arena|pvp)\b/i, ja: 'クエスト・バトル', en: 'Battle' },
  { re: /\b(?:player|user|account|profile|member)\b/i, ja: 'プレイヤー情報', en: 'Player' },
  { re: /\b(?:save|savedata|storage|pref|prefs|preference|cache|database|sqlite|archive|file)\b/i, ja: 'セーブデータ', en: 'SaveData' },
  { re: /\b(?:crypto|cipher|aes|sha|hmac|hash|key|token|auth|session|login|oauth|jwt)\b/i, ja: '暗号・認証データ', en: 'CryptoAuth' },
  { re: /\b(?:cheat|anticheat|tamper|integrity|jailbreak|rootcheck|detect|guard|protect)\b/i, ja: '改ざん検知', en: 'Integrity' },
  { re: /\b(?:network|http|https|socket|packet|request|response|api|server|sync|download|upload)\b/i, ja: '通信データ', en: 'Network' },
  { re: /\b(?:audio|sound|bgm|voice|music|mixer)\b/i, ja: '音声', en: 'Audio' },
  { re: /\b(?:ui|view|window|dialog|popup|modal|button|menu|screen|hud|scene|canvas|render)\b/i, ja: '画面UI', en: 'UiView' },
  { re: /\b(?:ad|ads|admob|applovin|ironsource|unityads|analytics|telemetry|tracking|firebase|adjust|appsflyer)\b/i, ja: '広告・計測SDK', en: 'Analytics' },
];

const ROLE_FOLDER_SUBJECTS = new Map([
  ['network', { ja: '通信データ', en: 'Network' }],
  ['storage', { ja: '保存データ', en: 'Storage' }],
  ['ui', { ja: '画面UI', en: 'UiView' }],
  ['audio', { ja: '音声', en: 'Audio' }],
  ['crypto', { ja: '暗号データ', en: 'CryptoData' }],
  ['game', { ja: 'ゲーム状態', en: 'GameState' }],
]);

const CRYPTO_PATTERNS = [
  { re: /\bCrypto::[A-Za-z0-9_<>:]+/, extract: (m) => m[0] },
  { re: /\b(?:AES|aes)[_-]?(?:128|192|256)?(?:[_-]?(?:CBC|GCM|ECB|CTR))?\b/, label: 'AES' },
  { re: /\b(?:SHA[-_]?256|CC_SHA256)\b/i, label: 'SHA-256' },
  { re: /\b(?:SHA[-_]?512|CC_SHA512)\b/i, label: 'SHA-512' },
  { re: /\b(?:SHA[-_]?1|CC_SHA1)\b/i, label: 'SHA-1' },
  { re: /\b(?:HMAC|CCHmac)\b/i, label: 'HMAC' },
  { re: /\b(?:MD5|CC_MD5)\b/i, label: 'MD5' },
  { re: /\bChaCha20\b/i, label: 'ChaCha20' },
  { re: /\bPBKDF2\b/i, label: 'PBKDF2' },
  { re: /\bRSA\b/, label: 'RSA' },
  { re: /\b(?:CCCrypt|CCCryptor|EVP_Cipher|EVP_Encrypt|EVP_Decrypt|SecKey)\b/, extract: (m) => m[0] },
  { re: /\b(?:CRC32|checksum)\b/i, label: 'Checksum' },
  { re: /(?:^|[^A-Za-z0-9])iv1,|cd1,/, label: 'EncryptedValueFormat' },
];

const VERIFY_RE = /(?:^|[^A-Za-z0-9])(?:iv1,|cd1,|ne$|verify|valid(?:ate|ation)?|check(?:sum)?|integrity|tamper|mismatch|corrupt|invalid|signature|hmac|digest)/i;
const SAVE_RE = /(?:save|store|persist|write(?:tofile)?|commit|serialize|encode|setobject|userdefaults|nsuserdefaults|sqlite3_(?:exec|step)|fwrite|secitem(?:add|update)|keychain)/i;
const LOAD_RE = /(?:load|read|restore|deserialize|decode|parse|fetch|getobject|objectforkey|fread|fopen|sqlite3_column)/i;
const ENCRYPT_RE = /(?:encrypt|decrypt|cipher|cccrypt|evp_|seckey|obfuscate|deobfuscate|xor|crypto)/i;
const NETWORK_RE = /(?:https?:\/\/|nsurlsession|cfnetwork|urlrequest|sendrequest|post|socket|connect|recv|send|websocket|graphql|rest|endpoint)/i;
const PURCHASE_RE = /(?:skpayment|storekit|purchase|receipt|billing|iap|buy|transaction)/i;
const AUDIO_RE = /(?:avaudio|audioqueue|openal|fmod|criatom|playsound|playbgm|volume|soundeffect)/i;
const UI_RE = /(?:uiview|uiviewcontroller|calayer|uibutton|reloaddata|setneedsdisplay|drawrect|render|layoutsubviews|showdialog|presentview)/i;
const MUTATE_RE = /(?:add|sub|spend|consume|deduct|grant|reward|update|modify|setvalue|increment|decrement|clamp)/i;

const SINGLETON_WRITE_TAGS = new Set([
  'global_singleton_write',
  'singleton_write',
  'state_write',
  'rmw_field',
  'rmw_write',
]);

function toBigIntOrNull(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    if (!HEX_VA_RE.test(s) && !DEC_VA_RE.test(s)) return null;
    try {
      const b = BigInt(s);
      return b >= 0n ? b : null;
    } catch {
      return null;
    }
  }
  return null;
}

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function pushUniqueBounded(list, seen, value, maxLen) {
  if (list.length >= maxLen) return;
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (!trimmed || seen.has(trimmed)) return;
  seen.add(trimmed);
  list.push(trimmed);
}

function normalizeStringItems(raw) {
  if (raw == null) return [];
  const items = Array.isArray(raw) || raw instanceof Set ? raw : [raw];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (out.length >= MAX_OWN_STRINGS) break;
    let s = null;
    if (typeof item === 'string') s = item;
    else if (item && typeof item === 'object') {
      s = typeof item.text === 'string'
        ? item.text
        : (typeof item.value === 'string' ? item.value : (typeof item.str === 'string' ? item.str : null));
    }
    if (s != null) pushUniqueBounded(out, seen, s, MAX_OWN_STRINGS);
  }
  return out;
}

function normalizeApiItems(raw) {
  if (raw == null) return [];
  const items = Array.isArray(raw) || raw instanceof Set ? raw : [raw];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (out.length >= MAX_API_CALLS) break;
    let s = null;
    if (typeof item === 'string') s = item;
    else if (item && typeof item === 'object') {
      s = typeof item.name === 'string'
        ? item.name
        : (typeof item.api === 'string' ? item.api : (typeof item.symbol === 'string' ? item.symbol : null));
    }
    if (s != null) pushUniqueBounded(out, seen, s, MAX_API_CALLS);
  }
  return out;
}

function isFastBigIntMap(input) {
  if (!(input instanceof Map) || input.size === 0) return false;
  const first = input.keys().next();
  return !first.done && typeof first.value === 'bigint';
}

function normalizeFuncMap(input, valueTransform, allowDirectBigIntMap = false) {
  if (!input) return new Map();
  if (allowDirectBigIntMap && !valueTransform && isFastBigIntMap(input)) {
    return input;
  }
  const out = new Map();

  const ingest = (rawKey, rawVal) => {
    const va = toBigIntOrNull(rawKey);
    if (va == null) return;
    const val = valueTransform ? valueTransform(rawVal) : rawVal;
    if (val != null) out.set(va, val);
  };

  if (input instanceof Map) {
    for (const [k, v] of input.entries()) ingest(k, v);
  } else if (typeof input === 'object' && !Array.isArray(input)) {
    const keys = Object.keys(input);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      ingest(k, input[k]);
    }
  }
  return out;
}

function normalizeFunctionsToIntervals(functions) {
  const byStart = new Map();
  if (!functions) return [];

  const add = (rawStart, rawEnd, rawSize) => {
    const start = toBigIntOrNull(rawStart);
    if (start == null) return;
    let end = toBigIntOrNull(rawEnd);
    if (end == null || end <= start) {
      const sz = toBigIntOrNull(rawSize);
      end = (sz != null && sz > 0n) ? start + sz : null;
    }
    const existing = byStart.get(start);
    if (!existing) {
      byStart.set(start, { start, end });
    } else if (existing.end == null && end != null) {
      existing.end = end;
    }
  };

  const ingestList = (list) => {
    if (!list || typeof list.length !== 'number') return;
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      if (item == null) continue;
      if (typeof item === 'bigint' || typeof item === 'number' || typeof item === 'string') {
        add(item, null, null);
      } else if (typeof item === 'object') {
        add(item.start ?? item.va ?? item.addr ?? item.address, item.end, item.size);
      }
    }
  };

  if (Array.isArray(functions) || functions instanceof BigUint64Array || functions instanceof BigInt64Array) {
    ingestList(functions);
  } else if (typeof functions === 'object') {
    if (functions.symbols && typeof functions.symbols === 'object') {
      if (functions.symbols.funcs && typeof functions.symbols.funcs.length === 'number') {
        const funcs = functions.symbols.funcs;
        const ends = functions.symbols.funcEnds && functions.symbols.funcEnds.length === funcs.length
          ? functions.symbols.funcEnds
          : null;
        for (let i = 0; i < funcs.length; i += 1) {
          add(funcs[i], ends ? ends[i] : null, null);
        }
      }
    }
    if (functions.funcs && typeof functions.funcs.length === 'number') {
      const funcs = functions.funcs;
      const ends = functions.funcEnds && functions.funcEnds.length === funcs.length ? functions.funcEnds : null;
      for (let i = 0; i < funcs.length; i += 1) {
        add(funcs[i], ends ? ends[i] : null, null);
      }
    }
    if (Array.isArray(functions.functions)) {
      ingestList(functions.functions);
    } else if (typeof functions.functionList === 'function') {
      try {
        const list = functions.functionList(null, DEFAULT_MAX_FUNCTIONS);
        if (Array.isArray(list)) ingestList(list);
      } catch {
        // Fail-closed on custom symbol provider errors.
      }
    }
  }

  if (byStart.size === 0) return [];
  const intervals = Array.from(byStart.values());
  intervals.sort((a, b) => (a.start < b.start ? -1 : (a.start > b.start ? 1 : 0)));

  for (let i = 0; i < intervals.length; i += 1) {
    const fn = intervals[i];
    if (fn.end == null || fn.end <= fn.start) {
      if (i + 1 < intervals.length) {
        fn.end = intervals[i + 1].start;
      } else {
        fn.end = fn.start + 0x1000n;
      }
    }
  }
  return intervals;
}

function findContainingFunctionStart(intervals, va) {
  if (!intervals.length || va == null) return null;
  let lo = 0;
  let hi = intervals.length - 1;
  let cand = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (intervals[mid].start <= va) {
      cand = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (cand < 0) return null;
  const fn = intervals[cand];
  return va < fn.end ? fn.start : null;
}

function ingestRmwHits(rmwSource, textVaBig, intervals, rmwByFunc) {
  if (!rmwSource) return;
  const hits = Array.isArray(rmwSource)
    ? rmwSource
    : (Array.isArray(rmwSource.hits) ? rmwSource.hits : []);
  if (!hits.length) return;

  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i];
    if (!hit || typeof hit !== 'object') continue;

    let fnVa = toBigIntOrNull(hit.fnVa ?? hit.addr ?? hit.funcVa);
    if (fnVa == null) {
      const offRaw = hit.loadOff ?? hit.storeOff ?? hit.arithOff;
      const offBig = toBigIntOrNull(offRaw);
      if (offBig == null) continue;
      const insnVa = textVaBig + offBig;
      fnVa = findContainingFunctionStart(intervals, insnVa);
    }
    if (fnVa == null) continue;

    let agg = rmwByFunc.get(fnVa);
    if (!agg) {
      agg = { count: 0, clamped: false, isFloat: false };
      rmwByFunc.set(fnVa, agg);
    }
    agg.count += 1;
    if (hit.clamped) agg.clamped = true;
    if (hit.isFloat) agg.isFloat = true;
  }
}

function ingestCryptoHints(cryptoHints) {
  const byFunc = new Map();
  if (!cryptoHints) return byFunc;

  const addType = (va, label) => {
    if (va == null || typeof label !== 'string') return;
    const t = label.trim();
    if (!t) return;
    let list = byFunc.get(va);
    if (!list) {
      list = [];
      byFunc.set(va, list);
    }
    if (list.length < MAX_CRYPTO_TYPES && !list.includes(t)) {
      list.push(t);
    }
  };

  if (Array.isArray(cryptoHints)) {
    for (let i = 0; i < cryptoHints.length; i += 1) {
      const h = cryptoHints[i];
      if (!h || typeof h !== 'object') continue;
      const va = toBigIntOrNull(h.fnVa ?? h.addr ?? h.address ?? h.funcVa);
      const label = h.type ?? h.name ?? h.algo ?? h.id;
      addType(va, label);
    }
    return byFunc;
  }

  const mapSource = cryptoHints.byFunction ?? cryptoHints;
  const normalized = normalizeFuncMap(mapSource, (val) => {
    if (typeof val === 'string') return [val];
    if (Array.isArray(val) || val instanceof Set) {
      const out = [];
      for (const item of val) {
        if (typeof item === 'string') out.push(item);
        else if (item && typeof item === 'object') {
          const s = item.type ?? item.name ?? item.algo ?? item.id;
          if (typeof s === 'string') out.push(s);
        }
      }
      return out;
    }
    if (val && typeof val === 'object') {
      const s = val.type ?? val.name ?? val.algo ?? val.id;
      return typeof s === 'string' ? [s] : null;
    }
    return null;
  });

  for (const [va, list] of normalized.entries()) {
    for (let i = 0; i < list.length; i += 1) addType(va, list[i]);
  }
  return byFunc;
}

function buildCallerMap(callgraph) {
  const callersByCallee = new Map();
  if (!callgraph || typeof callgraph !== 'object') return callersByCallee;

  const addEdge = (callerVa, calleeVa) => {
    if (callerVa == null || calleeVa == null || callerVa === calleeVa) return;
    let set = callersByCallee.get(calleeVa);
    if (!set) {
      set = new Set();
      callersByCallee.set(calleeVa, set);
    }
    if (set.size < 32) set.add(callerVa);
  };

  if (callgraph instanceof Map) {
    for (const [rawCaller, callees] of callgraph.entries()) {
      const callerVa = toBigIntOrNull(rawCaller);
      if (callerVa == null || !callees) continue;
      if (Array.isArray(callees) || callees instanceof Set) {
        for (const rawCallee of callees) {
          addEdge(callerVa, toBigIntOrNull(rawCallee));
        }
      }
    }
    return callersByCallee;
  }

  const { nodes, edgeSrc, edgeDst } = callgraph;
  if (nodes && typeof nodes.length === 'number' && edgeSrc && edgeDst) {
    const nodeLen = nodes.length;
    const edgeLen = Math.min(edgeSrc.length, edgeDst.length);
    for (let i = 0; i < edgeLen; i += 1) {
      const u = edgeSrc[i];
      const v = edgeDst[i];
      if (u < 0 || u >= nodeLen || v < 0 || v >= nodeLen || u === v) continue;
      const callerVa = toBigIntOrNull(nodes[u]);
      const calleeVa = toBigIntOrNull(nodes[v]);
      addEdge(callerVa, calleeVa);
    }
  }
  return callersByCallee;
}

function splitTopLevelNamespace(className) {
  if (typeof className !== 'string' || !className) return [];
  if (className.indexOf('<') < 0) {
    if (className.indexOf('::') >= 0) return className.split('::').filter(Boolean);
    if (className.indexOf('.') >= 0) return className.split('.').filter(Boolean);
    return [className];
  }
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < className.length; i += 1) {
    const ch = className[i];
    if (ch === '<') depth += 1;
    else if (ch === '>' && depth > 0) depth -= 1;
    else if (depth === 0 && ch === ':' && className[i + 1] === ':') {
      const seg = className.slice(start, i).trim();
      if (seg) parts.push(seg);
      i += 1;
      start = i + 1;
    }
  }
  const tail = className.slice(start).trim();
  if (tail) parts.push(tail);
  if (parts.length === 1 && parts[0].includes('.')) {
    return parts[0].split('.').map((s) => s.trim()).filter(Boolean);
  }
  return parts;
}

function stripTemplateArgs(segment) {
  const idx = segment.indexOf('<');
  return idx > 0 ? segment.slice(0, idx) : segment;
}

function sanitizeEnIdentifier(text) {
  const cleaned = String(text || '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim();
  if (!cleaned) return 'Target';
  const words = cleaned.split(/\s+/);
  let out = '';
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (!w) continue;
    out += w[0].toUpperCase() + w.slice(1);
  }
  if (/^[0-9]/.test(out)) out = `Obj${out}`;
  return out.slice(0, 40) || 'Target';
}

function extractSubject(ownerClass, folderPath, ownStrings, apiCalls) {
  if (ownerClass) {
    const segs = splitTopLevelNamespace(ownerClass).map(stripTemplateArgs).filter(Boolean);
    // Search from most specific (right) to outer (left) for a meaningful domain token.
    for (let i = segs.length - 1; i >= 0; i -= 1) {
      const seg = segs[i];
      const lower = seg.toLowerCase();
      if (GENERIC_CLASS_SEGMENTS.has(lower)) continue;
      if (SUBJECT_PREFILTER_RE.test(seg)) {
        const tokenized = seg
          .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
          .replace(/[_-]+/g, ' ');
        for (let j = 0; j < SUBJECT_DICTIONARY.length; j += 1) {
          if (SUBJECT_DICTIONARY[j].re.test(tokenized)) {
            return { ja: SUBJECT_DICTIONARY[j].ja, en: SUBJECT_DICTIONARY[j].en, raw: seg };
          }
        }
      }
      return { ja: seg, en: sanitizeEnIdentifier(seg), raw: seg };
    }
    // Fallback to last segment even if generic.
    if (segs.length > 0) {
      const last = segs[segs.length - 1];
      return { ja: last, en: sanitizeEnIdentifier(last), raw: last };
    }
  }

  // Tier 2 role folder check (e.g. "Roles/Network", "Roles/Crypto").
  if (typeof folderPath === 'string' && folderPath) {
    const parts = folderPath.split('/').filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const hit = ROLE_FOLDER_SUBJECTS.get(parts[i].toLowerCase());
      if (hit) return { ja: hit.ja, en: hit.en, raw: parts[i] };
    }
  }

  // Infer subject from ownStrings / apiCalls if Tier 2 / direct evidence exists.
  const combined = `${ownStrings.join(' ')} ${apiCalls.join(' ')}`;
  if (combined.trim()) {
    for (let i = 0; i < SUBJECT_DICTIONARY.length; i += 1) {
      if (SUBJECT_DICTIONARY[i].re.test(combined)) {
        return { ja: SUBJECT_DICTIONARY[i].ja, en: SUBJECT_DICTIONARY[i].en, raw: null };
      }
    }
  }

  return { ja: 'データ', en: 'Data', raw: null };
}

function extractCryptoTypes(seedList, ownerClass, ownStrings, siblingStrings, apiCalls) {
  const out = [];
  const seen = new Set();
  if (Array.isArray(seedList)) {
    for (let i = 0; i < seedList.length; i += 1) {
      pushUniqueBounded(out, seen, seedList[i], MAX_CRYPTO_TYPES);
    }
  }

  const scanText = (text) => {
    if (typeof text !== 'string' || !text || out.length >= MAX_CRYPTO_TYPES) return;
    if (!CRYPTO_PREFILTER_RE.test(text)) return;
    for (let i = 0; i < CRYPTO_PATTERNS.length; i += 1) {
      const p = CRYPTO_PATTERNS[i];
      const m = p.re.exec(text);
      if (m) {
        const label = p.extract ? p.extract(m) : p.label;
        pushUniqueBounded(out, seen, label, MAX_CRYPTO_TYPES);
      }
    }
  };

  if (ownerClass) scanText(ownerClass);
  for (let i = 0; i < ownStrings.length; i += 1) scanText(ownStrings[i]);
  for (let i = 0; i < apiCalls.length; i += 1) scanText(apiCalls[i]);
  // Check sibling strings only for explicit namespace crypto types (e.g. Crypto::Value).
  for (let i = 0; i < siblingStrings.length; i += 1) {
    const m = /\bCrypto::[A-Za-z0-9_<>:]+/.exec(siblingStrings[i]);
    if (m) pushUniqueBounded(out, seen, m[0], MAX_CRYPTO_TYPES);
  }

  return out;
}

function detectPurposes({ ownStrings, siblingStrings, apiCalls, cryptoTypes, writesGlobalSingleton, rmwInfo, useSiblingFallback }) {
  const directText = `${ownStrings.join(' ')} ${apiCalls.join(' ')}`;
  const siblingText = useSiblingFallback ? siblingStrings.join(' ') : '';
  const text = directText.trim() ? directText : siblingText;

  const actions = [];
  const pushAction = (id, ja, enVerb) => {
    if (!actions.some((a) => a.id === id)) {
      actions.push({ id, ja, enVerb });
    }
  };

  const hasVerify = VERIFY_RE.test(text);
  const hasSave = writesGlobalSingleton || SAVE_RE.test(text);
  const hasLoad = LOAD_RE.test(text);
  const hasEncrypt = cryptoTypes.length > 0 && (ENCRYPT_RE.test(text) || (!hasVerify && !hasSave));
  const hasPurchase = PURCHASE_RE.test(text);
  const hasNetwork = NETWORK_RE.test(text);
  const hasAudio = AUDIO_RE.test(text);
  const hasUi = UI_RE.test(text);
  const hasMutate = Boolean(rmwInfo && rmwInfo.count > 0) || MUTATE_RE.test(text);

  if (hasPurchase) pushAction('purchase', '購入処理', 'purchase');
  if (hasVerify) pushAction('verify', '検証', 'verify');
  if (hasEncrypt) pushAction('crypto', '暗号化・復号', 'transformCrypto');
  if (hasSave) pushAction('save', '保存', 'save');
  else if (hasMutate) pushAction('update', rmwInfo?.clamped ? '上限付き更新' : '値の更新', 'update');
  if (hasLoad && !hasSave) pushAction('load', '読み込み', 'load');
  if (hasNetwork && actions.length < 2) pushAction('network', '通信送受信', 'syncNetwork');
  if (hasAudio && actions.length < 2) pushAction('audio', '音声制御', 'controlAudio');
  if (hasUi && actions.length < 2) pushAction('ui', '画面表示更新', 'updateUi');

  return actions;
}

function formatNaming({
  subject,
  actions,
  confidence,
  ownerClass,
  folderPath,
  ownStrings,
  siblingStrings,
  apiCalls,
  cryptoTypes,
  writesGlobalSingleton,
  rmwInfo,
  callerOwners,
  isShared,
  sharedOwners,
}) {
  const reasons = [];

  if (ownerClass) {
    reasons.push(`所属クラス: ${ownerClass}`);
  } else if (isShared && sharedOwners.length > 0) {
    reasons.push(`複数クラス共有メソッド: ${sharedOwners.slice(0, 3).join(', ')}`);
  } else if (folderPath && folderPath !== 'Unclassified') {
    reasons.push(`仮想フォルダ分類: ${folderPath}`);
  }
  if (ownStrings.length > 0) {
    reasons.push(`参照文字列: ${ownStrings.slice(0, 3).map((s) => `"${s}"`).join(', ')}`);
  }
  if (apiCalls.length > 0) {
    reasons.push(`呼び出しAPI: ${apiCalls.slice(0, 3).join(', ')}`);
  }
  if (cryptoTypes.length > 0) {
    reasons.push(`暗号・検証型: ${cryptoTypes.slice(0, 3).join(', ')}`);
  }
  if (writesGlobalSingleton) {
    reasons.push(rmwInfo && rmwInfo.count > 0
      ? `状態書き換え(RMW ${rmwInfo.count}件${rmwInfo.clamped ? '・クランプあり' : ''})`
      : 'グローバル状態・保存先への書き込み');
  }
  if (siblingStrings.length > 0 && ownStrings.length === 0) {
    reasons.push(`兄弟メソッド文脈: ${siblingStrings.slice(0, 2).map((s) => `"${s}"`).join(', ')}`);
  }
  if (callerOwners.length > 0) {
    reasons.push(`呼び出し元クラス: ${callerOwners.slice(0, 2).join(', ')}`);
  }

  // Strict anti-fabrication rule for low confidence.
  if (confidence === 'low') {
    if (reasons.length === 0) {
      reasons.push('直接的なクラス・文字列・API証拠が不足しているため推定を保留');
    }
    return {
      labelJa: LOW_CONFIDENCE_LABEL_JA,
      nameEn: null,
      confidence: 'low',
      reasons,
    };
  }

  if (actions.length >= 2) {
    const a1 = actions[0];
    const a2 = actions[1];
    const labelJa = `${subject.ja}の${a1.ja}と${a2.ja}`;
    const enSecond = a2.enVerb[0].toUpperCase() + a2.enVerb.slice(1);
    const nameEn = `${a1.enVerb}And${enSecond}${subject.en}`;
    return { labelJa, nameEn, confidence, reasons };
  }

  if (actions.length === 1) {
    const a1 = actions[0];
    const labelJa = `${subject.ja}の${a1.ja}`;
    const nameEn = `${a1.enVerb}${subject.en}`;
    return { labelJa, nameEn, confidence, reasons };
  }

  // No concrete action verb detected, but confidence is high/medium (e.g. Tier 1 owner or Tier 2 role).
  const labelJa = `${subject.ja}の処理`;
  const nameEn = `process${subject.en}`;
  return { labelJa, nameEn, confidence, reasons };
}

/**
 * Build per-function evidence cards and human-readable semantic names.
 *
 * @param {object} [opts]
 * @returns {{
 *   byFunction: Map<bigint, {
 *     addr: bigint,
 *     ownerClass: string | null,
 *     folderPath: string | null,
 *     slotIndex: number | null,
 *     evidence: {
 *       ownStrings: string[],
 *       siblingStrings: string[],
 *       apiCalls: string[],
 *       cryptoTypes: string[],
 *       writesGlobalSingleton: boolean,
 *       callerOwners: string[],
 *     },
 *     naming: {
 *       labelJa: string,
 *       nameEn: string | null,
 *       confidence: 'high' | 'medium' | 'low',
 *       reasons: string[],
 *     },
 *   }>,
 *   stats: {
 *     totalScored: number,
 *     highCount: number,
 *     mediumCount: number,
 *     lowCount: number,
 *     elapsedMs: number,
 *   },
 * }}
 */
export function buildSemanticNames(opts = {}) {
  const started = nowMs();
  const o = opts && typeof opts === 'object' ? opts : {};

  const virtualTree = o.virtualTree && typeof o.virtualTree === 'object' ? o.virtualTree : null;
  const unifiedMetadata = o.unifiedMetadata && typeof o.unifiedMetadata === 'object' ? o.unifiedMetadata : null;
  const cxxRtti = o.cxxRtti && typeof o.cxxRtti === 'object' ? o.cxxRtti : null;
  const xrefLinks = o.xrefLinks && typeof o.xrefLinks === 'object' ? o.xrefLinks : null;
  const textVaBig = toBigIntOrNull(o.textVa) ?? 0n;
  const maxFunctions = (typeof o.maxFunctions === 'number' && Number.isFinite(o.maxFunctions) && o.maxFunctions > 0)
    ? Math.floor(o.maxFunctions)
    : DEFAULT_MAX_FUNCTIONS;

  // 1. Normalize input maps and function intervals (only sort intervals when RMW hits need containment lookup).
  const hasRmwInput = Boolean(
    (Array.isArray(o.rmw) && o.rmw.length > 0)
    || (Array.isArray(o.rmw?.hits) && o.rmw.hits.length > 0)
    || (Array.isArray(o.x86Rmw) && o.x86Rmw.length > 0)
    || (Array.isArray(o.x86Rmw?.hits) && o.x86Rmw.hits.length > 0),
  );
  const intervals = hasRmwInput ? normalizeFunctionsToIntervals(o.functions) : [];
  const stringsMap = normalizeFuncMap(o.stringsByFunc, normalizeStringItems);
  const apisMap = normalizeFuncMap(o.apisByFunc, normalizeApiItems);
  const cryptoHintMap = ingestCryptoHints(o.cryptoHints);
  const xrefByFunc = normalizeFuncMap(xrefLinks?.byFunction ?? null, (v) => (v && typeof v === 'object' ? v : null));

  const rmwByFunc = new Map();
  if (hasRmwInput) {
    ingestRmwHits(o.rmw, textVaBig, intervals, rmwByFunc);
    ingestRmwHits(o.x86Rmw, textVaBig, intervals, rmwByFunc);
  }

  const callersByCallee = buildCallerMap(o.callgraph);

  // 2. Normalize ownership metadata maps (zero-copy when already Map<bigint, ...>).
  const unifiedMethods = isFastBigIntMap(unifiedMetadata?.methodsByFn)
    ? unifiedMetadata.methodsByFn
    : normalizeFuncMap(unifiedMetadata?.methodsByFn ?? null, (v) => (v && typeof v === 'object' ? v : null));
  const rttiByFunc = isFastBigIntMap(cxxRtti?.byFunction)
    ? cxxRtti.byFunction
    : normalizeFuncMap(cxxRtti?.byFunction ?? null, (v) => (v && typeof v === 'object' ? v : null));

  // Normalize virtualTree functionToFolderId (zero-copy when already Map<bigint, string>).
  const fnToFolderId = isFastBigIntMap(virtualTree?.functionToFolderId)
    ? virtualTree.functionToFolderId
    : normalizeFuncMap(virtualTree?.functionToFolderId ?? null, (v) => (typeof v === 'string' ? v : null));
  const treeNodes = virtualTree?.nodes instanceof Map ? virtualTree.nodes : null;

  // 3. Pre-aggregate class string pools for siblingStrings (only when stringsMap is non-empty).
  const classStringPool = new Map();
  const hasAnyStrings = stringsMap.size > 0;
  const hasAnyApis = apisMap.size > 0;
  const hasAnyCryptoHints = cryptoHintMap.size > 0;
  const hasAnyRmw = rmwByFunc.size > 0;
  const hasAnyXrefs = xrefByFunc.size > 0;
  const hasAnyCallers = callersByCallee.size > 0;
  const hasUnifiedMethods = unifiedMethods.size > 0;
  const hasRttiByFunc = rttiByFunc.size > 0;

  const resolveOwnerQuick = (va) => {
    const uRef = hasUnifiedMethods ? unifiedMethods.get(va) : undefined;
    const rRef = hasRttiByFunc ? rttiByFunc.get(va) : undefined;
    const xRef = hasAnyXrefs ? xrefByFunc.get(va) : undefined;
    const xCxx = xRef && typeof xRef.cxxClass === 'object' ? xRef.cxxClass : null;
    if (uRef && typeof uRef.className === 'string' && uRef.className) return uRef.className;
    if (rRef && typeof rRef.primaryOwner === 'string' && rRef.primaryOwner) return rRef.primaryOwner;
    if (xCxx && typeof xCxx.primaryOwner === 'string' && xCxx.primaryOwner) return xCxx.primaryOwner;
    return null;
  };

  if (hasAnyStrings) {
    for (const [va, ownStrs] of stringsMap.entries()) {
      if (!ownStrs || ownStrs.length === 0) continue;
      const ownerClass = resolveOwnerQuick(va);
      if (!ownerClass) continue;
      let pool = classStringPool.get(ownerClass);
      if (!pool) {
        pool = { list: [], seen: new Set() };
        classStringPool.set(ownerClass, pool);
      }
      for (let i = 0; i < ownStrs.length && pool.list.length < MAX_CLASS_STRING_POOL; i += 1) {
        pushUniqueBounded(pool.list, pool.seen, ownStrs[i], MAX_CLASS_STRING_POOL);
      }
    }
  }

  // Per-class caches to avoid redundant regex scans across 10k+ classes / 50k+ methods.
  const ownerSubjectCache = new Map();
  const ownerCryptoCache = new Map();
  const ownerMediumNamingCache = new Map();
  const getOwnerSubject = (ownerClass) => {
    let cached = ownerSubjectCache.get(ownerClass);
    if (!cached) {
      cached = extractSubject(ownerClass, null, [], []);
      ownerSubjectCache.set(ownerClass, cached);
    }
    return cached;
  };
  const getOwnerCrypto = (ownerClass) => {
    if (!CRYPTO_PREFILTER_RE.test(ownerClass)) return EMPTY_ARR;
    let cached = ownerCryptoCache.get(ownerClass);
    if (!cached) {
      cached = extractCryptoTypes(null, ownerClass, [], [], []);
      ownerCryptoCache.set(ownerClass, cached);
    }
    return cached;
  };

  // 5. Score and generate FunctionEvidenceCard for each function.
  const EMPTY_EVIDENCE = Object.freeze({
    ownStrings: EMPTY_ARR,
    siblingStrings: EMPTY_ARR,
    apiCalls: EMPTY_ARR,
    cryptoTypes: EMPTY_ARR,
    writesGlobalSingleton: false,
    callerOwners: EMPTY_ARR,
  });
  const DEFAULT_LOW_NAMING = Object.freeze({
    labelJa: LOW_CONFIDENCE_LABEL_JA,
    nameEn: null,
    confidence: 'low',
    reasons: Object.freeze(['直接的なクラス・文字列・API証拠が不足しているため推定を保留']),
  });
  const byFunction = new LazySemanticNameMap(EMPTY_EVIDENCE, DEFAULT_LOW_NAMING);
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;

  const scoreFunction = (va) => {
    if (va == null || byFunction.size >= maxFunctions || byFunction.has(va)) return;
    const uRef = hasUnifiedMethods ? (unifiedMethods.get(va) ?? null) : null;
    const rRef = hasRttiByFunc ? (rttiByFunc.get(va) ?? null) : null;
    const xRef = hasAnyXrefs ? (xrefByFunc.get(va) ?? null) : null;
    const xCxx = xRef && typeof xRef.cxxClass === 'object' ? xRef.cxxClass : null;

    let ownerClass = null;
    if (uRef && typeof uRef.className === 'string' && uRef.className) {
      ownerClass = uRef.className;
    } else if (rRef && typeof rRef.primaryOwner === 'string' && rRef.primaryOwner) {
      ownerClass = rRef.primaryOwner;
    } else if (xCxx && typeof xCxx.primaryOwner === 'string' && xCxx.primaryOwner) {
      ownerClass = xCxx.primaryOwner;
    }

    const folderId = fnToFolderId.get(va) ?? null;
    const treeNode = folderId && treeNodes ? (treeNodes.get(folderId) ?? null) : null;
    const folderPath = treeNode && typeof treeNode.fullPath === 'string' ? treeNode.fullPath : null;

    const ownStrings = hasAnyStrings ? (stringsMap.get(va) ?? EMPTY_ARR) : EMPTY_ARR;
    const apiCalls = hasAnyApis ? (apisMap.get(va) ?? EMPTY_ARR) : EMPTY_ARR;
    const rmwInfo = hasAnyRmw ? (rmwByFunc.get(va) ?? null) : null;
    const callerVas = hasAnyCallers ? callersByCallee.get(va) : undefined;
    const cryptoHint = hasAnyCryptoHints ? (cryptoHintMap.get(va) ?? null) : null;

    // Ultra-fast path for zero-evidence unclassified/low functions (common in stripped binaries).
    if (
      !ownerClass
      && (!treeNode || treeNode.source === 'unclassified')
      && ownStrings.length === 0
      && apiCalls.length === 0
      && !rmwInfo
      && !xRef
      && !callerVas
      && !cryptoHint
      && !uRef?.isShared
      && !rRef?.isShared
    ) {
      lowCount += 1;
      byFunction.set(va, {
        addr: va,
        ownerClass: null,
        folderPath,
        slotIndex: null,
        evidence: EMPTY_EVIDENCE,
        naming: DEFAULT_LOW_NAMING,
      });
      return;
    }

    let slotIndex = null;
    if (typeof uRef?.slotIndex === 'number' && Number.isInteger(uRef.slotIndex)) {
      slotIndex = uRef.slotIndex;
    } else if (typeof rRef?.slotIndex === 'number' && Number.isInteger(rRef.slotIndex)) {
      slotIndex = rRef.slotIndex;
    } else if (typeof xCxx?.slotIndex === 'number' && Number.isInteger(xCxx.slotIndex)) {
      slotIndex = xCxx.slotIndex;
    }

    // Fast path for Tier 1 class-owned methods with no direct strings/APIs/RMW/callers/hints.
    if (
      ownerClass
      && ownStrings.length === 0
      && apiCalls.length === 0
      && !rmwInfo
      && !xRef
      && !callerVas
      && !cryptoHint
      && !classStringPool.has(ownerClass)
    ) {
      const ownerCrypto = getOwnerCrypto(ownerClass);
      if (ownerCrypto.length === 0) {
        mediumCount += 1;
        let cachedNaming = ownerMediumNamingCache.get(ownerClass);
        if (!cachedNaming) {
          const subject = getOwnerSubject(ownerClass);
          cachedNaming = Object.freeze({
            labelJa: `${subject.ja}の処理`,
            nameEn: `process${subject.en}`,
            confidence: 'medium',
            reasons: Object.freeze([`所属クラス: ${ownerClass}`]),
          });
          ownerMediumNamingCache.set(ownerClass, cachedNaming);
        }
        byFunction.set(va, {
          addr: va,
          ownerClass,
          folderPath,
          slotIndex,
          evidence: EMPTY_EVIDENCE,
          naming: cachedNaming,
        });
        return;
      }
    }

    const isShared = Boolean(uRef?.isShared || rRef?.isShared || xCxx?.isShared);
    const sharedOwners = Array.isArray(uRef?.sharedOwners)
      ? uRef.sharedOwners
      : (Array.isArray(rRef?.sharedOwners)
        ? rRef.sharedOwners
        : (Array.isArray(xCxx?.sharedOwners) ? xCxx.sharedOwners : []));

    // Collect siblingStrings (excluding ownStrings).
    const siblingStrings = [];
    if (ownerClass) {
      const pool = classStringPool.get(ownerClass);
      if (pool && pool.list.length > 0) {
        const ownSet = ownStrings.length > 0 ? new Set(ownStrings) : null;
        for (let i = 0; i < pool.list.length && siblingStrings.length < MAX_SIBLING_STRINGS; i += 1) {
          const s = pool.list[i];
          if (!ownSet || !ownSet.has(s)) siblingStrings.push(s);
        }
      }
    }

    // Collect callerOwners from callgraph.
    const callerOwners = [];
    if (callerVas) {
      const callerOwnerSet = new Set();
      for (const cVa of callerVas) {
        if (callerOwners.length >= MAX_CALLER_OWNERS) break;
        const cOwner = resolveOwnerQuick(cVa);
        if (cOwner) pushUniqueBounded(callerOwners, callerOwnerSet, cOwner, MAX_CALLER_OWNERS);
      }
    }

    // Extract cryptoTypes.
    const cryptoTypes = (cryptoHint || ownStrings.length > 0 || siblingStrings.length > 0 || apiCalls.length > 0)
      ? extractCryptoTypes(cryptoHint, ownerClass, ownStrings, siblingStrings, apiCalls)
      : (ownerClass ? getOwnerCrypto(ownerClass).slice() : []);

    // Determine writesGlobalSingleton.
    let writesGlobalSingleton = Boolean(rmwInfo && rmwInfo.count > 0);
    if (!writesGlobalSingleton && xRef && Array.isArray(xRef.tags)) {
      for (let i = 0; i < xRef.tags.length; i += 1) {
        if (SINGLETON_WRITE_TAGS.has(xRef.tags[i])) {
          writesGlobalSingleton = true;
          break;
        }
      }
    }
    if (!writesGlobalSingleton && apiCalls.length > 0) {
      for (let i = 0; i < apiCalls.length; i += 1) {
        if (SAVE_RE.test(apiCalls[i])) {
          writesGlobalSingleton = true;
          break;
        }
      }
    }

    // Confidence calibration (strictly per Contract 5).
    const isTier1Tree = Boolean(
      treeNode
      && (treeNode.source === 'cxx-rtti' || treeNode.source === 'objc' || treeNode.source === 'swift'),
    );
    const hasTier1Owner = Boolean(ownerClass || isTier1Tree);
    const hasDirectEvidence = Boolean(
      ownStrings.length > 0
      || apiCalls.length > 0
      || cryptoTypes.length > 0
      || writesGlobalSingleton,
    );
    const isTier2Role = Boolean(
      treeNode
      && (treeNode.source === 'api-role' || treeNode.kind === 'role'),
    );
    const hasTier2OrStringEvidence = Boolean(isTier2Role || ownStrings.length > 0 || apiCalls.length > 0 || cryptoTypes.length > 0);

    let confidence;
    if (hasTier1Owner && hasDirectEvidence) {
      confidence = 'high';
      highCount += 1;
    } else if (hasTier1Owner || hasTier2OrStringEvidence) {
      confidence = 'medium';
      mediumCount += 1;
    } else {
      confidence = 'low';
      lowCount += 1;
    }

    const subject = ownerClass
      ? getOwnerSubject(ownerClass)
      : extractSubject(ownerClass, folderPath, ownStrings, apiCalls);
    const actions = confidence === 'low'
      ? []
      : detectPurposes({
          ownStrings,
          siblingStrings,
          apiCalls,
          cryptoTypes,
          writesGlobalSingleton,
          rmwInfo,
          useSiblingFallback: hasTier1Owner && !hasDirectEvidence,
        });

    const naming = formatNaming({
      subject,
      actions,
      confidence,
      ownerClass,
      folderPath,
      ownStrings,
      siblingStrings,
      apiCalls,
      cryptoTypes,
      writesGlobalSingleton,
      rmwInfo,
      callerOwners,
      isShared,
      sharedOwners,
    });

    byFunction.set(va, {
      addr: va,
      ownerClass,
      folderPath,
      slotIndex,
      evidence: {
        ownStrings: ownStrings === EMPTY_ARR ? [] : ownStrings,
        siblingStrings,
        apiCalls: apiCalls === EMPTY_ARR ? [] : apiCalls,
        cryptoTypes,
        writesGlobalSingleton,
        callerOwners,
      },
      naming,
    });
  };

  // Fast single-pass over fnToFolderId when no auxiliary evidence maps exist.
  const isPureRttiTreePass = fnToFolderId.size > 0
    && !hasUnifiedMethods
    && !hasAnyXrefs
    && !hasAnyStrings
    && !hasAnyApis
    && !hasAnyRmw
    && !hasAnyCallers
    && !hasAnyCryptoHints;

  if (isPureRttiTreePass) {
    // 1) Attach RTTI-owned functions lazily (O(N) stats tally without allocating 50k SemanticCards upfront).
    if (hasRttiByFunc && rttiByFunc.size <= maxFunctions) {
      const folderPathByOwner = new Map();
      const ownerIsCrypto = new Map();
      let lazyRttiCount = 0;

      const classifyPrimary = (va, ownerClass) => {
        if (typeof ownerClass === 'string' && ownerClass.length > 0) {
          let isCrypto = ownerIsCrypto.get(ownerClass);
          if (isCrypto === undefined) {
            isCrypto = CRYPTO_PREFILTER_RE.test(ownerClass) && getOwnerCrypto(ownerClass).length > 0;
            ownerIsCrypto.set(ownerClass, isCrypto);
          }
          if (!isCrypto) {
            mediumCount += 1;
            lazyRttiCount += 1;
            return;
          }
        }
        scoreFunction(va);
      };
      if (typeof rttiByFunc._forEachPrimary === 'function') {
        rttiByFunc._forEachPrimary(classifyPrimary);
      } else {
        for (const [va, rRef] of rttiByFunc.entries()) {
          classifyPrimary(va, rRef?.primaryOwner ?? null);
        }
      }

      if (lazyRttiCount > 0) {
        const buildLazyRttiCard = (va, rRef) => {
          const ownerClass = rRef.primaryOwner;
          let cachedNaming = ownerMediumNamingCache.get(ownerClass);
          if (!cachedNaming) {
            const subject = getOwnerSubject(ownerClass);
            cachedNaming = Object.freeze({
              labelJa: `${subject.ja}の処理`,
              nameEn: `process${subject.en}`,
              confidence: 'medium',
              reasons: Object.freeze([`所属クラス: ${ownerClass}`]),
            });
            ownerMediumNamingCache.set(ownerClass, cachedNaming);
          }
          let folderPath = folderPathByOwner.get(ownerClass);
          if (folderPath === undefined) {
            const fid = fnToFolderId.get(va) ?? null;
            folderPath = fid ? (treeNodes?.get(fid)?.fullPath ?? null) : null;
            folderPathByOwner.set(ownerClass, folderPath);
          }
          const slotIndex = (typeof rRef.slotIndex === 'number' && Number.isInteger(rRef.slotIndex))
            ? rRef.slotIndex
            : null;
          return new SemanticCard(va, ownerClass, folderPath, slotIndex, EMPTY_EVIDENCE, cachedNaming);
        };
        byFunction._attachLazyRtti(rttiByFunc, buildLazyRttiCard, lazyRttiCount);
      }
    } else if (hasRttiByFunc) {
      for (const va of rttiByFunc.keys()) scoreFunction(va);
    }
    // 2) Attach sorted Unclassified functions lazily in O(1) (zero Map inserts/allocs for 100k+ unclassified functions).
    const unclassNode = treeNodes ? treeNodes.get('Unclassified') : null;
    if (unclassNode && Array.isArray(unclassNode.functionAddrs) && unclassNode.functionAddrs.length > 0) {
      const addrs = unclassNode.functionAddrs;
      const avail = maxFunctions - byFunction.size;
      if (avail > 0) {
        const attached = addrs.length <= avail ? addrs : addrs.slice(0, avail);
        const actualCount = byFunction._attachUnclassified(attached);
        lowCount += actualCount;
      }
    }
    // 3) Cover any remaining tree entries (e.g. Shared/Role/ObjC/Swift).
    if (byFunction.size < fnToFolderId.size && byFunction.size < maxFunctions) {
      for (const va of fnToFolderId.keys()) {
        if (byFunction.size >= maxFunctions) break;
        if (!byFunction.has(va)) scoreFunction(va);
      }
    }
  }

  const treeCoversAllFunctions = isPureRttiTreePass
    && virtualTree?.truncated !== true
    && Array.isArray(o.functions)
    && fnToFolderId.size >= o.functions.length
    && byFunction.size >= o.functions.length;

  if (hasRmwInput) {
    for (let i = 0; i < intervals.length; i += 1) scoreFunction(intervals[i].start);
  } else if (o.functions && !treeCoversAllFunctions) {
    const scoreFnList = (list) => {
      if (!list || typeof list.length !== 'number') return;
      for (let i = 0; i < list.length && byFunction.size < maxFunctions; i += 1) {
        const item = list[i];
        if (typeof item === 'bigint') {
          if (item >= 0n) scoreFunction(item);
        } else if (item != null && typeof item === 'object') {
          scoreFunction(toBigIntOrNull(item.start ?? item.va ?? item.addr ?? item.address));
        } else {
          scoreFunction(toBigIntOrNull(item));
        }
      }
    };
    if (Array.isArray(o.functions) || o.functions instanceof BigUint64Array || o.functions instanceof BigInt64Array) {
      scoreFnList(o.functions);
    } else if (typeof o.functions === 'object') {
      if (o.functions.symbols?.funcs) scoreFnList(o.functions.symbols.funcs);
      if (o.functions.funcs) scoreFnList(o.functions.funcs);
      if (Array.isArray(o.functions.functions)) scoreFnList(o.functions.functions);
      else if (typeof o.functions.functionList === 'function') {
        try {
          const list = o.functions.functionList(null, maxFunctions);
          if (Array.isArray(list)) scoreFnList(list);
        } catch {
          // Fail-closed.
        }
      }
    }
  }
  if (!isPureRttiTreePass) {
    for (const va of unifiedMethods.keys()) scoreFunction(va);
    for (const va of rttiByFunc.keys()) scoreFunction(va);
    for (const va of fnToFolderId.keys()) scoreFunction(va);
  } else if (hasRttiByFunc && rttiByFunc.size > byFunction.size) {
    for (const va of rttiByFunc.keys()) scoreFunction(va);
  }
  for (const va of xrefByFunc.keys()) scoreFunction(va);
  for (const va of stringsMap.keys()) scoreFunction(va);
  for (const va of apisMap.keys()) scoreFunction(va);
  for (const va of cryptoHintMap.keys()) scoreFunction(va);
  for (const va of rmwByFunc.keys()) scoreFunction(va);

  return {
    byFunction,
    stats: {
      totalScored: byFunction.size,
      highCount,
      mediumCount,
      lowCount,
      elapsedMs: Math.round((nowMs() - started) * 100) / 100,
    },
  };
}
