/**
 * Unified UI-independent virtual folder tree builder for C++ RTTI, ObjC, Swift,
 * role-based (API/string), callgraph-propagated, and unclassified functions.
 *
 * Pure JS module with zero static imports from other analysis tracks.
 * All internal function keys are BigInt; all dictionaries use Map to prevent
 * prototype pollution.
 */

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

class LazyFolderMap extends Map {
  constructor() {
    super();
    this._unclassifiedAddrs = null;
    this._unclassifiedId = null;
    this._rttiByFn = null;
    this._rttiFolderCache = null;
    this._rttiLazyCount = 0;
    this._deleted = null;
  }
  _attachUnclassified(sortedAddrs, folderId) {
    this._unclassifiedAddrs = sortedAddrs;
    this._unclassifiedId = folderId;
  }
  _attachLazyRtti(rttiByFn, folderNodeCache, lazyCount) {
    this._rttiByFn = rttiByFn;
    this._rttiFolderCache = folderNodeCache;
    this._rttiLazyCount = lazyCount;
  }
  _resolveLazyRttiFolderId(key) {
    if (this._rttiByFn === null) return undefined;
    const link = this._rttiByFn.get(key);
    if (link && typeof link.primaryOwner === 'string' && link.primaryOwner) {
      const node = this._rttiFolderCache.get(link.primaryOwner);
      if (node) return node.id;
    }
    return undefined;
  }
  _isLazyPresent(key) {
    if (this._deleted !== null && this._deleted.has(key)) return false;
    if (this._resolveLazyRttiFolderId(key) !== undefined) return true;
    return this._unclassifiedAddrs !== null
      && typeof key === 'bigint'
      && binarySearchBigInt(this._unclassifiedAddrs, key);
  }
  get size() {
    const deletedCount = this._deleted ? this._deleted.size : 0;
    return super.size
      + this._rttiLazyCount
      + (this._unclassifiedAddrs ? this._unclassifiedAddrs.length : 0)
      - deletedCount;
  }
  _superHas(key) { return super.has(key); }
  _hasAssigned(key) {
    if (super.has(key)) return true;
    if (this._deleted !== null && this._deleted.has(key)) return false;
    return this._resolveLazyRttiFolderId(key) !== undefined;
  }
  has(key) {
    if (super.has(key)) return true;
    return this._isLazyPresent(key);
  }
  get(key) {
    const v = super.get(key);
    if (v !== undefined) return v;
    if (this._deleted !== null && this._deleted.has(key)) return undefined;
    const rttiId = this._resolveLazyRttiFolderId(key);
    if (rttiId !== undefined) return rttiId;
    if (
      this._unclassifiedAddrs !== null
      && typeof key === 'bigint'
      && binarySearchBigInt(this._unclassifiedAddrs, key)
    ) {
      return this._unclassifiedId;
    }
    return undefined;
  }
  set(key, value) {
    if (!super.has(key) && this._isLazyPresent(key)) {
      if (this._deleted === null) this._deleted = new Set();
      this._deleted.add(key);
    }
    return super.set(key, value);
  }
  delete(key) {
    const deletedSuper = super.delete(key);
    if (this._isLazyPresent(key)) {
      if (this._deleted === null) this._deleted = new Set();
      this._deleted.add(key);
      return true;
    }
    return deletedSuper;
  }
  clear() {
    super.clear();
    this._unclassifiedAddrs = null;
    this._unclassifiedId = null;
    this._rttiByFn = null;
    this._rttiFolderCache = null;
    this._rttiLazyCount = 0;
    this._deleted = null;
  }
  *keys() {
    yield* super.keys();
    if (this._rttiByFn !== null) {
      for (const [va, link] of this._rttiByFn.entries()) {
        if (super.has(va) || (this._deleted !== null && this._deleted.has(va))) continue;
        const node = link?.primaryOwner ? this._rttiFolderCache.get(link.primaryOwner) : null;
        if (node) yield va;
      }
    }
    if (this._unclassifiedAddrs) {
      for (let i = 0; i < this._unclassifiedAddrs.length; i++) {
        const va = this._unclassifiedAddrs[i];
        if (super.has(va) || (this._deleted !== null && this._deleted.has(va))) continue;
        yield va;
      }
    }
  }
  *values() {
    yield* super.values();
    if (this._rttiByFn !== null) {
      for (const [va, link] of this._rttiByFn.entries()) {
        if (super.has(va) || (this._deleted !== null && this._deleted.has(va))) continue;
        const node = link?.primaryOwner ? this._rttiFolderCache.get(link.primaryOwner) : null;
        if (node) yield node.id;
      }
    }
    if (this._unclassifiedAddrs) {
      const id = this._unclassifiedId;
      for (let i = 0; i < this._unclassifiedAddrs.length; i++) {
        const va = this._unclassifiedAddrs[i];
        if (super.has(va) || (this._deleted !== null && this._deleted.has(va))) continue;
        yield id;
      }
    }
  }
  *entries() {
    yield* super.entries();
    if (this._rttiByFn !== null) {
      for (const [va, link] of this._rttiByFn.entries()) {
        if (super.has(va) || (this._deleted !== null && this._deleted.has(va))) continue;
        const node = link?.primaryOwner ? this._rttiFolderCache.get(link.primaryOwner) : null;
        if (node) yield [va, node.id];
      }
    }
    if (this._unclassifiedAddrs) {
      const id = this._unclassifiedId;
      for (let i = 0; i < this._unclassifiedAddrs.length; i++) {
        const va = this._unclassifiedAddrs[i];
        if (super.has(va) || (this._deleted !== null && this._deleted.has(va))) continue;
        yield [va, id];
      }
    }
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  forEach(cb, thisArg) {
    super.forEach(cb, thisArg);
    if (this._rttiByFn !== null) {
      for (const [va, link] of this._rttiByFn.entries()) {
        if (super.has(va) || (this._deleted !== null && this._deleted.has(va))) continue;
        const node = link?.primaryOwner ? this._rttiFolderCache.get(link.primaryOwner) : null;
        if (node) cb.call(thisArg, node.id, va, this);
      }
    }
    if (this._unclassifiedAddrs) {
      const id = this._unclassifiedId;
      for (let i = 0; i < this._unclassifiedAddrs.length; i++) {
        const va = this._unclassifiedAddrs[i];
        if (super.has(va) || (this._deleted !== null && this._deleted.has(va))) continue;
        cb.call(thisArg, id, va, this);
      }
    }
  }
}

const ROOT_ID = 'root';
const UNCLASSIFIED_ID = 'Unclassified';
const DEFAULT_MAX_NODES = 250000;
const DEFAULT_MAX_DEPTH = 32;
const UTILITY_HUB_CALLER_LIMIT = 16;
const MAX_CALLGRAPH_HOPS = 2;

const ROLE_ORDER = Object.freeze([
  'Crypto',
  'Network',
  'Storage',
  'Audio',
  'UI',
  'Game',
]);

const ROLE_PATTERNS = Object.freeze({
  Crypto: /(?:cccrypt|commoncrypto|seckey|openssl|boringssl|\bevp\b|\baes\b|\bsha1\b|\bsha256\b|\bsha512\b|\bmd5\b|\bhmac\b|\brsa\b|\becdsa\b|\bchacha\b|\bpoly1305\b|\bpbkdf\b|\bhkdf\b|\bcipher\b|\bencrypt\b|\bdecrypt\b|\bdigest\b|\bsignature\b|\bx509\b|\bcrypto\b|\bkeystore\b)/i,
  Network: /(?:nsurl|urlsession|cfnetwork|cfstream|websocket|https?:\/\/|\bhttp\b|\bhttps\b|\bsocket\b|\btcp\b|\budp\b|\btls\b|\bssl\b|\bcurl\b|\bgrpc\b|\bprotobuf\b|\breachability\b|\bendpoint\b|\bdns\b|\bfetch\b|\bconnect\b|\brecv\b|\bnetwork\b)/i,
  Storage: /(?:sqlite|coredata|userdefaults|keychain|secitem|nsfilemanager|leveldb|rocksdb|sharedpreferences|\bsql\b|\brealm\b|\bfopen\b|\bfread\b|\bfwrite\b|\bmmap\b|\bplist\b|\barchive\b|\bdatabase\b|\bstorage\b|\bsavefile\b|\bloadfile\b|\bdiskcache\b)/i,
  Audio: /(?:avaudio|audiounit|coreaudio|openal|\bfmod\b|\bwwise\b|\baudio\b|\bsound\b|\bmusic\b|\bmixer\b|\bpcm\b|\bwav\b|\bmp3\b|\bogg\b|\bsynth\b|\bplayback\b|\bmicrophone\b|\bbgm\b|\bsfx\b)/i,
  UI: /(?:uiview|uikit|swiftui|appkit|calayer|coregraphics|cgcontext|coreanimation|mtldevice|opengl|gldraw|viewcontroller|\bmetal\b|\bvulkan\b|\bcanvas\b|\bshader\b|\btexture\b|\bsprite\b|\bbutton\b|\bdialog\b|\bwindow\b|\blayout\b|\bgesture\b|\btoast\b|\balert\b)/i,
  Game: /(?:il2cpp|\bcoin\b|\bgem\b|\bruby\b|\bgold\b|\bscore\b|\bstage\b|\bplayer\b|\benemy\b|\bboss\b|\bweapon\b|\bdamage\b|\bhealth\b|\bstamina\b|\benergy\b|\bgacha\b|\binventory\b|\bquest\b|\bmission\b|\bbattle\b|\bcombat\b|\bskill\b|\bbuff\b|\bdebuff\b|\bcollider\b|\brigidbody\b|\bunity\b|\bunreal\b|\bcocos\b|\bgame\b)/i,
});

const HEX_VA_RE = /^0[xX][0-9a-fA-F]+$/;
const DEC_VA_RE = /^[0-9]+$/;

function toBigIntOrNull(value) {
  if (typeof value === 'bigint') {
    return value >= 0n ? value : null;
  }
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

function compareBigInt(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

function compareLex(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

function normalizePositiveInt(value, fallback, min = 1) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= min) {
    return Math.floor(value);
  }
  return fallback;
}

function normalizeNonNegativeInt(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return fallback;
}

/**
 * Normalize an external function-keyed map (`Map<bigint, T>`, `Map<string, T>`,
 * or plain `Record<string, T>`) into a `Map<bigint, T>`.
 */
function normalizeFunctionMap(input) {
  const out = new Map();
  if (!input || typeof input !== 'object') return out;
  if (input instanceof Map) {
    for (const [k, v] of input.entries()) {
      const va = toBigIntOrNull(k);
      if (va != null) out.set(va, v);
    }
    return out;
  }
  const keys = Object.keys(input);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const va = toBigIntOrNull(k);
    if (va != null) out.set(va, input[k]);
  }
  return out;
}

function extractTextList(raw) {
  if (!raw) return [];
  if (typeof raw === 'string') return raw ? [raw] : [];
  const out = [];
  if (Array.isArray(raw) || raw instanceof Set) {
    for (const item of raw) {
      if (typeof item === 'string') {
        if (item) out.push(item);
      } else if (item && typeof item === 'object') {
        const text = item.text ?? item.value ?? item.str ?? item.name ?? item.api ?? item.symbol;
        if (typeof text === 'string' && text) out.push(text);
      }
    }
  }
  return out;
}

function skipOperatorAngles(str, idx) {
  if (str.slice(idx, idx + 8) !== 'operator') return 0;
  if (idx > 0 && /[\w$]/.test(str[idx - 1])) return 0;
  let j = idx + 8;
  while (j < str.length && str[j] === ' ') j++;
  const rest = str.slice(j);
  const m = /^(?:->\*|->|<=>|<<=|>>=|<<|>>|<=|>=|<|>)/.exec(rest);
  return m ? (j + m[0].length - idx) : 0;
}

/**
 * Split a C++ qualified name by top-level `::` while tracking `<>` template
 * bracket depth and capping depth at `maxDepth`.
 */
export function splitCppSegments(name, maxDepth = DEFAULT_MAX_DEPTH) {
  if (typeof name !== 'string') return [];
  const trimmed = name.trim();
  if (!trimmed) return [];

  const limit = normalizePositiveInt(maxDepth, DEFAULT_MAX_DEPTH, 1);
  const hasAngle = trimmed.indexOf('<') >= 0;
  const hasOp = trimmed.indexOf('operator') >= 0;
  if (!hasAngle && !hasOp) {
    const rawParts = trimmed.split('::');
    const parts = [];
    for (let k = 0; k < rawParts.length; k++) {
      const seg = rawParts[k].trim();
      if (seg) parts.push(seg);
    }
    if (parts.length > limit) {
      const head = parts.slice(0, limit - 1);
      head.push(parts.slice(limit - 1).join('::'));
      return head;
    }
    return parts;
  }

  const segments = [];
  let depth = 0;
  let start = 0;
  let i = 0;

  while (i < trimmed.length) {
    if (hasOp && trimmed.charCodeAt(i) === 111 /* o */) {
      const opSkip = skipOperatorAngles(trimmed, i);
      if (opSkip > 0) {
        i += opSkip;
        continue;
      }
    }
    const ch = trimmed[i];
    if (ch === '<') {
      depth++;
      i++;
      continue;
    }
    if (ch === '>') {
      if (depth > 0) depth--;
      i++;
      continue;
    }
    if (depth === 0 && ch === ':' && i + 1 < trimmed.length && trimmed[i + 1] === ':') {
      const seg = trimmed.slice(start, i).trim();
      if (seg) segments.push(seg);
      i += 2;
      start = i;
      continue;
    }
    i++;
  }

  const tail = trimmed.slice(start).trim();
  if (tail) segments.push(tail);

  if (segments.length > limit) {
    const head = segments.slice(0, limit - 1);
    head.push(segments.slice(limit - 1).join('::'));
    return head;
  }
  return segments;
}

/**
 * Split a Swift qualified name by top-level `.` while tracking `<>` depth
 * and capping depth at `maxDepth`.
 */
export function splitSwiftSegments(name, maxDepth = DEFAULT_MAX_DEPTH) {
  if (typeof name !== 'string') return [];
  const trimmed = name.trim();
  if (!trimmed) return [];

  const limit = normalizePositiveInt(maxDepth, DEFAULT_MAX_DEPTH, 1);
  const segments = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '<') {
      depth++;
    } else if (ch === '>') {
      if (depth > 0) depth--;
    } else if (depth === 0 && ch === '.') {
      const seg = trimmed.slice(start, i).trim();
      if (seg) segments.push(seg);
      start = i + 1;
    }
  }
  const tail = trimmed.slice(start).trim();
  if (tail) segments.push(tail);

  if (segments.length > limit) {
    const head = segments.slice(0, limit - 1);
    head.push(segments.slice(limit - 1).join('.'));
    return head;
  }
  return segments;
}

