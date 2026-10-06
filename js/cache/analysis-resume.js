import { SymbolIndex } from '../symbols.js';
import { ProgramIndex } from '../program.js';
import { DEPLOYMENT_COMMIT } from '../userscript/deployment-identity.generated.js';

const DB_NAME = 'hex-analysis-resume-v1';
const DB_VERSION = 1;
const STORE = 'kv';
const LAST_FILE_KEY = 'last-file';
const SESSION_PREFIX = 'session:';
const SESSION_SCHEMA = 2;
const LAST_FILE_SCHEMA = 1;
const DEVELOPMENT_IDENTITY = 'hex-analysis-resume-development-v2';

function runtimeAnalysisIdentity(globalObject = globalThis) {
  const candidates = [
    globalObject?.__HEX_DEPLOYMENT_COMMIT__,
    globalObject?.__HEX_SECURE_LOADER__?.buildId,
    DEPLOYMENT_COMMIT,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  }
  return DEVELOPMENT_IDENTITY;
}

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

function validSliceIndex(value) {
  return Number.isSafeInteger(value) && value >= 0;
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
  const out = { schemaVersion:SESSION_SCHEMA, savedAt:Date.now() };
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

function prepareAnalysisState(app, snapshot) {
  if (!app || !snapshot || snapshot.schemaVersion !== SESSION_SCHEMA) return null;
  const prepared = {};
  let symbols = app.symbols;

  if (snapshot.symbols) {
    const sym = new SymbolIndex(snapshot.symbols);
    sym.guessed = !!snapshot.symbols.guessed;
    sym.functionTopologyRevision = Number(snapshot.symbols.functionTopologyRevision || 0);
    sym.functionTopologyEnds = new Map(snapshot.symbols.functionTopologyEnds || []);
    for (const entry of app.notes?.nameEntries?.() || []) sym.rename(entry.addr, entry.name);
    prepared.symbols = sym;
    symbols = sym;
  }

  if (Object.prototype.hasOwnProperty.call(snapshot, 'stringIndex') && snapshot.stringIndex != null) {
    prepared.stringIndex = snapshot.stringIndex;
  }

  if (Object.prototype.hasOwnProperty.call(snapshot, 'programScan') && snapshot.programScan != null) {
    const primary = app.codeRegion?.() || null;
    prepared.programScan = snapshot.programScan;
    prepared.programKey = Object.prototype.hasOwnProperty.call(snapshot, 'programKey') ? snapshot.programKey : null;
    prepared.program = new ProgramIndex(snapshot.programScan, symbols, primary);
  }

  if (snapshot.shapes?.entries) {
    if (!Array.isArray(snapshot.shapes.entries)) throw new TypeError('analysis-resume-shapes-invalid');
    prepared.shapes = defineShapeMeta(new Map(snapshot.shapes.entries), snapshot.shapes);
  }

  if (Object.prototype.hasOwnProperty.call(snapshot, 'schemas') && snapshot.schemas != null) prepared.schemas = snapshot.schemas;
  if (Object.prototype.hasOwnProperty.call(snapshot, 'autoReport') && snapshot.autoReport != null) prepared.autoReport = snapshot.autoReport;
  if (Object.prototype.hasOwnProperty.call(snapshot, 'lastGoal') && snapshot.lastGoal != null) prepared.lastGoal = snapshot.lastGoal;
  return prepared;
}

export function applyAppAnalysisState(app, snapshot) {
  let prepared;
  try { prepared = prepareAnalysisState(app, snapshot); }
  catch { return false; }
  if (!prepared) return false;

  let restored = false;
  if (prepared.symbols) {
    app.symbols = prepared.symbols;
    app.viewer?.setSymbols?.(prepared.symbols);
    restored = true;
  }
  if (Object.prototype.hasOwnProperty.call(prepared, 'stringIndex')) { app.stringIndex = prepared.stringIndex; restored = true; }
  if (Object.prototype.hasOwnProperty.call(prepared, 'programScan')) {
    app.programScan = prepared.programScan;
    app.programKey = prepared.programKey;
    app.program = prepared.program;
    restored = true;
  }
  if (prepared.shapes) { app.shapes = prepared.shapes; restored = true; }
  if (Object.prototype.hasOwnProperty.call(prepared, 'schemas')) { app.schemas = prepared.schemas; restored = true; }
  if (Object.prototype.hasOwnProperty.call(prepared, 'autoReport')) { app.autoReport = prepared.autoReport; restored = true; }
  if (Object.prototype.hasOwnProperty.call(prepared, 'lastGoal')) { app.lastGoal = prepared.lastGoal; restored = true; }
  app.updateChrome?.();
  return restored;
}

export class AnalysisResumeStore {
  constructor(options = {}) {
    this.indexedDB = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
    this.storage = options.storage === undefined ? globalThis.navigator?.storage : options.storage;
    const identity = options.analysisIdentity ?? runtimeAnalysisIdentity(options.globalObject ?? globalThis);
    if (typeof identity !== 'string' || !identity.trim()) throw new TypeError('analysis-resume-identity-invalid');
    this.analysisIdentity = identity.trim().toLowerCase();
    this.dbPromise = null;
    this.writeChain = Promise.resolve();
    this.fileWriteChain = Promise.resolve();
    this.persistRequest = null;
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
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { try { db.close(); } catch {} this.dbPromise = null; };
        resolve(db);
      };
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

  async deleteKey(key) {
    const db = await this.db();
    if (!db) return false;
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    await txDone(tx);
    return true;
  }

  async requestPersistentStorage() {
    if (!this.storage?.persist) return false;
    if (this.persistRequest) return this.persistRequest;
    this.persistRequest = (async () => {
      try {
        if (typeof this.storage.persisted === 'function' && await this.storage.persisted()) return true;
        return !!(await this.storage.persist());
      } catch { return false; }
    })();
    return this.persistRequest;
  }

  async deleteSessionsForBinary(binaryId) {
    if (!binaryId) return false;
    const db = await this.db();
    if (!db) return false;
    const prefix = `${SESSION_PREFIX}${String(binaryId)}:`;
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const request = store.openKeyCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (String(cursor.primaryKey).startsWith(prefix)) cursor.delete();
      cursor.continue();
    };
    request.onerror = () => { try { tx.abort(); } catch {} };
    await txDone(tx);
    return true;
  }

  async saveLastFile(file, meta = {}) {
    if (!file || typeof file.slice !== 'function') return false;
    const task = async () => {
      const previous = await this.get(LAST_FILE_KEY).catch(() => null);
      const supersededBinaryId = previous?.binaryId || previous?.supersededBinaryId || null;
      const record = {
        schemaVersion:LAST_FILE_SCHEMA,
        name:String(file.name || 'binary'),
        type:String(file.type || ''),
        lastModified:Number(file.lastModified || Date.now()),
        size:Number(file.size || 0),
        blob:file.slice(0, file.size, file.type || 'application/octet-stream'),
        ...meta,
        supersededBinaryId:meta.binaryId ? null : supersededBinaryId,
        savedAt:Date.now(),
      };
      const saved = await this.put(LAST_FILE_KEY, record);
      if (saved) void this.requestPersistentStorage();
      return saved;
    };
    const pending = this.fileWriteChain.then(task, task);
    this.fileWriteChain = pending.catch(() => false);
    return pending;
  }

  async updateLastFileMeta(meta = {}) {
    const task = async () => {
      const previous = await this.get(LAST_FILE_KEY).catch(() => null);
      if (!previous?.blob || previous.schemaVersion !== LAST_FILE_SCHEMA) return false;
      const supersededBinaryId = previous.supersededBinaryId || null;
      const next = { ...previous, ...meta, supersededBinaryId:null, savedAt:Date.now() };
      const saved = await this.put(LAST_FILE_KEY, next);
      if (saved && meta.binaryId && supersededBinaryId && supersededBinaryId !== meta.binaryId) {
        await this.writeChain.catch(() => false);
        await this.deleteSessionsForBinary(supersededBinaryId).catch(() => false);
      }
      return saved;
    };
    const pending = this.fileWriteChain.then(task, task);
    this.fileWriteChain = pending.catch(() => false);
    return pending;
  }

  async loadLastFile() {
    const record = await this.get(LAST_FILE_KEY);
    if (!record?.blob || record.schemaVersion !== LAST_FILE_SCHEMA) return null;
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
    if (!binaryId || !validSliceIndex(sliceIndex)) return false;
    const task = async () => {
      const key = sessionKey(binaryId, sliceIndex);
      const observed = await this.get(key);
      const previous = observed?.schemaVersion === SESSION_SCHEMA
        && observed.analysisIdentity === this.analysisIdentity
        && observed.binaryId === String(binaryId)
        && observed.sliceIndex === sliceIndex
        ? observed
        : { schemaVersion:SESSION_SCHEMA, analysisIdentity:this.analysisIdentity, binaryId:String(binaryId), sliceIndex };
      const next = {
        ...previous,
        ...patch,
        schemaVersion:SESSION_SCHEMA,
        analysisIdentity:this.analysisIdentity,
        binaryId:String(binaryId),
        sliceIndex,
        savedAt:Date.now(),
      };
      return this.put(key, next);
    };
    const pending = this.writeChain.then(task, task);
    this.writeChain = pending.catch(() => false);
    return pending;
  }

  async load(binaryId, sliceIndex) {
    if (!binaryId || !validSliceIndex(sliceIndex)) return null;
    const key = sessionKey(binaryId, sliceIndex);
    const value = await this.get(key);
    const valid = value?.schemaVersion === SESSION_SCHEMA
      && value.analysisIdentity === this.analysisIdentity
      && value.binaryId === String(binaryId)
      && value.sliceIndex === sliceIndex;
    if (valid) return value;
    if (value != null) await this.deleteKey(key).catch(() => false);
    return null;
  }

  async delete(binaryId, sliceIndex) {
    if (!binaryId || !validSliceIndex(sliceIndex)) return false;
    return this.deleteKey(sessionKey(binaryId, sliceIndex));
  }

}
