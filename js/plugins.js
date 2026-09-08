/*
 * User-installed sandbox plugins plus the stable platform contribution API.
 * User plugins never receive core parser objects directly; platform plugins
 * use the isolated registry exported at the bottom of this module.
 *
 * #2622: script.js/sandbox.js are optional feature code. They must stay out of
 * the startup module graph and load only when a plugin is actually installed
 * or run, so the startup boundary below is dynamic-import only.
 */
import { stableDigest } from './core/identity/index.js';

const STORE_KEY = 'hex.plugins';
export const MAX_PLUGIN_SOURCE_BYTES = 512 * 1024;
const sourceBytes = (source) => new TextEncoder().encode(String(source || '')).byteLength;

// A persisted v3 manifest must be provably derived from the source it claims:
// install() records digests of the source and of the canonical discovery
// result, and the restore fast path verifies both before trusting the
// persisted definitions (#6080). Without this binding, drifted/corrupted
// metadata executes defs[index] of a DIFFERENT plugin than the displayed name.
function manifestSourceDigest(source) { return stableDigest(source); }
function manifestDefinitionsDigest(definitions) { return stableDigest(definitions); }
function manifestIsBound(record) {
  return record.sourceDigest === manifestSourceDigest(record.source)
    && record.definitionsDigest === manifestDefinitionsDigest(record.definitions);
}
function selectedPluginIsBound(plugin, installation) {
  if (!installation || installation.source !== plugin.source || !Array.isArray(installation.definitions)) return false;
  const definition = installation.definitions.find((candidate) => candidate?.index === plugin.index);
  return !!definition
    && definition.name === plugin.name
    && definition.description === plugin.description;
}

/* Plugin identity is persisted state: only canonical primitives may enter the
   installation/plugin ID namespaces (#5655). A structured or coerced
   installationId would alias a real installation's Map key, and a coerced
   enabled/definition index would enable a definition the user never did. */