function collectFunctionAddrs(functions, symbols) {
  const addrSet = new Set();
  const fnNameMap = new Map();

  const addEntry = (rawAddr, rawName = null) => {
    const va = toBigIntOrNull(rawAddr);
    if (va == null) return;
    addrSet.add(va);
    if (typeof rawName === 'string' && rawName.length > 0 && !fnNameMap.has(va)) {
      fnNameMap.set(va, rawName);
    }
  };

  const ingestArrayLike = (list) => {
    if (!list || typeof list.length !== 'number') return;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (item == null) continue;
      if (typeof item === 'bigint' || typeof item === 'number' || typeof item === 'string') {
        addEntry(item, null);
      } else if (typeof item === 'object') {
        addEntry(item.start ?? item.va ?? item.addr ?? item.address, item.name ?? null);
      }
    }
  };

  if (functions) {
    if (functions instanceof Set) {
      for (const item of functions) {
        if (typeof item === 'object' && item !== null) {
          addEntry(item.start ?? item.va ?? item.addr ?? item.address, item.name ?? null);
        } else {
          addEntry(item, null);
        }
      }
    } else if (
      Array.isArray(functions)
      || functions instanceof BigUint64Array
      || functions instanceof BigInt64Array
    ) {
      ingestArrayLike(functions);
    } else if (typeof functions === 'object') {
      if (functions.funcs && typeof functions.funcs.length === 'number') {
        ingestArrayLike(functions.funcs);
      }
      if (Array.isArray(functions.functions)) {
        ingestArrayLike(functions.functions);
      } else if (typeof functions.functionList === 'function') {
        try {
          const list = functions.functionList(null, 500000);
          if (Array.isArray(list)) ingestArrayLike(list);
        } catch {
          // Fail closed on custom symbol/program mocks.
        }
      }
    }
  }

  if (symbols && typeof symbols === 'object') {
    if (addrSet.size === 0 && symbols.funcs && typeof symbols.funcs.length === 'number') {
      ingestArrayLike(symbols.funcs);
    }
    if (symbols instanceof Map) {
      for (const [k, v] of symbols.entries()) {
        const va = toBigIntOrNull(k);
        if (va != null && typeof v === 'string' && v) fnNameMap.set(va, v);
      }
    } else if (typeof symbols.nameAt === 'function') {
      for (const va of addrSet) {
        if (fnNameMap.has(va)) continue;
        try {
          const name = symbols.nameAt(va);
          if (typeof name === 'string' && name) fnNameMap.set(va, name);
        } catch {
          // Ignore failing nameAt lookup.
        }
      }
    }
  }

  return { addrSet, fnNameMap };
}

