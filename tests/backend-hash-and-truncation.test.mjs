import assert from 'node:assert/strict';
import test from 'node:test';

const workers = [];
class MockWorker {
  constructor(url) {
    this.url = String(url);
    this.sent = [];
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
    workers.push(this);
  }
  postMessage(message) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(request, result, { ok = true, error = null } = {}) {
    this.onmessage?.({
      data: ok
        ? { t: 'ok', id: request.id, epoch: request.epoch, result }
        : { t: 'err', id: request.id, epoch: request.epoch, error: error || 'failed' },
    });
  }
}

globalThis.Worker = MockWorker;

const { Backend, normalizeIntegrityWarnings } = await import('../js/backend.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function createBackendPair() {
  const backend = new Backend();
  const legacy = backend._worker('legacy');
  const platform = backend._worker('platform');
  assert.ok(legacy && platform, 'expected legacy and platform workers');
  return { backend, legacy, platform };
}

test('normalizeIntegrityWarnings: collects, deduplicates, and flags truncation from all sources', () => {
  const result = {
    format: 'Mach-O 64-bit',
    warnings: ['  existing warning  ', 'existing warning'],
    slices: [
      {
        warnings: ['slice warning', 'existing warning'],
        error: 'Fat slice 1 could not be parsed: truncated header',
        info: {
          diagnostics: [
            '__TEXT: invalid segment file/VM range',
            '__TEXT: invalid segment file/VM range',
          ],
          truncated: false,
        },
      },
    ],
  };

  const out = normalizeIntegrityWarnings(result, ['extra warning', 'slice warning'], false);
  assert.equal(out, result);
  assert.equal(out.truncated, true);
  assert.deepEqual(out.warnings, [
    'existing warning',
    'extra warning',
    'slice warning',
    'Fat slice 1 could not be parsed: truncated header',
    '__TEXT: invalid segment file/VM range',
  ]);
});

test('normalizeIntegrityWarnings: detects every truncation keyword and boolean flag without false positives', () => {
  const keywords = [
    'Mach-O file is truncated at 2MB',
    '__TEXT: invalid segment file/VM range',
    '__DATA: section table exceeds command',
    'damaged header detected',
    'slice 0 could not be parsed',
    'invalid load-command size/alignment',
  ];
  for (const msg of keywords) {
    const res = normalizeIntegrityWarnings({ warnings: [] }, [msg], false);
    assert.equal(res.truncated, true, `expected truncated=true for "${msg}"`);
    assert.deepEqual(res.warnings, [msg]);
  }

  const bySliceFlag = normalizeIntegrityWarnings({
    slices: [{ info: { truncated: true } }],
  });
  assert.equal(bySliceFlag.truncated, true);
  assert.deepEqual(bySliceFlag.warnings, []);

  const byForceFlag = normalizeIntegrityWarnings({ format: 'Raw binary' }, [], true);
  assert.equal(byForceFlag.truncated, true);

  const clean = normalizeIntegrityWarnings({
    format: 'ELF 64-bit',
    warnings: ['informational note only'],
    slices: [{ info: { diagnostics: [] } }],
  });
  assert.equal(clean.truncated, false);
  assert.deepEqual(clean.warnings, ['informational note only']);
});

test('Backend.open() path 1 (hybrid-macho): propagates platformInfo and legacy slice diagnostics & truncation', async () => {
  const { backend, legacy, platform } = createBackendPair();
  const file = { name: 'tsumtsum-2mb.bin', size: 2 * 1024 * 1024 };

  const openPromise = backend.open(file);
  await tick();

  const platformOpen = platform.sent.find((m) => m.t === 'open' && m.file === file);
  assert.ok(platformOpen);
  platform.reply(platformOpen, {
    formatId: 'macho',
    detection: { formatId: 'macho', truncated: true },
    warnings: ['platform detected truncated Mach-O', '__TEXT: invalid segment file/VM range'],
    truncated: true,
    slices: [{ info: { diagnostics: ['platform slice diagnostic'] }, truncated: true }],
  });

  await tick();
  const legacyOpen = legacy.sent.find((m) => m.t === 'open' && m.file === file);
  assert.ok(legacyOpen);
  legacy.reply(legacyOpen, {
    format: 'Mach-O 64-bit',
    warnings: ['__TEXT: invalid segment file/VM range'],
    slices: [
      {
        info: {
          architecture: 'arm64',
          isArm64: true,
          diagnostics: ['__TEXT: invalid segment file/VM range', '__LINKEDIT: section outside parent/slice range'],
          truncated: true,
        },
      },
    ],
    raw: { id: 'raw' },
  });

  const result = await openPromise;
  assert.equal(result.platform.compatibility, 'hybrid-macho');
  assert.equal(result.truncated, true);
  assert.deepEqual(result.warnings, [
    '__TEXT: invalid segment file/VM range',
    'platform detected truncated Mach-O',
    'platform slice diagnostic',
    '__LINKEDIT: section outside parent/slice range',
  ]);
  backend.dispose();
});

test('Backend.open() path 2 (non-Mach-O platformInfo direct return): propagates ELF/PE truncation and warnings', async () => {
  const { backend, platform } = createBackendPair();
  const file = { name: 'truncated.elf', size: 4096 };

  const openPromise = backend.open(file);
  await tick();

  const platformOpen = platform.sent.find((m) => m.t === 'open' && m.file === file);
  assert.ok(platformOpen);
  platform.reply(platformOpen, {
    formatId: 'elf',
    capability: { format: 'elf', architecture: 'x86_64' },
    warnings: ['ELF section header table exceeds file size'],
    slices: [
      {
        truncated: true,
        warnings: ['ELF section header table exceeds file size', 'ELF string table truncated'],
        info: { diagnostics: ['section 3 exceeds file bounds'] },
      },
    ],
    raw: { id: 'raw' },
  });

  const result = await openPromise;
  assert.equal(result.formatId, 'elf');
  assert.equal(result.truncated, true);
  assert.deepEqual(result.warnings, [
    'ELF section header table exceeds file size',
    'ELF string table truncated',
    'section 3 exceeds file bounds',
  ]);
  backend.dispose();
});

