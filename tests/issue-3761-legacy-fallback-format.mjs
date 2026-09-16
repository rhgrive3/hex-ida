// Regression for #3761: when platform open fails and the legacy worker's open
// fallback succeeds, Backend.open() must derive the authoritative format from
// the legacy parser's structured fields (parsed slice info / raw-only view),
// not leave formatId 'unknown' while claiming a successful open. A legacy
// Mach-O success must route later analyze/metadata calls back to the legacy
// engine; a legacy format that cannot be safely determined must fail closed
// instead of publishing an incoherent state.
import assert from 'node:assert/strict';

const workers = [];
class ControlledWorker {
  constructor(url) {
    this.url = String(url);
    this.sent = [];
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
    workers.push(this);
  }
  postMessage(message) { this.sent.push(message); }
  terminate() { this.terminated = true; }
  reply(request, result, { ok = true, error = null } = {}) {
    assert.ok(request, 'reply requires an observed request');
    this.onmessage?.({ data: ok
      ? { t: 'ok', id: request.id, epoch: request.epoch, result }
      : { t: 'err', id: request.id, epoch: request.epoch, error: error || 'failed' } });
  }
}
globalThis.Worker = ControlledWorker;

const { Backend } = await import('../js/backend.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const find = (worker, predicate) => worker.sent.find(predicate);

function getPlatform(since) { return workers.slice(since).find((w) => /platform\/worker\.js/.test(w.url)); }
function getLegacy(since) { return workers.slice(since).find((w) => /worker\.js/.test(w.url) && !/platform/.test(w.url)); }

function machoLegacyResult() {
  return {
    name: 'app.bin',
    size: 4096n,
    format: 'Mach-O 64-bit',
    slices: [{
      name: 'arm64',
      offset: 0n,
      size: 4096n,
      info: { cpu: 12, cpuSub: 'arm64', architecture: 'arm64', is64: true, isArm64: true, pointerBits: 64 },
      regions: [],
    }],
    warnings: [],
    raw: { id: 'raw', kind: 'file', name: 'Whole file (raw)', fileOffset: 0n, vmAddr: 0n, size: 4096n, declaredSize: 4096n, exec: false, zerofill: false, truncated: false },
  };
}

function rawLegacyResult() {
  return {
    name: 'data.bin',
    size: 16n,
    format: 'Raw binary',
    slices: [],
    warnings: [],
    raw: { id: 'raw', kind: 'file', name: 'Whole file (raw)', fileOffset: 0n, vmAddr: 0n, size: 16n, declaredSize: 16n, exec: true, zerofill: false, truncated: false },
  };
}

const file = { name: 'app.bin', size: 4096, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) };

// Scenario 1: platform open failure + legacy Mach-O success => coherent macho state.
{
  const since = workers.length;
  const backend = new Backend();
  const open = backend.open(file);
  await tick();
  const platform = getPlatform(since);
  assert.ok(platform);
  const platformOpen = find(platform, (m) => m.t === 'open' && m.file === file);
  platform.reply(platformOpen, null, { ok: false, error: 'platform open failed' });
  await tick();
  const legacy = getLegacy(since);
  assert.ok(legacy, 'platform open failure must reach the legacy open fallback');
  const legacyOpen = find(legacy, (m) => m.t === 'open' && m.file === file);
  const legacyResult = machoLegacyResult();
  legacy.reply(legacyOpen, legacyResult);
  const result = await open;

  assert.equal(backend.formatId, 'macho', 'legacy Mach-O fallback must publish its authoritative format');
  assert.equal(result, legacyResult);
  assert.equal(backend.legacyInfo, legacyResult);
  assert.equal(legacyResult.formatId, 'macho');
  assert.ok(legacyResult.slices[0].capability, 'legacy fallback must normalize slice capabilities');
  assert.equal(backend.platformInfo?.normalizedDyldTruth, false, 'a failed platform open is not normalized truth');

  // Condition 2: current analysis routes to the legacy engine, never back to
  // the platform worker that already failed this open.
  const analysis = backend.analyze(0, { route: 'current' });
  await tick();
  const legacyAnalyze = find(legacy, (m) => m.t === 'analyze');
  assert.ok(legacyAnalyze, 'legacy-fallback Mach-O must analyze through the legacy engine');
  assert.equal(platform.sent.some((m) => m.t === 'analyze'), false, 'failed platform worker must not receive analysis');
  legacy.reply(legacyAnalyze, { addrs: new BigUint64Array(0), kinds: new Uint8Array(0), flags: new Uint8Array(0), names: [], funcs: new BigUint64Array(0) });
  const analysisResult = await analysis;
  assert.ok(analysisResult.symbolTruth, 'legacy-only analysis must disclose non-normalized symbol truth');

  // Condition 3: binaryMetadata stays on the legacy-compatible path.
  const meta = await backend.binaryMetadata();
  assert.equal(platform.sent.some((m) => m.t === 'metadata'), false, 'metadata must not route to the failed platform worker');
  assert.equal(meta.summary.format, 'macho');
  assert.equal(meta.metadata.compatibility, 'legacy-macho');
}