function commonNamespacePrefix(ownerNames, maxDepth) {
  if (!Array.isArray(ownerNames) || ownerNames.length === 0) return [];
  const first = splitCppSegments(ownerNames[0], maxDepth);
  if (first.length <= 1) return [];
  let prefixLen = first.length - 1;
  for (let i = 1; i < ownerNames.length && prefixLen > 0; i++) {
    const segs = splitCppSegments(ownerNames[i], maxDepth);
    let j = 0;
    const maxJ = Math.min(prefixLen, segs.length - 1);
    while (j < maxJ && segs[j] === first[j]) j++;
    prefixLen = j;
  }
  return first.slice(0, prefixLen);
}

function buildCallersMap(callgraph) {
  const callersByCallee = new Map();
  if (!callgraph || typeof callgraph !== 'object') return callersByCallee;

  const addEdge = (caller, callee) => {
    if (caller == null || callee == null || caller === callee) return;
    let set = callersByCallee.get(callee);
    if (!set) {
      set = new Set();
      callersByCallee.set(callee, set);
    }
    set.add(caller);
  };

  if (callgraph instanceof Map) {
    for (const [rawCaller, rawCallees] of callgraph.entries()) {
      const caller = toBigIntOrNull(rawCaller);
      if (caller == null || !rawCallees) continue;
      if (typeof rawCallees[Symbol.iterator] === 'function') {
        for (const rawCallee of rawCallees) {
          addEdge(caller, toBigIntOrNull(rawCallee));
        }
      }
    }
    return callersByCallee;
  }

  const nodes = callgraph.nodes;
  const edgeSrc = callgraph.edgeSrc;
  const edgeDst = callgraph.edgeDst;
  if (
    nodes && typeof nodes.length === 'number'
    && edgeSrc && typeof edgeSrc.length === 'number'
    && edgeDst && typeof edgeDst.length === 'number'
  ) {
    const nodeCount = nodes.length;
    const edgeCount = Math.min(edgeSrc.length, edgeDst.length);
    for (let i = 0; i < edgeCount; i++) {
      const u = edgeSrc[i];
      const v = edgeDst[i];
      if (u === v || u < 0 || v < 0 || u >= nodeCount || v >= nodeCount) continue;
      addEdge(toBigIntOrNull(nodes[u]), toBigIntOrNull(nodes[v]));
    }
  }

  return callersByCallee;
}