test('Backend.open() path 3a (legacy-macho fallback): propagates platformError and Fat slice error into truncated & warnings', async () => {
  const { backend, legacy, platform } = createBackendPair();
  const file = { name: 'truncated-fat.macho', size: 2 * 1024 * 1024 };

  const openPromise = backend.open(file);
  await tick();

  const platformOpen = platform.sent.find((m) => m.t === 'open' && m.file === file);
  assert.ok(platformOpen);
  platform.reply(platformOpen, null, {
    ok: false,
    error: 'Mach-O load command area is truncated.',
  });

  await tick();
  const legacyOpen = legacy.sent.find((m) => m.t === 'open' && m.file === file);
  assert.ok(legacyOpen);
  legacy.reply(legacyOpen, {
    format: 'Fat Mach-O',
    slices: [
      {
        error: 'Fat slice arm64 could not be parsed: Slice is truncated.',
      },
      {
        info: {
          architecture: 'arm64',
          isArm64: true,
          diagnostics: ['__TEXT: invalid segment file/VM range'],
        },
      },
    ],
    raw: { id: 'raw' },
  });

  const result = await openPromise;
  assert.equal(result.platform.compatibility, 'legacy-macho');
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.includes('Mach-O load command area is truncated.'));
  assert.ok(result.warnings.includes('Fat slice arm64 could not be parsed: Slice is truncated.'));
  assert.ok(result.warnings.includes('__TEXT: invalid segment file/VM range'));
  backend.dispose();
});

test('Backend.open() path 3b (Raw binary fallback): propagates platformError and flags truncation', async () => {
  const { backend, legacy, platform } = createBackendPair();
  const file = { name: 'damaged-raw.bin', size: 1024 };

  const openPromise = backend.open(file);
  await tick();

  const platformOpen = platform.sent.find((m) => m.t === 'open' && m.file === file);
  assert.ok(platformOpen);
  platform.reply(platformOpen, null, {
    ok: false,
    error: 'PE optional header is truncated',
  });

  await tick();
  const legacyOpen = legacy.sent.find((m) => m.t === 'open' && m.file === file);
  assert.ok(legacyOpen);
  legacy.reply(legacyOpen, {
    format: 'Raw binary',
    warnings: ['PE optional header is truncated'],
    slices: [],
    raw: { id: 'raw', exec: true },
  });

  const result = await openPromise;
  assert.equal(result.format, 'Raw binary');
  assert.equal(result.truncated, true);
  assert.deepEqual(result.warnings, ['PE optional header is truncated']);
  backend.dispose();
});

test('Backend.ensureContentHash (fnv1a64:) and ensureBinaryId (bin_sha256_<64hex>) contracts remain intact', async () => {
  const { backend, platform } = createBackendPair();
  const payload = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);
  const blob = new Blob([payload]);
  Object.defineProperty(blob, 'name', { value: 'sample.macho' });

  backend.file = blob;
  const hashPromise = backend.ensureContentHash();
  await tick();
  const hashReq = platform.sent.find((m) => m.t === 'hash');
  assert.ok(hashReq, 'ensureContentHash must query platform hash worker');
  platform.reply(hashReq, { hash: 'fnv1a64:8:0123456789abcdef' });

  const contentHash = await hashPromise;
  assert.match(contentHash, /^fnv1a64:/);

  const binaryId = await backend.ensureBinaryId();
  assert.match(binaryId, /^bin_sha256_[0-9a-f]{64}$/);
  backend.dispose();
});

test('normalizeIntegrityWarnings: catches PE truncation wording and relocation-outside-slice diagnostics', () => {
  const peResult = normalizeIntegrityWarnings({
    format: 'PE',
    warnings: ['PE section table: the missing range is truncation, not a format fact'],
  });
  assert.equal(peResult.truncated, true);

  const relocResult = normalizeIntegrityWarnings({
    format: 'Mach-O 64-bit',
    slices: [{ info: { diagnostics: ['__text: relocation table outside slice'] } }],
  });
  assert.equal(relocResult.truncated, true);
  assert.ok(relocResult.warnings.includes('__text: relocation table outside slice'));
});

test('normalizeIntegrityWarnings: excludes budget/limit warnings from truncation while catching ABI minimum and EOF warnings', () => {
  const budgetWarnings = [
    'dylib install name exceeds the decoded-name budget',
    'section table exceeds materialization limit',
    'symbol table exceeds record limit',
    'cache limit exceeded during decode',
    'dyld shared cache slide info 0 exceeds bounded parser limit',
  ];
  for (const msg of budgetWarnings) {
    const res = normalizeIntegrityWarnings({ format: 'Mach-O 64-bit', warnings: [] }, [msg], false);
    assert.equal(res.truncated, false, `expected truncated=false for budget/limit warning "${msg}"`);
    assert.deepEqual(res.warnings, [msg]);
  }

  const truncationWarnings = [
    'LC_SYMTAB shorter than ABI minimum',
    'segment __TEXT extends past end of file',
  ];
  for (const msg of truncationWarnings) {
    const res = normalizeIntegrityWarnings({ format: 'Mach-O 64-bit', warnings: [] }, [msg], false);
    assert.equal(res.truncated, true, `expected truncated=true for "${msg}"`);
    assert.deepEqual(res.warnings, [msg]);
  }
});