function canonicalInstallationId(value, fallback = null) {
  if (typeof value === 'string' && value.trim()) return value;
  return fallback;
}
function canonicalPluginIndex(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function canonicalEnabledIndexSet(values) {
  if (!Array.isArray(values)) return null;
  const enabled = new Set();
  for (const value of values) {
    const index = canonicalPluginIndex(value);
    if (index == null) continue;
    enabled.add(index);
  }
  return enabled;
}
let fallbackInstallSeq = 1;

let scriptSandboxPromise = null;
function loadScriptSandbox() {
  if (!scriptSandboxPromise) {
    scriptSandboxPromise = Promise.all([
      import('./script.js'),
      import('./sandbox.js'),
    ]).then(([script, sandbox]) => ({ createApi: script.createApi, runInSandbox: sandbox.runInSandbox }));
  }
  return scriptSandboxPromise;
}

function newInstallId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `install_${Date.now().toString(36)}_${(fallbackInstallSeq++).toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function snapshotRegistryState(host) {
  return {
    plugins: host.plugins.slice(),
    installations: new Map(host.installations),
  };
}

function restoreRegistryState(host, snapshot) {
  host.plugins = snapshot.plugins;
  host.installations.clear();
  for (const [id, installation] of snapshot.installations) {
    host.installations.set(id, installation);
  }
}

function saveRegistryOrRollback(host, snapshot) {
  const saved = host.save();
  if (!saved.ok) restoreRegistryState(host, snapshot);
  return saved;
}

async function boundedResponseText(res, maxBytes = MAX_PLUGIN_SOURCE_BYTES) {
  const rawLength = res.headers?.get?.('content-length');
  if (rawLength != null && rawLength !== '') {
    const n = Number(rawLength);
    if (Number.isFinite(n) && n > maxBytes) throw new Error('PLUGIN_TOO_LARGE');
  }
  if (!res.body?.getReader) {
    const n = Number(rawLength);
    if (!Number.isFinite(n) || n < 0 || n > maxBytes) throw new Error('PLUGIN_UNBOUNDED_RESPONSE');
    const text = await res.text();
    if (sourceBytes(text) > maxBytes) throw new Error('PLUGIN_TOO_LARGE');
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength || 0;
      if (total > maxBytes) {
        try { await reader.cancel('plugin source exceeds limit'); } catch {}
        throw new Error('PLUGIN_TOO_LARGE');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    try { reader.releaseLock?.(); } catch {}
  }
  if (sourceBytes(text) > maxBytes) throw new Error('PLUGIN_TOO_LARGE');
  return text;
}

export class PluginHost {
  constructor(app) {
    this.app = app;
    this.plugins = [];
    this.installations = new Map();
    this.ready = this.load();
  }

  async load() {
    let raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch { return; }
    if (!raw) return;
    try {
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return;
      const legacySeen = new Set();
      for (const p of list) {
        if (!p || typeof p.source !== 'string') continue;
        /* A present-but-malformed installationId would alias a canonical
           installation's Map key; skipping the entry beats laundering it (#5655). */
        if (p.installationId != null && canonicalInstallationId(p.installationId) == null) continue;
        // v3 manifest fast path: restore registry directly without sandbox execution
        if (p.v === 3 && Array.isArray(p.definitions) && p.definitions.length > 0 && p.installationId) {
          // #6080: the fast path is only sound while the persisted definitions
          // are provably the discovery result of the persisted source. A
          // manifest without (or failing) the source/definitions binding falls
          // back to real discovery so the executed defs[index] always matches
          // the displayed metadata.
          if (!manifestIsBound(p)) {
            await this.install(p.source, p.origin || '保存されたもの', {
              silent: true,
              installationId: p.installationId,
              enabledIndexes: Array.isArray(p.enabledIndexes) ? p.enabledIndexes : null,
            });
            continue;
          }
          const installationId = canonicalInstallationId(p.installationId, newInstallId());
          const definitions = p.definitions.filter((def) => canonicalPluginIndex(def?.index) != null);
          const enabled = canonicalEnabledIndexSet(p.enabledIndexes)
            ?? new Set(definitions.map((def) => def.index));
          const all = definitions.map((def) => ({
            id: `${installationId}:${def.index}`,
            installationId,
            name: def.name,
            description: def.description,
            index: def.index,
            source: p.source,
            origin: p.origin || '保存されたもの',
          }));
          const added = all.filter((plugin) => enabled.has(plugin.index));
          this.plugins.push(...added);
          this.installations.set(installationId, {
            v: 3,
            installationId,
            source: p.source,
            origin: p.origin || '保存されたもの',
            definitions: p.definitions,
            enabledIndexes: Array.from(enabled),
            sourceDigest: p.sourceDigest,
            definitionsDigest: p.definitionsDigest,
          });
          continue;
        }

        /* v1/v2 legacy fallback */
        if (!p.installationId) {
          const legacyKey = `${p.origin || ''}\u0000${p.source}`;
          if (legacySeen.has(legacyKey)) continue;
          legacySeen.add(legacyKey);
        }
        await this.install(p.source, p.origin || '保存されたもの', {
          silent: true,
          installationId: p.installationId || newInstallId(),
          enabledIndexes: Array.isArray(p.enabledIndexes) ? p.enabledIndexes : null,
        });
      }
    } catch { /* corrupted plugin storage is isolated */ }
  }

  save() {
    const list = [];
    const seen = new Set();
    for (const [id, inst] of this.installations.entries()) {
      seen.add(id);
      const activeIndexes = this.plugins.filter((p) => p.installationId === id).map((p) => p.index);
      list.push({
        v: 3,
        installationId: id,
        source: inst.source,
        origin: inst.origin,
        definitions: inst.definitions || [],
        enabledIndexes: activeIndexes,
        ...(inst.sourceDigest == null ? {} : { sourceDigest: inst.sourceDigest }),
        ...(inst.definitionsDigest == null ? {} : { definitionsDigest: inst.definitionsDigest }),
      });
    }
    for (const p of this.plugins) {
      if (seen.has(p.installationId)) continue;
      seen.add(p.installationId);
      const activePlugins = this.plugins.filter((x) => x.installationId === p.installationId);
      const definitions = activePlugins.map((x) => ({ index: x.index, name: x.name, description: x.description }));
      list.push({
        v: 3,
        installationId: p.installationId,
        source: p.source,
        origin: p.origin,
        definitions,
        enabledIndexes: activePlugins.map((x) => x.index),
        sourceDigest: manifestSourceDigest(p.source),
        definitionsDigest: manifestDefinitionsDigest(definitions),
      });
    }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(list));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error && error.message) || 'plugin storage failed' };
    }
  }

  async install(source, origin, opts = {}) {
    if (typeof source !== 'string' || !source.trim()) return { error: '中身が空です。' };
    if (sourceBytes(source) > MAX_PLUGIN_SOURCE_BYTES) return { error: 'プラグインが大きすぎます（512 KB まで）。' };
    const { runInSandbox } = await loadScriptSandbox();
    const discovered = await runInSandbox({
      source, mode: 'discover', api: Object.create(null), out: () => {}, timeout: 10000,
    });
    if (discovered.error) return { error: '読み込めませんでした: ' + discovered.error };

    const installationId = canonicalInstallationId(opts.installationId, newInstallId());
    const enabled = canonicalEnabledIndexSet(opts.enabledIndexes);
    const definitions = (discovered.value || []).map((def, index) => ({
      index,
      name: def.name,
      description: def.description,
    }));
    const sourceDigest = manifestSourceDigest(source);
    const definitionsDigest = manifestDefinitionsDigest(definitions);
    const all = definitions.map((def) => ({
      id: `${installationId}:${def.index}`,
      installationId,
      name: def.name,
      description: def.description,
      index: def.index,
      source,
      origin: origin || '不明',
    }));
    if (!all.length) return { error: 'プラグインが 1 つも登録されませんでした（hex.plugin({…}) を呼んでください）。' };
    const added = enabled ? all.filter((plugin) => enabled.has(plugin.index)) : all;
    /* A persisted installation may intentionally have no enabled definitions;
       a fresh installation may not. */
    if (!added.length && !enabled) return { error: 'プラグインが 1 つも登録されませんでした（hex.plugin({…}) を呼んでください）。' };

    const before = !opts.silent ? snapshotRegistryState(this) : null;
    this.installations.set(installationId, {
      v: 3,
      installationId,
      source,
      origin: origin || '不明',
      definitions,
      enabledIndexes: added.map((p) => p.index),
      sourceDigest,
      definitionsDigest,
    });

    this.plugins.push(...added);
    if (!opts.silent) {
      const saved = saveRegistryOrRollback(this, before);
      if (!saved.ok) {
        return { error: 'プラグインを保存できませんでした: ' + saved.error, persistenceError: true };
      }
    }
    return { ok: true, added, installationId };
  }

  async installFromUrl(url) {
    let text;
    try {
      const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) return { error: '取り寄せられませんでした（' + res.status + '）。' };
      text = await boundedResponseText(res);
    } catch (err) {
      if (err?.message === 'PLUGIN_TOO_LARGE') return { error: 'プラグインが大きすぎます（512 KB まで）。' };
      if (err?.message === 'PLUGIN_UNBOUNDED_RESPONSE') return { error: 'サイズを安全に確認できない応答だったため読み込みませんでした。' };
      return { error: '取り寄せに失敗しました: ' + ((err && err.message) || err) };
    }
    return { ok: true, source: text, origin: url, needsConfirmation: true };
  }

  remove(id) {
    const before = this.plugins.slice();
    this.plugins = this.plugins.filter((p) => p.id !== id);
    const saved = this.save();
    if (!saved.ok) {
      this.plugins = before;
      return { ok: false, error: saved.error, persistenceError: true };
    }
    return { ok: true };
  }

  clear() {
    const before = snapshotRegistryState(this);
    this.plugins = [];
    this.installations.clear();
    const saved = saveRegistryOrRollback(this, before);
    if (!saved.ok) {
      return { ok: false, error: saved.error, persistenceError: true };
    }
    return { ok: true };
  }

  async run(id, out, options = {}) {
    const p = this.plugins.find((x) => x.id === id);
    if (!p) return { error: 'そのプラグインが見つかりません。' };
    // The manifest check protects restore, but the public registry objects can
    // still be mutated after load. Never execute a selected entry whose source
    // or display metadata has drifted from its canonical installation record.
    const installation = this.installations.get(p.installationId);
    if (!selectedPluginIsBound(p, installation)) {
      return { error: 'プラグイン定義が保存内容と一致しません。再読み込みしてください。' };
    }
    const signal = options?.signal ?? null;
    if (signal?.aborted) return { error:'キャンセルされました。', aborted:true };
    const { createApi, runInSandbox } = await loadScriptSandbox();
    const { api, print } = createApi(this.app, out, options);
    return runInSandbox({ source: p.source, mode: 'plugin', index: p.index, api,
      out: (...args) => print(...args),
      expectedDefinition: { name: p.name, description: p.description }, signal });
  }
}

export const EXAMPLE_PLUGIN = `hex.plugin({
  name: '大きい関数を並べる',
  description: '命令数の多い関数から順に 30 個。処理の中心を探すときに。',
  async run(hex, print) {
    const list = (await hex.functions())
      .filter((f) => f.size)
      .sort((a, b) => Number(b.size - a.size))
      .slice(0, 30);
    for (const f of list) {
      print(hex.hex(f.addr), String(Number(f.size) / 4) + ' 命令', f.name || '');
    }
  },
});`;

export {
  PlatformPluginRegistry, platformPlugins,
  registerFormat, registerArchitecture, registerAnalyzer, registerKnowledgeProvider,
  registerSignatureProvider, registerRecognitionProvider,
  registerViewContribution, registerGoalProvider,
} from './platform/plugin-api.js';