function normalizeTextForRole(text) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ');
}

function classifyRole(stringsList, apisList) {
  if (stringsList.length === 0 && apisList.length === 0) return null;
  const counts = new Map();

  const scoreText = (text) => {
    if (typeof text !== 'string' || !text) return;
    const normalized = normalizeTextForRole(text);
    for (let i = 0; i < ROLE_ORDER.length; i++) {
      const role = ROLE_ORDER[i];
      if (ROLE_PATTERNS[role].test(normalized)) {
        counts.set(role, (counts.get(role) || 0) + 1);
      }
    }
  };

  for (let i = 0; i < apisList.length; i++) scoreText(apisList[i]);
  for (let i = 0; i < stringsList.length; i++) scoreText(stringsList[i]);

  if (counts.size === 0) return null;

  let bestRole = null;
  let bestScore = 0;
  for (let i = 0; i < ROLE_ORDER.length; i++) {
    const role = ROLE_ORDER[i];
    const score = counts.get(role) || 0;
    if (score > bestScore) {
      bestScore = score;
      bestRole = role;
    }
  }
  return bestRole;
}

/**
 * Build a unified UI-independent virtual folder tree over binary functions.
 *
 * @param {object} [opts]
 * @returns {{
 *   rootId: string,
 *   nodes: Map<string, object>,
 *   functionToFolderId: Map<bigint, string>,
 *   completeness: 'complete' | 'partial',
 *   truncated: boolean,
 *   stats: {
 *     totalFolders: number,
 *     totalFunctions: number,
 *     tier1Count: number,
 *     tier2Count: number,
 *     tier3Count: number,
 *     tier4Count: number,
 *     elapsedMs: number,
 *   },
 *   getChildren: (folderId: string, opts?: { offset?: number, limit?: number }) => object,
 *   search: (query: string, opts?: { limit?: number }) => object,
 * }}
 */
