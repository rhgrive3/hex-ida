import { SymbolIndex } from '../symbols.js';
import { ProgramIndex } from '../program.js';

const DB_NAME = 'hex-analysis-resume-v1';
const DB_VERSION = 1;
const STORE = 'kv';
const LAST_FILE_KEY = 'last-file';
const SESSION_PREFIX = 'session:';

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexeddb-request-failed'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('indexeddb-transaction-aborted'));
    tx.onerror = () => reject(tx.error || new Error('indexeddb-transaction-failed'));
  });
}

function sessionKey(binaryId, sliceIndex) {
  return `${SESSION_PREFIX}${String(binaryId)}:${Number(sliceIndex)}`;
}

function defineShapeMeta(map, snapshot) {
  for (const key of ['complete', 'capped', 'unsupported', 'incompleteReason']) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) continue;
    Object.defineProperty(map, key, { value:snapshot[key], enumerable:false, configurable:true });
  }
  return map;
}

function captureSymbols(app) {
  const sym = app?.symbols;
  if (!sym || !sym.funcs || !sym.addrs) return null;
  return {
    addrs:sym.addrs,
    kinds:sym.kinds,
    names:Array.isArray(sym.names) ? [...sym.names] : [],
    flags:sym.flags,
    funcs:sym.funcs,
    funcEnds:sym.funcEnds || null,
    regions:app?.store?.get?.('regions') || [],
    capped:!!sym.capped,
    symbolTruth:sym.symbolTruth || null,
    allSeedsExact:sym.allSeedsExact === true,
    functionStartsComplete:sym.functionStartsComplete === true,
    functionStartsCapped:!!sym.functionStartsCapped,
    functionDiscovery:sym.functionDiscovery || null,
    nameProvenance:Array.from(sym.addrs, (addr) => sym.nameProvenance?.get?.(addr.toString()) || null),
    functionProvenance:Array.from(sym.funcs, (addr) => sym.functionProvenance?.get?.(addr.toString()) || null),
    guessed:!!sym.guessed,
    functionTopologyRevision:Number(sym.functionTopologyRevision || 0),
    functionTopologyEnds:Array.from(sym.functionTopologyEnds?.entries?.() || []),
  };
}

function captureShapes(shapes) {
  if (!(shapes instanceof Map)) return null;
  return {
    entries:Array.from(shapes.entries()),
    complete:shapes.complete,
    capped:shapes.capped,
    unsupported:shapes.unsupported,
    incompleteReason:shapes.incompleteReason ?? null,
  };
}

export function captureAppAnalysisState(app, fields = null) {
  const wanted = fields == null ? null : new Set(fields);
  const has = (name) => wanted == null || wanted.has(name);
  const out = { schemaVersion:1, savedAt:Date.now() };
  if (has('symbols')) out.symbols = captureSymbols(app);
  if (has('strings')) out.stringIndex = app?.stringIndex ?? null;
  if (has('programScan')) out.programScan = app?.programScan ?? null;
  if (has('programKey')) out.programKey = app?.programKey ?? null;
  if (has('shapes')) out.shapes = captureShapes(app?.shapes);
  if (has('schemas')) out.schemas = app?.schemas ?? null;
  if (has('autoReport')) out.autoReport = app?.autoReport ?? null;
  if (has('lastGoal')) out.lastGoal = app?.lastGoal ?? null;
  return out;
}