// Scenario 2: legacy raw fallback stays explicit — no fabricated format.
{
  const since = workers.length;
  const backend = new Backend();
  const open = backend.open(file);
  await tick();
  const platform = getPlatform(since);
  assert.ok(platform);
  const platformOpen = find(platform, (m) => m.t === 'open' && m.file === file);
  platform.reply(platformOpen, null, { ok: false, error: 'platform open failed' });
  await tick();
  const legacy = getLegacy(since);
  const legacyOpen = find(legacy, (m) => m.t === 'open' && m.file === file);
  const rawResult = rawLegacyResult();
  legacy.reply(legacyOpen, rawResult);
  const result = await open;
  assert.equal(result, rawResult);
  assert.equal(backend.formatId, 'unknown', 'raw fallback must not invent a canonical format');
  assert.ok(rawResult.warnings.some((w) => /platform open failed/.test(w)), 'raw fallback must disclose the failed platform open');
}

// Scenario 3: undeterminable legacy result fails closed instead of publishing
// an incoherent open state.
{
  const since = workers.length;
  const backend = new Backend();
  const open = backend.open(file);
  await tick();
  const platform = getPlatform(since);
  assert.ok(platform);
  const platformOpen = find(platform, (m) => m.t === 'open' && m.file === file);
  platform.reply(platformOpen, null, { ok: false, error: 'platform open failed' });
  await tick();
  const legacy = getLegacy(since);
  const legacyOpen = find(legacy, (m) => m.t === 'open' && m.file === file);
  legacy.reply(legacyOpen, {
    name: 'broken.bin', size: 4096n, format: 'Mach-O 64-bit (damaged header)',
    slices: [], warnings: ['header parse failed'],
    raw: { id: 'raw', kind: 'file', exec: false, fileOffset: 0n, vmAddr: 0n, size: 4096n, declaredSize: 4096n },
  });
  await assert.rejects(open, /could not determine/i, 'an undeterminable legacy fallback must not resolve as a successful open');
  assert.equal(backend.file, null, 'failed open must not commit backend state');
  assert.equal(backend.legacyInfo, null);
  assert.equal(backend.formatId, 'unknown');
}

// Scenario 4: platform-success hybrid Mach-O path is unchanged.
{
  const since = workers.length;
  const backend = new Backend();
  const open = backend.open(file);
  await tick();
  const platform = getPlatform(since);
  assert.ok(platform);
  const platformOpen = find(platform, (m) => m.t === 'open' && m.file === file);
  platform.reply(platformOpen, {
    formatId: 'macho', detection: { formatId: 'macho' }, capability: { architecture: 'arm64' }, slices: [], raw: { id: 'platform-raw' },
  });
  await tick();
  const legacy = getLegacy(since);
  const legacyOpen = find(legacy, (m) => m.t === 'open' && m.file === file);
  const hybrid = machoLegacyResult();
  legacy.reply(legacyOpen, hybrid);
  const result = await open;
  assert.equal(result, hybrid);
  assert.equal(backend.formatId, 'macho');
  assert.equal(backend.platformInfo.compatibility, 'hybrid-macho');
  assert.equal(backend.platformInfo.normalizedDyldTruth, true);
}

// Scenario 5: platform-success ELF routing is unchanged.
{
  const since = workers.length;
  const backend = new Backend();
  const open = backend.open(file);
  await tick();
  const platform = getPlatform(since);
  const platformOpen = find(platform, (m) => m.t === 'open' && m.file === file);
  platform.reply(platformOpen, {
    formatId: 'elf', detection: { formatId: 'elf' }, capability: { architecture: 'x86_64' }, slices: [], raw: { id: 'platform-raw' },
  });
  const result = await open;
  assert.equal(backend.formatId, 'elf');
  assert.equal(backend.arm64Bridge, false);
  assert.equal(result.formatId, 'elf');
}

console.log('issue 3761 legacy fallback format coherence: PASS');