export function buildVirtualFolderTree(opts = {}) {
  const t0 = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

  const o = opts && typeof opts === 'object' ? opts : {};
  const maxNodes = normalizePositiveInt(o.maxNodes, DEFAULT_MAX_NODES, 1);
  const maxDepth = normalizePositiveInt(o.maxDepth, DEFAULT_MAX_DEPTH, 1);

  const nodes = new Map();
  const functionToFolderId = new LazyFolderMap();

  let truncated = false;
  let inputPartial = false;

  const rootNode = {
    id: ROOT_ID,
    parentId: null,
    kind: 'root',
    label: ROOT_ID,
    fullPath: '',
    source: 'unclassified',
    confidence: 'low',
    functionCount: 0,
    childFolderIds: [],
    functionAddrs: [],
  };
  const nodeChildMaps = new Map();
  const nodeChildLists = new Map();
  nodeChildMaps.set(rootNode, new Map());
  nodeChildLists.set(rootNode, []);
  nodes.set(ROOT_ID, rootNode);

  const ensureFolderPathNode = (segments, leafKind, source, confidence) => {
    let parentNode = rootNode;
    let currentPath = '';
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg) continue;
      const isLeaf = i === segments.length - 1;
      let childrenMap = nodeChildMaps.get(parentNode);
      if (!childrenMap) {
        childrenMap = new Map();
        nodeChildMaps.set(parentNode, childrenMap);
      }
      let nextNode = childrenMap.get(seg);
      if (!nextNode) {
        if (nodes.size >= maxNodes) {
          truncated = true;
          return parentNode === rootNode ? null : parentNode;
        }
        let nextId = currentPath ? `${currentPath}/${seg}` : seg;
        if (seg.indexOf('/') >= 0 && nodes.has(nextId)) {
          let suffix = 1;
          while (nodes.has(`${nextId}#${suffix}`)) suffix++;
          nextId = `${nextId}#${suffix}`;
        }
        const kind = isLeaf
          ? leafKind
          : (leafKind === 'role' ? 'role' : 'namespace');
        nextNode = {
          id: nextId,
          parentId: parentNode.id,
          kind,
          label: seg,
          fullPath: currentPath ? `${currentPath}/${seg}` : seg,
          source,
          confidence,
          functionCount: 0,
          childFolderIds: [],
          functionAddrs: [],
        };
        nodes.set(nextId, nextNode);
        if (!isLeaf) nodeChildMaps.set(nextNode, new Map());
        childrenMap.set(seg, nextNode);
        parentNode.childFolderIds.push(nextId);
        let childList = nodeChildLists.get(parentNode);
        if (!childList) {
          childList = [];
          nodeChildLists.set(parentNode, childList);
        }
        childList.push(nextNode);
      } else if (isLeaf) {
        if (nextNode.kind === 'namespace' && leafKind === 'class') {
          nextNode.kind = 'class';
        }
      }
      currentPath = nextNode.fullPath;
      parentNode = nextNode;
    }
    return parentNode === rootNode ? null : parentNode;
  };

  const ensureFolderPath = (segments, leafKind, source, confidence) => {
    const node = ensureFolderPathNode(segments, leafKind, source, confidence);
    return node ? node.id : null;
  };

  const assignFunction = (fnVa, folderId) => {
    if (fnVa == null || !folderId || functionToFolderId.has(fnVa)) return false;
    const node = nodes.get(folderId);
    if (!node) return false;
    functionToFolderId.set(fnVa, folderId);
    node.functionAddrs.push(fnVa);
    return true;
  };

  const stringsMap = normalizeFunctionMap(o.stringsByFunc);
  const apisMap = normalizeFunctionMap(o.apisByFunc);
  const callersByCallee = buildCallersMap(o.callgraph);
  const needsTier23 = stringsMap.size > 0 || apisMap.size > 0 || callersByCallee.size > 0;
  const hasSymbolsObj = Boolean(o.symbols && typeof o.symbols === 'object');
  let fastBigIntFunctions = false;
  if (!needsTier23 && !hasSymbolsObj) {
    if (o.functions instanceof BigUint64Array || o.functions instanceof BigInt64Array) {
      fastBigIntFunctions = true;
    } else if (Array.isArray(o.functions)) {
      fastBigIntFunctions = true;
      for (let i = 0; i < o.functions.length; i++) {
        if (typeof o.functions[i] !== 'bigint') {
          fastBigIntFunctions = false;
          break;
        }
      }
    }
  }

  const { addrSet, fnNameMap } = fastBigIntFunctions
    ? { addrSet: null, fnNameMap: new Map() }
    : collectFunctionAddrs(o.functions, o.symbols);

  let tier1Count = 0;
  let tier2Count = 0;
  let tier3Count = 0;
  let tier4Count = 0;

  const cppFolderNodeCache = new Map();
  const resolveCppClassFolderNode = (className) => {
    const cached = cppFolderNodeCache.get(className);
    if (cached !== undefined) return cached;
    const segs = splitCppSegments(className, maxDepth);
    const node = segs.length > 0
      ? ensureFolderPathNode(segs, 'class', 'cxx-rtti', 'high')
      : null;
    cppFolderNodeCache.set(className, node);
    return node;
  };

  const placeCppClass = (fnVa, className, isShared = false, sharedOwners = null) => {
    if (fnVa == null) return;
    if (addrSet) addrSet.add(fnVa);
    if (functionToFolderId.has(fnVa)) return;

    if (typeof className === 'string' && className.trim()) {
      const node = resolveCppClassFolderNode(className);
      if (node) {
        functionToFolderId.set(fnVa, node.id);
        node.functionAddrs.push(fnVa);
        tier1Count++;
        return;
      }
    }

    if (isShared && Array.isArray(sharedOwners) && sharedOwners.length > 0) {
      const prefix = commonNamespacePrefix(sharedOwners, maxDepth - 1);
      const segs = prefix.length > 0 ? [...prefix, 'Shared'] : ['Shared'];
      const folderId = ensureFolderPath(segs, 'namespace', 'cxx-rtti', 'medium');
      if (assignFunction(fnVa, folderId)) tier1Count++;
    }
  };

  const placeObjcClass = (fnVa, className) => {
    if (fnVa == null || typeof className !== 'string' || !className.trim()) return;
    if (addrSet) addrSet.add(fnVa);
    if (functionToFolderId.has(fnVa)) return;
    const segs = ['ObjC', className.trim()];
    const folderId = ensureFolderPath(segs, 'class', 'objc', 'high');
    if (assignFunction(fnVa, folderId)) tier1Count++;
  };

  const placeSwiftClass = (fnVa, className) => {
    if (fnVa == null || typeof className !== 'string' || !className.trim()) return;
    if (addrSet) addrSet.add(fnVa);
    if (functionToFolderId.has(fnVa)) return;
    const segs = splitSwiftSegments(className, maxDepth);
    if (segs.length === 0) return;
    const folderId = ensureFolderPath(segs, 'class', 'swift', 'high');
    if (assignFunction(fnVa, folderId)) tier1Count++;
  };

  // --- Tier 1: Metadata-backed placement ---
  // Precedence: unifiedMetadata is canonical; cxxRtti / objcSwift are fallbacks only when unifiedMetadata is absent.
  const hasUnified = Boolean(o.unifiedMetadata && typeof o.unifiedMetadata === 'object');
  if (hasUnified) {
    const um = o.unifiedMetadata;
    if (um.completeness === 'partial' || um.truncated === true) inputPartial = true;

    const methodsByFn = um.methodsByFn instanceof Map
      ? um.methodsByFn
      : normalizeFunctionMap(um.methodsByFn);
    for (const [fnVa, ref] of methodsByFn.entries()) {
      if (!ref || typeof ref !== 'object') continue;
      const lang = String(ref.language || '').toLowerCase();
      if (typeof ref.methodName === 'string' && ref.methodName && !fnNameMap.has(fnVa)) {
        fnNameMap.set(fnVa, ref.className ? `${ref.className}::${ref.methodName}` : ref.methodName);
      }
      if (lang === 'objc') {
        placeObjcClass(fnVa, ref.className);
      } else if (lang === 'swift') {
        placeSwiftClass(fnVa, ref.className);
      } else {
        placeCppClass(fnVa, ref.className, Boolean(ref.isShared), ref.sharedOwners);
      }
    }

    if (Array.isArray(um.classes)) {
      for (let i = 0; i < um.classes.length; i++) {
        const cls = um.classes[i];
        if (!cls || typeof cls !== 'object') continue;
        const lang = String(cls.language || '').toLowerCase();
        const methods = Array.isArray(cls.methods) ? cls.methods : [];
        if (methods.length === 0 && typeof cls.className === 'string' && cls.className.trim()) {
          if (lang === 'objc') {
            ensureFolderPath(['ObjC', cls.className.trim()], 'class', 'objc', 'high');
          } else if (lang === 'swift') {
            const segs = splitSwiftSegments(cls.className, maxDepth);
            if (segs.length > 0) ensureFolderPath(segs, 'class', 'swift', 'high');
          } else {
            const segs = splitCppSegments(cls.className, maxDepth);
            if (segs.length > 0) ensureFolderPath(segs, 'class', 'cxx-rtti', 'high');
          }
          continue;
        }
        for (let j = 0; j < methods.length; j++) {
          const m = methods[j];
          const fnVa = toBigIntOrNull(m?.fnVa ?? m?.addr ?? m?.va);
          if (fnVa == null) continue;
          if (typeof m.methodName === 'string' && m.methodName && !fnNameMap.has(fnVa)) {
            fnNameMap.set(fnVa, cls.className ? `${cls.className}::${m.methodName}` : m.methodName);
          }
          if (lang === 'objc') {
            placeObjcClass(fnVa, cls.className);
          } else if (lang === 'swift') {
            placeSwiftClass(fnVa, cls.className);
          } else {
            placeCppClass(fnVa, cls.className, Boolean(m.isShared), m.sharedOwners);
          }
        }
      }
    }
  } else {
    // Fallback: cxxRtti
    if (o.cxxRtti && typeof o.cxxRtti === 'object') {
      const rtti = o.cxxRtti;
      if (rtti.completeness === 'partial' || rtti.truncated === true) inputPartial = true;

      const byFn = rtti.byFunction instanceof Map
        ? rtti.byFunction
        : normalizeFunctionMap(rtti.byFunction);
      // Pre-seed cppFolderNodeCache from pre-split rtti.classes (avoids re-splitting 10k+ C++ names).
      if (Array.isArray(rtti.classes)) {
        for (let i = 0; i < rtti.classes.length; i++) {
          const cls = rtti.classes[i];
          if (!cls || typeof cls !== 'object') continue;
          const cn = cls.className;
          if (typeof cn !== 'string' || !cn || cppFolderNodeCache.has(cn)) continue;
          if (Array.isArray(cls.namespacePath) && typeof cls.shortClassName === 'string' && cls.shortClassName) {
            const segs = cls.namespacePath.length > 0
              ? [...cls.namespacePath, cls.shortClassName]
              : [cls.shortClassName];
            const capped = segs.length > maxDepth
              ? [...segs.slice(0, maxDepth - 1), segs.slice(maxDepth - 1).join('::')]
              : segs;
            cppFolderNodeCache.set(cn, ensureFolderPathNode(capped, 'class', 'cxx-rtti', 'high'));
          }
        }
      }
      if (functionToFolderId.size === 0 && !addrSet) {
        let lazyRttiCount = 0;
        const useLazyMap = typeof byFn._forEachPrimary === 'function';
        const placeFast = (fnVa, className, isShared, sharedOwners) => {
          if (typeof className === 'string' && className.length > 0) {
            const node = resolveCppClassFolderNode(className);
            if (node) {
              if (useLazyMap) lazyRttiCount++;
              else functionToFolderId.set(fnVa, node.id);
              node.functionAddrs.push(fnVa);
              tier1Count++;
              return;
            }
          }
          placeCppClass(fnVa, className, isShared, sharedOwners);
        };
        if (useLazyMap) {
          byFn._forEachPrimary(placeFast);
          if (lazyRttiCount > 0) {
            functionToFolderId._attachLazyRtti(byFn, cppFolderNodeCache, lazyRttiCount);
          }
        } else {
          for (const [fnVa, link] of byFn.entries()) {
            if (!link || typeof link !== 'object') continue;
            placeFast(fnVa, link.primaryOwner, Boolean(link.isShared), link.sharedOwners);
          }
        }
      } else {
        for (const [fnVa, link] of byFn.entries()) {
          if (!link || typeof link !== 'object') continue;
          placeCppClass(fnVa, link.primaryOwner, Boolean(link.isShared), link.sharedOwners);
        }
      }

      if (Array.isArray(rtti.classes)) {
        const hasByFn = byFn.size > 0;
        for (let i = 0; i < rtti.classes.length; i++) {
          const cls = rtti.classes[i];
          if (!cls || typeof cls !== 'object') continue;
          if (hasByFn) {
            const isEmpty = typeof cls.methodCount === 'number'
              ? cls.methodCount === 0
              : (!Array.isArray(cls.methods) || cls.methods.length === 0);
            if (isEmpty && typeof cls.className === 'string' && cls.className.trim()) {
              resolveCppClassFolderNode(cls.className);
            }
            continue;
          }
          const methods = Array.isArray(cls.methods) ? cls.methods : [];
          if (methods.length === 0 && typeof cls.className === 'string' && cls.className.trim()) {
            resolveCppClassFolderNode(cls.className);
            continue;
          }
          for (let j = 0; j < methods.length; j++) {
            const m = methods[j];
            const fnVa = toBigIntOrNull(m?.fnVa ?? m?.addr ?? m?.va);
            if (fnVa != null) placeCppClass(fnVa, cls.className);
          }
        }
      }
    }

    // Fallback: objcSwift
    if (o.objcSwift && typeof o.objcSwift === 'object') {
      const os = o.objcSwift;
      if (os.completeness === 'partial' || os.truncated === true) inputPartial = true;

      if (Array.isArray(os.objcClasses)) {
        for (let i = 0; i < os.objcClasses.length; i++) {
          const cls = os.objcClasses[i];
          if (!cls || typeof cls !== 'object' || typeof cls.name !== 'string') continue;
          const methods = Array.isArray(cls.methods) ? cls.methods : [];
          for (let j = 0; j < methods.length; j++) {
            const m = methods[j];
            const fnVa = toBigIntOrNull(m?.imp ?? m?.fnVa ?? m?.addr ?? m?.va);
            if (fnVa != null) placeObjcClass(fnVa, cls.name);
          }
        }
      }
      if (Array.isArray(os.swiftClasses)) {
        for (let i = 0; i < os.swiftClasses.length; i++) {
          const cls = os.swiftClasses[i];
          if (!cls || typeof cls !== 'object' || typeof cls.name !== 'string') continue;
          const methods = Array.isArray(cls.methods) ? cls.methods : [];
          for (let j = 0; j < methods.length; j++) {
            const m = methods[j];
            const fnVa = toBigIntOrNull(m?.fnVa ?? m?.addr ?? m?.va);
            if (fnVa != null) placeSwiftClass(fnVa, cls.name);
          }
        }
      }
      if (Array.isArray(os.classes)) {
        for (let i = 0; i < os.classes.length; i++) {
          const cls = os.classes[i];
          if (!cls || typeof cls !== 'object') continue;
          const name = cls.className ?? cls.name;
          const lang = String(cls.language || 'objc').toLowerCase();
          const methods = Array.isArray(cls.methods) ? cls.methods : [];
          for (let j = 0; j < methods.length; j++) {
            const m = methods[j];
            const fnVa = toBigIntOrNull(m?.imp ?? m?.fnVa ?? m?.addr ?? m?.va);
            if (fnVa == null) continue;
            if (lang === 'swift') placeSwiftClass(fnVa, name);
            else placeObjcClass(fnVa, name);
          }
        }
      }
    }
  }

  if (fastBigIntFunctions) {
    // Fast-path Tier 4 directly without building a 150k+ BigInt Set or re-hashing Unclassified into Map.
    let unclassifiedFolderId = null;
    let unclassifiedNode = null;
    const fnList = o.functions;
    let isStrictlyAsc = true;
    let prevUnclass = -1n;
    for (let i = 0; i < fnList.length; i++) {
      const fnVa = fnList[i];
      if (typeof fnVa !== 'bigint' || fnVa < 0n || functionToFolderId._hasAssigned(fnVa)) continue;
      if (!unclassifiedFolderId) {
        unclassifiedFolderId = ensureFolderPath([UNCLASSIFIED_ID], 'unclassified', 'unclassified', 'low');
        if (!unclassifiedFolderId) break;
        unclassifiedNode = nodes.get(unclassifiedFolderId);
      }
      if (fnVa <= prevUnclass) isStrictlyAsc = false;
      prevUnclass = fnVa;
      unclassifiedNode.functionAddrs.push(fnVa);
      tier4Count++;
    }
    if (unclassifiedNode && unclassifiedNode.functionAddrs.length > 0) {
      if (!isStrictlyAsc) {
        unclassifiedNode.functionAddrs.sort(compareBigInt);
        // Deduplicate if unsorted input had duplicate addresses
        const arr = unclassifiedNode.functionAddrs;
        let w = 1;
        for (let r = 1; r < arr.length; r++) {
          if (arr[r] !== arr[w - 1]) arr[w++] = arr[r];
        }
        arr.length = w;
        tier4Count = w;
      }
      functionToFolderId._attachUnclassified(unclassifiedNode.functionAddrs, unclassifiedFolderId);
    }
  } else {
  // Deterministic sorted list of all candidate functions (O(N) check before sort).
  const allFuncAddrs = Array.from(addrSet);
  let allSorted = true;
  for (let i = 1; i < allFuncAddrs.length; i++) {
    if (allFuncAddrs[i - 1] > allFuncAddrs[i]) {
      allSorted = false;
      break;
    }
  }
  if (!allSorted) allFuncAddrs.sort(compareBigInt);

  // --- Tier 2: OS API / String role classification ---
  if (stringsMap.size > 0 || apisMap.size > 0) {
    for (let i = 0; i < allFuncAddrs.length; i++) {
      const fnVa = allFuncAddrs[i];
      if (functionToFolderId.has(fnVa)) continue;
      const stringsList = extractTextList(stringsMap.get(fnVa));
      const apisList = extractTextList(apisMap.get(fnVa));
      if (stringsList.length === 0 && apisList.length === 0) continue;
      const role = classifyRole(stringsList, apisList);
      if (!role) continue;
      const folderId = ensureFolderPath(['Roles', role], 'role', 'api-role', 'medium');
      if (assignFunction(fnVa, folderId)) tier2Count++;
    }
  }

  // --- Tier 3: Callgraph propagation (up to 2 hops) ---
  if (callersByCallee.size > 0) {
    const visited = new Set();
    for (let hop = 0; hop < MAX_CALLGRAPH_HOPS; hop++) {
      const hopAssignments = new Map();

      for (let i = 0; i < allFuncAddrs.length; i++) {
        const fnVa = allFuncAddrs[i];
        if (functionToFolderId.has(fnVa) || visited.has(fnVa)) continue;

        const callers = callersByCallee.get(fnVa);
        if (!callers || callers.size === 0) continue;
        // Exclude utility hubs with > 16 callers.
        if (callers.size > UTILITY_HUB_CALLER_LIMIT) {
          visited.add(fnVa);
          continue;
        }

        const folderVotes = new Map();
        let resolvedCallers = 0;
        for (const callerVa of callers) {
          const callerFolderId = functionToFolderId.get(callerVa);
          if (!callerFolderId) continue;
          const callerNode = nodes.get(callerFolderId);
          if (!callerNode || callerNode.kind === 'unclassified' || callerNode.kind === 'root') continue;
          // Collapse <Parent>/helpers back to <Parent> to avoid helpers/helpers nesting.
          const targetParentId = callerNode.kind === 'helpers' && callerNode.parentId && callerNode.parentId !== ROOT_ID
            ? callerNode.parentId
            : callerFolderId;
          resolvedCallers++;
          folderVotes.set(targetParentId, (folderVotes.get(targetParentId) || 0) + 1);
        }

        if (resolvedCallers === 0) continue;

        let winningParentId = null;
        let winningVotes = 0;
        let winningPath = '';
        for (const [candidateId, votes] of folderVotes.entries()) {
          // Exact >= 80% threshold (votes / resolvedCallers >= 0.8 => votes * 5 >= resolvedCallers * 4).
          if (votes * 5 < resolvedCallers * 4) continue;
          const candidatePath = nodes.get(candidateId)?.fullPath || candidateId;
          if (
            votes > winningVotes
            || (votes === winningVotes && (winningParentId === null || compareLex(candidatePath, winningPath) < 0))
          ) {
            winningVotes = votes;
            winningParentId = candidateId;
            winningPath = candidatePath;
          }
        }

        if (winningParentId) {
          hopAssignments.set(fnVa, winningParentId);
        }
      }

      if (hopAssignments.size === 0) break;

      for (const [fnVa, parentId] of hopAssignments.entries()) {
        visited.add(fnVa);
        const parentNode = nodes.get(parentId);
        if (!parentNode) continue;
        let childrenMap = nodeChildMaps.get(parentNode);
        if (!childrenMap) {
          childrenMap = new Map();
          nodeChildMaps.set(parentNode, childrenMap);
        }
        let helpersNode = childrenMap.get('helpers');
        if (!helpersNode) {
          if (nodes.size >= maxNodes) {
            truncated = true;
            continue;
          }
          let helpersId = `${parentNode.fullPath}/helpers`;
          if (nodes.has(helpersId)) {
            let suffix = 1;
            while (nodes.has(`${helpersId}#${suffix}`)) suffix++;
            helpersId = `${helpersId}#${suffix}`;
          }
          helpersNode = {
            id: helpersId,
            parentId,
            kind: 'helpers',
            label: 'helpers',
            fullPath: `${parentNode.fullPath}/helpers`,
            source: 'callgraph',
            confidence: 'medium',
            functionCount: 0,
            childFolderIds: [],
            functionAddrs: [],
          };
          nodes.set(helpersId, helpersNode);
          nodeChildMaps.set(helpersNode, new Map());
          childrenMap.set('helpers', helpersNode);
          parentNode.childFolderIds.push(helpersId);
          let childList = nodeChildLists.get(parentNode);
          if (!childList) {
            childList = [];
            nodeChildLists.set(parentNode, childList);
          }
          childList.push(helpersNode);
        }
        if (assignFunction(fnVa, helpersNode.id)) tier3Count++;
      }
    }
  }

  // --- Tier 4: Unclassified ---
  let unclassifiedFolderId = null;
  for (let i = 0; i < allFuncAddrs.length; i++) {
    const fnVa = allFuncAddrs[i];
    if (functionToFolderId.has(fnVa)) continue;
    if (!unclassifiedFolderId) {
      unclassifiedFolderId = ensureFolderPath([UNCLASSIFIED_ID], 'unclassified', 'unclassified', 'low');
    }
    if (!unclassifiedFolderId) break;
    if (assignFunction(fnVa, unclassifiedFolderId)) tier4Count++;
  }
  }

  // Sort childFolderIds and functionAddrs deterministically, and compute recursive functionCount bottom-up.
  for (const node of nodes.values()) {
    const arr = node.functionAddrs;
    const fnLen = arr.length;
    if (fnLen === 2) {
      if (arr[0] > arr[1]) {
        const tmp = arr[0];
        arr[0] = arr[1];
        arr[1] = tmp;
      }
    } else if (fnLen > 2) {
      let fnSorted = true;
      for (let j = 1; j < fnLen; j++) {
        if (arr[j - 1] > arr[j]) {
          fnSorted = false;
          break;
        }
      }
      if (!fnSorted) arr.sort(compareBigInt);
    }
    const kids = node.childFolderIds;
    if (kids.length === 2) {
      if (kids[0] > kids[1]) {
        const tmp = kids[0];
        kids[0] = kids[1];
        kids[1] = tmp;
      }
    } else if (kids.length > 2) {
      kids.sort(compareLex);
    }
  }

  // Post-order traversal (iterative) on strict tree to compute recursive functionCount (zero nodes.get!).
  const order = [];
  const stack = [rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    order.push(node);
    const childList = nodeChildLists.get(node);
    if (childList) {
      for (let i = 0; i < childList.length; i++) {
        stack.push(childList[i]);
      }
    }
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i];
    let total = node.functionAddrs.length;
    const childList = nodeChildLists.get(node);
    if (childList) {
      for (let j = 0; j < childList.length; j++) {
        total += childList[j].functionCount;
      }
    }
    node.functionCount = total;
  }

  if (tier1Count > 0) {
    rootNode.source = 'cxx-rtti';
    rootNode.confidence = 'high';
  } else if (tier2Count > 0) {
    rootNode.source = 'api-role';
    rootNode.confidence = 'medium';
  } else if (tier3Count > 0) {
    rootNode.source = 'callgraph';
    rootNode.confidence = 'medium';
  }

  const totalFunctions = tier1Count + tier2Count + tier3Count + tier4Count;
  const totalFolders = Math.max(0, nodes.size - 1);
  const completeness = (truncated || inputPartial) ? 'partial' : 'complete';

  const t1 = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
  const elapsedMs = Math.max(0, Number((t1 - t0).toFixed(2)));

  function getChildren(folderId, childOpts = {}) {
    const targetId = typeof folderId === 'string' && folderId ? folderId : ROOT_ID;
    const node = nodes.get(targetId);
    if (!node) {
      return {
        folders: [],
        functions: [],
        totalFolders: 0,
        totalFunctions: 0,
        hasMore: false,
      };
    }
    const co = childOpts && typeof childOpts === 'object' ? childOpts : {};
    const offset = normalizeNonNegativeInt(co.offset, 0);
    const limit = normalizeNonNegativeInt(co.limit, 100);

    const totalChildFolders = node.childFolderIds.length;
    const totalDirectFunctions = node.functionAddrs.length;

    const folders = [];
    const folderEnd = Math.min(totalChildFolders, offset + limit);
    for (let i = offset; i < folderEnd; i++) {
      const child = nodes.get(node.childFolderIds[i]);
      if (child) folders.push(child);
    }

    const functionsSlice = node.functionAddrs.slice(offset, offset + limit);
    const hasMore = (offset + folders.length < totalChildFolders)
      || (offset + functionsSlice.length < totalDirectFunctions);

    return {
      folders,
      functions: functionsSlice,
      totalFolders: totalChildFolders,
      totalFunctions: totalDirectFunctions,
      hasMore,
    };
  }

  function search(query, searchOpts = {}) {
    if (typeof query !== 'string') return { matches: [] };
    const needle = query.trim().toLowerCase();
    if (!needle) return { matches: [] };
    const so = searchOpts && typeof searchOpts === 'object' ? searchOpts : {};
    const limit = normalizeNonNegativeInt(so.limit, 50);
    if (limit === 0) return { matches: [] };

    const matches = [];
    const needleNoPrefix = needle.startsWith('0x') ? needle.slice(2) : needle;

    // 1. Search folders first (skip root).
    for (const node of nodes.values()) {
      if (matches.length >= limit) break;
      if (node.id === ROOT_ID) continue;
      if (
        node.label.toLowerCase().includes(needle)
        || node.fullPath.toLowerCase().includes(needle)
      ) {
        matches.push({
          kind: 'folder',
          nodeId: node.id,
          label: node.label,
          fullPath: node.fullPath,
          confidence: node.confidence,
        });
      }
    }

    // 2. Search functions by hex address or known symbol name.
    if (matches.length < limit) {
      for (const [fnVa, folderId] of functionToFolderId.entries()) {
        if (matches.length >= limit) break;
        const hex = `0x${fnVa.toString(16)}`;
        const symName = fnNameMap.get(fnVa) || null;
        const hitHex = hex.includes(needle) || (needleNoPrefix.length >= 2 && hex.slice(2).includes(needleNoPrefix));
        const hitName = symName ? symName.toLowerCase().includes(needle) : false;
        if (!hitHex && !hitName) continue;
        const folderNode = nodes.get(folderId);
        matches.push({
          kind: 'function',
          nodeId: folderId,
          label: symName || hex,
          fullPath: folderNode ? `${folderNode.fullPath}/${symName || hex}` : (symName || hex),
          addr: fnVa,
          confidence: folderNode ? folderNode.confidence : 'low',
        });
      }
    }

    return { matches };
  }

  return {
    rootId: ROOT_ID,
    nodes,
    functionToFolderId,
    completeness,
    truncated,
    stats: {
      totalFolders,
      totalFunctions,
      tier1Count,
      tier2Count,
      tier3Count,
      tier4Count,
      elapsedMs,
    },
    getChildren,
    search,
  };
}