export function applyAppAnalysisState(app, snapshot) {
  if (!app || !snapshot || snapshot.schemaVersion !== 1) return false;
  let restored = false;
  if (snapshot.symbols) {
    const sym = new SymbolIndex(snapshot.symbols);
    sym.guessed = !!snapshot.symbols.guessed;
    sym.functionTopologyRevision = Number(snapshot.symbols.functionTopologyRevision || 0);
    sym.functionTopologyEnds = new Map(snapshot.symbols.functionTopologyEnds || []);
    for (const entry of app.notes?.nameEntries?.() || []) sym.rename(entry.addr, entry.name);
    app.symbols = sym;
    app.viewer?.setSymbols?.(sym);
    restored = true;
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, 'stringIndex') && snapshot.stringIndex != null) {
    app.stringIndex = snapshot.stringIndex;
    restored = true;
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, 'programScan') && snapshot.programScan != null) {
    app.programScan = snapshot.programScan;
    if (Object.prototype.hasOwnProperty.call(snapshot, 'programKey')) app.programKey = snapshot.programKey;
    const primary = app.codeRegion?.() || null;
    app.program = new ProgramIndex(app.programScan, app.symbols, primary);
    restored = true;
  }
  if (snapshot.shapes?.entries) {
    app.shapes = defineShapeMeta(new Map(snapshot.shapes.entries), snapshot.shapes);
    restored = true;
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, 'schemas') && snapshot.schemas != null) {
    app.schemas = snapshot.schemas;
    restored = true;
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, 'autoReport') && snapshot.autoReport != null) {
    app.autoReport = snapshot.autoReport;
    restored = true;
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, 'lastGoal') && snapshot.lastGoal != null) {
    app.lastGoal = snapshot.lastGoal;
    restored = true;
  }
  app.updateChrome?.();
  return restored;
}

export class AnalysisResumeStore {
  constructor(options = {}) {
    this.indexedDB = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
    this.dbPromise = null;
    this.writeChain = Promise.resolve();
  }

  async db() {
    if (!this.indexedDB) return null;
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const request = this.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('analysis-resume-open-failed'));
      request.onblocked = () => reject(new Error('analysis-resume-open-blocked'));
    }).catch((error) => {
      this.dbPromise = null;
      throw error;
    });
    return this.dbPromise;
  }

  async get(key) {
    const db = await this.db();
    if (!db) return null;
    const tx = db.transaction(STORE, 'readonly');
    const value = await idbRequest(tx.objectStore(STORE).get(key));
    await txDone(tx);
    return value ?? null;
  }

  async put(key, value) {
    const db = await this.db();
    if (!db) return false;
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    await txDone(tx);
    return true;
  }

  async saveLastFile(file, meta = {}) {
    if (!file || typeof file.slice !== 'function') return false;
    const blob = file.slice(0, file.size, file.type || 'application/octet-stream');
    return this.put(LAST_FILE_KEY, {
      schemaVersion:1,
      name:String(file.name || 'binary'),
      type:String(file.type || ''),
      lastModified:Number(file.lastModified || Date.now()),
      size:Number(file.size || 0),
      blob,
      ...meta,
      savedAt:Date.now(),
    });
  }

  async loadLastFile() {
    const record = await this.get(LAST_FILE_KEY);
    if (!record?.blob || record.schemaVersion !== 1) return null;
    let file;
    if (typeof File === 'function') {
      file = new File([record.blob], record.name || 'binary', { type:record.type || '', lastModified:record.lastModified || Date.now() });
    } else {
      file = record.blob;
      try { Object.defineProperty(file, 'name', { value:record.name || 'binary', configurable:true }); } catch { /* test/runtime fallback */ }
    }
    return { ...record, file };
  }

  async save(binaryId, sliceIndex, patch) {
    if (!binaryId || !Number.isSafeInteger(sliceIndex)) return false;
    const task = async () => {
      const key = sessionKey(binaryId, sliceIndex);
      const previous = await this.get(key) || { schemaVersion:1, binaryId:String(binaryId), sliceIndex };
      const next = { ...previous, ...patch, schemaVersion:1, binaryId:String(binaryId), sliceIndex, savedAt:Date.now() };
      return this.put(key, next);
    };
    const pending = this.writeChain.then(task, task);
    this.writeChain = pending.catch(() => false);
    return pending;
  }

  async load(binaryId, sliceIndex) {
    if (!binaryId || !Number.isSafeInteger(sliceIndex)) return null;
    const value = await this.get(sessionKey(binaryId, sliceIndex));
    return value?.schemaVersion === 1 ? value : null;
  }
}
