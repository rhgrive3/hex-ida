import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizePlatformName,
  selectTilPacksForBinary,
  resolveSafePackUrl,
  createTilAutoLoader,
} from '../js/analysis/types/core/til-auto-loader.js';
import { TilPackManager } from '../js/analysis/types/core/til-pack-manager.js';
import { getCoreTilIr } from '../js/analysis/types/core/til-lite-data.js';
import { compileTil1 } from '../js/analysis/types/core/til-binary-compiler.js';
import { sha256Hex } from '../js/analysis/types/core/til-storage.js';
import { AUTO_ANALYSIS_STATUS } from '../js/analysis/common/v6-auto-contracts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOADER_PATH = path.resolve(__dirname, '../js/analysis/types/core/til-auto-loader.js');
const REAL_MANIFEST_PATH = path.resolve(__dirname, '../dist/til-hub/manifest.json');

const REAL_MANIFEST = JSON.parse(fs.readFileSync(REAL_MANIFEST_PATH, 'utf8'));
const SAMPLE_TIL1_BYTES = compileTil1(getCoreTilIr());

function makeManifest(packs) {
  return {
    schema: 'til-hub-manifest/v1',
    formatVersion: 1,
    packs,
  };
}

function makeFakeResponse(bytes, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

describe('til-auto-loader (Track 1)', () => {
  it('complies with INV-005 (zero imports from js/targets/architecture/ or js/semantics/)', () => {
    const src = fs.readFileSync(LOADER_PATH, 'utf8');
    assert.equal(/(?:from\s+|import\s*\(\s*)['"][^'"]*targets\/architecture/.test(src), false, 'must not import from js/targets/architecture/');
    assert.equal(/(?:from\s+|import\s*\(\s*)['"][^'"]*semantics/.test(src), false, 'must not import from js/semantics/');
  });

  describe('normalizePlatformName', () => {
    it('normalizes OS/platform variants and disambiguates apple via dylibs', () => {
      assert.equal(normalizePlatformName('gnu/linux'), 'linux');
      assert.equal(normalizePlatformName('GNU/Linux'), 'linux');
      assert.equal(normalizePlatformName('linux-gnu'), 'linux');
      assert.equal(normalizePlatformName('iOS Simulator'), 'ios-simulator');
      assert.equal(normalizePlatformName('Mac Catalyst'), 'mac-catalyst');
      assert.equal(normalizePlatformName('darwin'), 'macos');
      assert.equal(normalizePlatformName('OSX'), 'macos');
      assert.equal(normalizePlatformName('win32'), 'windows');
      assert.equal(normalizePlatformName('win64'), 'windows');
      assert.equal(normalizePlatformName('apple', []), 'macos');
      assert.equal(normalizePlatformName('apple', ['/System/Library/Frameworks/AppKit.framework/AppKit']), 'macos');
      assert.equal(normalizePlatformName('apple', ['/System/Library/Frameworks/UIKit.framework/UIKit']), 'ios');
      assert.equal(normalizePlatformName('apple', ['CoreUI']), 'ios');
      assert.equal(normalizePlatformName('apple', ['MobileCoreServices']), 'ios');
      assert.equal(normalizePlatformName(null), '');
      assert.equal(normalizePlatformName('   '), '');
    });
  });

  describe('selectTilPacksForBinary', () => {
    it('returns [] for invalid manifests', () => {
      assert.deepEqual(selectTilPacksForBinary(null, { platform: 'linux' }), []);
      assert.deepEqual(selectTilPacksForBinary({}, { platform: 'linux' }), []);
      assert.deepEqual(selectTilPacksForBinary({ schema: 'wrong', packs: [] }, { platform: 'linux' }), []);
      assert.deepEqual(selectTilPacksForBinary({ schema: 'til-hub-manifest/v1', packs: [{ id: '' }] }, { platform: 'linux' }), []);
    });

    it('excludes isCore packs from selection candidates', () => {
      const manifest = makeManifest([
        {
          id: 'core-pack',
          isCore: true,
          priority: 100,
          matchRules: { platforms: ['linux'], dylibs: ['libc.so.6'] },
        },
        {
          id: 'user-pack',
          isCore: false,
          matchRules: { platforms: ['linux'] },
        },
      ]);
      const selected = selectTilPacksForBinary(manifest, { platform: 'linux', dylibs: ['libc.so.6'] });
      assert.deepEqual(selected.map((p) => p.id), ['user-pack']);
    });

    it('normalizes missing priority to 0 and sorts by (priority desc, score desc, id asc)', () => {
      const manifest = makeManifest([
        { id: 'pack-b', matchRules: { platforms: ['linux'] } },
        { id: 'pack-a', matchRules: { platforms: ['linux'] } },
        { id: 'pack-low-prio', priority: -1, matchRules: { platforms: ['linux'], dylibs: ['libc.so.6'] } },
        { id: 'pack-high-prio', priority: 5, matchRules: { platforms: ['linux'] } },
      ]);
      const selected = selectTilPacksForBinary(
        manifest,
        { platform: 'linux', dylibs: ['libc.so.6'] },
        { maxPacks: 2 },
      );
      assert.deepEqual(selected.map((p) => p.id), ['pack-high-prio', 'pack-a']);
    });

    it('hard-excludes packs whose platforms exclude the binary platform even if dylibs/hints match', () => {
      const manifest = makeManifest([
        {
          id: 'win-only',
          matchRules: { platforms: ['windows'], dylibs: ['shared.dll'], hints: ['common'] },
        },
        {
          id: 'linux-ok',
          matchRules: { platforms: ['linux'] },
        },
      ]);
      const selected = selectTilPacksForBinary(manifest, {
        platform: 'linux',
        dylibs: ['shared.dll'],
        hints: ['common'],
      });
      assert.deepEqual(selected.map((p) => p.id), ['linux-ok']);
    });

    it('merges and deduplicates dylibs + frameworks without double scoring', () => {
      const manifest = makeManifest([
        {
          id: 'pack-uikit',
          matchRules: {
            platforms: ['ios'],
            dylibs: ['UIKit'],
          },
        },
        {
          id: 'pack-two-libs',
          matchRules: {
            platforms: ['ios'],
            dylibs: ['Foundation', 'Security'],
          },
        },
      ]);
      // Even though UIKit appears in both dylibs (full path + name) and frameworks,
      // pack-uikit should only get +5 once (total 15), losing to pack-two-libs (10 + 5 + 5 = 20).
      const selected = selectTilPacksForBinary(
        manifest,
        {
          platform: 'ios',
          dylibs: [
            '/System/Library/Frameworks/UIKit.framework/UIKit',
            'UIKit',
            '/System/Library/Frameworks/Foundation.framework/Foundation',
          ],
          frameworks: ['UIKit', 'Security'],
        },
        { maxPacks: 1 },
      );
      assert.deepEqual(selected.map((p) => p.id), ['pack-two-libs']);
    });

    it('does not falsely select platforms:["any"] packs for unrelated binaries, only when dylibs/hints/libc match', () => {
      // Unrelated unknown platform binary with no dylibs/hints/libc -> must select nothing
      const unrelated = selectTilPacksForBinary(REAL_MANIFEST, {
        platform: 'freebsd',
        dylibs: ['libcustom.so'],
        hints: ['custom-app'],
      });
      assert.deepEqual(unrelated, []);

      // Matching libssl triggers openssl-core (+5 dylib +2 any = 7)
      const withSsl = selectTilPacksForBinary(REAL_MANIFEST, {
        platform: 'freebsd',
        dylibs: ['/usr/lib/libssl.so.3'],
      });
      assert.deepEqual(withSsl.map((p) => p.id), ['openssl-core']);
    });

    it('enforces bidirectional conflicts exclusion', () => {
      const manifest = makeManifest([
        {
          id: 'pack-a',
          priority: 10,
          matchRules: { platforms: ['linux'] },
          conflicts: [],
        },
        {
          id: 'pack-b',
          priority: 5,
          matchRules: { platforms: ['linux'] },
          conflicts: ['pack-a'], // only B declares conflict with A
        },
        {
          id: 'pack-c',
          priority: 1,
          matchRules: { platforms: ['linux'] },
          conflicts: [],
        },
      ]);
      const selected = selectTilPacksForBinary(manifest, { platform: 'linux' }, { maxPacks: 2 });
      assert.deepEqual(selected.map((p) => p.id), ['pack-a', 'pack-c']);
    });

    it('resolves transitive requires closure (A -> B -> C), isCore deps, cycles, maxPacks=1, missing IDs, and pre-selected dedup', () => {
      // 1. Transitive A -> B -> C (3 packs > cap 2 -> A skipped; B -> C fits cap 2 in dep-first order [C, B])
      const chainManifest = makeManifest([
        { id: 'pack-a', priority: 10, matchRules: { platforms: ['linux'] }, requires: ['pack-b'] },
        { id: 'pack-b', priority: 5, matchRules: { platforms: ['linux'] }, requires: ['pack-c'] },
        { id: 'pack-c', priority: 1, matchRules: { platforms: ['linux'] }, requires: [] },
      ]);
      assert.deepEqual(
        selectTilPacksForBinary(chainManifest, { platform: 'linux' }, { maxPacks: 2 }).map((p) => p.id),
        ['pack-c', 'pack-b'],
      );

      // 2. isCore dependency is already satisfied (does not consume a slot)
      const coreDepManifest = makeManifest([
        { id: 'core-base', isCore: true, matchRules: { platforms: ['any'] } },
        { id: 'app-pack', matchRules: { platforms: ['linux'] }, requires: ['core-base'] },
      ]);
      assert.deepEqual(
        selectTilPacksForBinary(coreDepManifest, { platform: 'linux' }, { maxPacks: 1 }).map((p) => p.id),
        ['app-pack'],
      );

      // 3. Cycle guard (A -> B -> A) does not hang and skips cyclic packs
      const cyclicManifest = makeManifest([
        { id: 'cyc-a', priority: 10, matchRules: { platforms: ['linux'] }, requires: ['cyc-b'] },
        { id: 'cyc-b', priority: 9, matchRules: { platforms: ['linux'] }, requires: ['cyc-a'] },
        { id: 'safe-pack', priority: 1, matchRules: { platforms: ['linux'] }, requires: [] },
      ]);
      assert.deepEqual(
        selectTilPacksForBinary(cyclicManifest, { platform: 'linux' }, { maxPacks: 2 }).map((p) => p.id),
        ['safe-pack'],
      );

      // 4. maxPacks === 1 with ios-sdk-core requiring apple-darwin-full
      const iosSingle = selectTilPacksForBinary(
        REAL_MANIFEST,
        {
          platform: 'ios',
          libc: 'libSystem',
          dylibs: ['UIKit', 'Foundation', 'CoreFoundation', 'Security', 'libSystem.B.dylib'],
          hints: ['uikit', 'objc'],
        },
        { maxPacks: 1 },
      );
      assert.deepEqual(iosSingle.map((p) => p.id), ['apple-darwin-full']);

      // 5. Missing dependency ID causes pack to be skipped
      const missingDepManifest = makeManifest([
        { id: 'broken-pack', priority: 10, matchRules: { platforms: ['linux'] }, requires: ['nonexistent'] },
        { id: 'fallback-pack', priority: 1, matchRules: { platforms: ['linux'] }, requires: [] },
      ]);
      assert.deepEqual(
        selectTilPacksForBinary(missingDepManifest, { platform: 'linux' }, { maxPacks: 2 }).map((p) => p.id),
        ['fallback-pack'],
      );

      // 6. Platform-excluded non-core dependency causes pack to be skipped
      const crossPlatDepManifest = makeManifest([
        { id: 'win-dep', matchRules: { platforms: ['windows'] } },
        { id: 'linux-need-win', priority: 10, matchRules: { platforms: ['linux'] }, requires: ['win-dep'] },
        { id: 'linux-clean', priority: 1, matchRules: { platforms: ['linux'] } },
      ]);
      assert.deepEqual(
        selectTilPacksForBinary(crossPlatDepManifest, { platform: 'linux' }, { maxPacks: 2 }).map((p) => p.id),
        ['linux-clean'],
      );

      // 7. Pre-selected dependency is not double-counted against cap
      const preSelectedManifest = makeManifest([
        { id: 'dep-base', priority: 20, matchRules: { platforms: ['ios'] }, requires: [] },
        { id: 'dep-child', priority: 10, matchRules: { platforms: ['ios'] }, requires: ['dep-base'] },
      ]);
      assert.deepEqual(
        selectTilPacksForBinary(preSelectedManifest, { platform: 'ios' }, { maxPacks: 2 }).map((p) => p.id),
        ['dep-base', 'dep-child'],
      );

      // 8. maxPacks cap normalization (capped at 2, floor >= 0)
      assert.deepEqual(selectTilPacksForBinary(preSelectedManifest, { platform: 'ios' }, { maxPacks: 0 }), []);
      assert.deepEqual(selectTilPacksForBinary(preSelectedManifest, { platform: 'ios' }, { maxPacks: -3 }), []);
      assert.equal(selectTilPacksForBinary(preSelectedManifest, { platform: 'ios' }, { maxPacks: 10 }).length, 2);
    });
  });

  describe('resolveSafePackUrl', () => {
    it('rejects absolute URLs, schemes, leading slashes, and traversal in relFile', () => {
      assert.equal(resolveSafePackUrl('til-hub', { gzFile: 'https://evil.example/a.til1.gz' }), null);
      assert.equal(resolveSafePackUrl('til-hub', { file: 'javascript:alert(1)' }), null);
      assert.equal(resolveSafePackUrl('til-hub', { gzFile: '/etc/passwd' }), null);
      assert.equal(resolveSafePackUrl('til-hub', { file: '../secret.til1' }), null);
      assert.equal(resolveSafePackUrl('til-hub', { file: 'a/%2e%2e/b.til1' }), null);
    });

    it('separates compressed vs raw SHA-256 expectations correctly', () => {
      const gzBoth = resolveSafePackUrl('til-hub', {
        file: 'a.til1',
        gzFile: 'a.til1.gz',
        sha256: 'raw-hash',
        gzSha256: 'gz-hash',
      });
      assert.deepEqual(gzBoth, {
        url: 'til-hub/a.til1.gz',
        expectedSha256: 'gz-hash',
        expectedRawSha256: 'raw-hash',
      });

      const gzNoGzHash = resolveSafePackUrl('til-hub', {
        file: 'a.til1',
        gzFile: 'a.til1.gz',
        sha256: 'raw-hash',
      });
      assert.deepEqual(gzNoGzHash, {
        url: 'til-hub/a.til1.gz',
        expectedSha256: null,
        expectedRawSha256: 'raw-hash',
      });

      const rawOnly = resolveSafePackUrl('til-hub/', {
        file: 'a.til1',
        sha256: 'raw-hash',
      });
      assert.deepEqual(rawOnly, {
        url: 'til-hub/a.til1',
        expectedSha256: 'raw-hash',
        expectedRawSha256: 'raw-hash',
      });
    });

    it('enforces community mirror SSRF protection and derives base from manifestUrl when baseUrl is empty', () => {
      const okMirror = resolveSafePackUrl(
        '',
        { gzFile: 'ios-sdk-core.til1.gz', sha256: 'raw1', gzSha256: 'gz1' },
        { isCommunityMirror: true, manifestUrl: 'https://mirror.example.com/til-hub/manifest.json' },
      );
      assert.deepEqual(okMirror, {
        url: 'https://mirror.example.com/til-hub/ios-sdk-core.til1.gz',
        expectedSha256: 'gz1',
        expectedRawSha256: 'raw1',
      });

      // Relative baseUrl must fail on community mirror
      assert.equal(
        resolveSafePackUrl('til-hub', { gzFile: 'a.til1.gz' }, { isCommunityMirror: true }),
        null,
      );

      // Private / localhost / non-https must fail on community mirror
      for (const badUrl of [
        'http://mirror.example.com/a.til1.gz',
        'https://127.0.0.1/a.til1.gz',
        'https://localhost/a.til1.gz',
        'https://10.0.0.1/a.til1.gz',
        'https://192.168.1.10/a.til1.gz',
        'https://172.16.0.5/a.til1.gz',
      ]) {
        assert.equal(
          resolveSafePackUrl('', { url: badUrl }, { isCommunityMirror: true }),
          null,
          `expected community mirror rejection for ${badUrl}`,
        );
      }
    });
  });

  describe('createTilAutoLoader', () => {
    it('supports injected fetchManifest with omitted manifestUrl', async () => {
      const rawHash = await sha256Hex(SAMPLE_TIL1_BYTES);
      const manifest = makeManifest([
        {
          id: 'linux-pack',
          file: 'linux-pack.til1',
          sha256: rawHash,
          matchRules: { platforms: ['linux'] },
        },
      ]);
      const mgr = new TilPackManager({
        fetcher: async () => makeFakeResponse(SAMPLE_TIL1_BYTES),
      });
      const loader = createTilAutoLoader({
        tilPackManager: mgr,
        fetchManifest: async () => manifest,
        manifestUrl: null,
        baseUrl: 'til-hub',
      });

      const res = await loader.run({ binaryMeta: { platform: 'linux' } });
      assert.equal(res.status, AUTO_ANALYSIS_STATUS.DONE);
      assert.deepEqual(res.loadedPacks, ['linux-pack']);
      assert.equal(res.errors.length, 0);
      assert.equal(mgr.getMountedSlots().A?.packId, 'linux-pack');
    });

    it('handles entry validation (aborted, skipped, unsafe manifestUrl, community mirror SSRF)', async () => {
      const mgr = new TilPackManager({ fetcher: async () => makeFakeResponse(SAMPLE_TIL1_BYTES) });

      // Pre-aborted
      const ac = new AbortController();
      ac.abort();
      const preAborted = await createTilAutoLoader({ tilPackManager: mgr, manifestUrl: 'til-hub/manifest.json' })
        .run({ binaryMeta: { platform: 'linux' }, signal: ac.signal });
      assert.equal(preAborted.status, AUTO_ANALYSIS_STATUS.ABORTED);

      // Missing manager or manifest source -> SKIPPED
      const noMgr = await createTilAutoLoader({ manifestUrl: 'til-hub/manifest.json' }).run();
      assert.equal(noMgr.status, AUTO_ANALYSIS_STATUS.SKIPPED);
      const noSrc = await createTilAutoLoader({ tilPackManager: mgr }).run();
      assert.equal(noSrc.status, AUTO_ANALYSIS_STATUS.SKIPPED);

      // Unsafe manifestUrl -> OFFLINE
      const unsafe = await createTilAutoLoader({
        tilPackManager: mgr,
        manifestUrl: 'javascript:alert(1)',
      }).run({ binaryMeta: { platform: 'linux' } });
      assert.equal(unsafe.status, AUTO_ANALYSIS_STATUS.OFFLINE);

      // Community mirror SSRF manifestUrl -> OFFLINE
      const ssrf = await createTilAutoLoader({
        tilPackManager: mgr,
        manifestUrl: 'https://127.0.0.1/manifest.json',
        isCommunityMirror: true,
      }).run({ binaryMeta: { platform: 'linux' } });
      assert.equal(ssrf.status, AUTO_ANALYSIS_STATUS.OFFLINE);
    });

    it('enforces 2-slot cap and releases evictedPackId TID bases across 9 consecutive pack switches', async () => {
      const rawHash = await sha256Hex(SAMPLE_TIL1_BYTES);
      const mgr = new TilPackManager({
        fetcher: async () => makeFakeResponse(SAMPLE_TIL1_BYTES),
      });

      // Switch across 9 distinct packs (> MAX_TOTAL_LOGICAL_SLOTS = 8)
      for (let i = 1; i <= 9; i++) {
        const packId = `pack-${i}`;
        const manifest = makeManifest([
          {
            id: packId,
            file: `${packId}.til1`,
            sha256: rawHash,
            matchRules: { platforms: ['linux'] },
          },
        ]);
        const loader = createTilAutoLoader({
          tilPackManager: mgr,
          fetchManifest: async () => manifest,
          baseUrl: 'til-hub',
        });
        const res = await loader.run({ binaryMeta: { platform: 'linux' } });
        assert.equal(res.status, AUTO_ANALYSIS_STATUS.DONE, `pack ${i} must mount without TID exhaustion`);
        assert.deepEqual(res.loadedPacks, [packId]);
      }

      const slots = mgr.getMountedSlots();
      const mountedIds = [slots.A?.packId, slots.B?.packId].filter(Boolean).sort();
      assert.deepEqual(mountedIds, ['pack-8', 'pack-9']);
    });

    it('preserves existing mounted slots when loadPackWithFallback fails', async () => {
      const rawHash = await sha256Hex(SAMPLE_TIL1_BYTES);
      let shouldFail = false;
      const mgr = new TilPackManager({
        fetcher: async () => {
          if (shouldFail) return makeFakeResponse(new Uint8Array(0), 503);
          return makeFakeResponse(SAMPLE_TIL1_BYTES);
        },
      });

      // Pre-mount an existing pack in slot A
      await mgr.mountPack('existing-pack', SAMPLE_TIL1_BYTES, { expectedRawSha256: rawHash });
      assert.equal(mgr.getMountedSlots().A?.packId, 'existing-pack');

      shouldFail = true;
      const loader = createTilAutoLoader({
        tilPackManager: mgr,
        fetchManifest: async () => makeManifest([
          { id: 'failing-pack', file: 'failing-pack.til1', sha256: rawHash, matchRules: { platforms: ['linux'] } },
        ]),
        baseUrl: 'til-hub',
      });
      const res = await loader.run({ binaryMeta: { platform: 'linux' } });
      assert.equal(res.status, AUTO_ANALYSIS_STATUS.OFFLINE);
      assert.equal(res.errors.length, 1);
      assert.equal(mgr.getMountedSlots().A?.packId, 'existing-pack');
    });

    it('releases evictedPackId on cache-fallback abort and rolls back mounted slots', async () => {
      const rawHash = await sha256Hex(SAMPLE_TIL1_BYTES);
      const ac = new AbortController();
      const releasedIds = [];

      const mgr = new TilPackManager({
        fetcher: async () => {
          // Remote fetch fails and triggers abort; TilPackManager falls back to cache!
          ac.abort();
          return makeFakeResponse(new Uint8Array(0), 500);
        },
      });

      // Pre-populate storage cache for pack-c and fill both slots A & B
      await mgr.storage.put('pack-c', SAMPLE_TIL1_BYTES, { packId: 'pack-c' });
      await mgr.mountPack('pack-a', SAMPLE_TIL1_BYTES, { expectedRawSha256: rawHash });
      await mgr.mountPack('pack-b', SAMPLE_TIL1_BYTES, { expectedRawSha256: rawHash });

      const origRelease = mgr.releasePackTidBase.bind(mgr);
      mgr.releasePackTidBase = (packId) => {
        releasedIds.push(packId);
        return origRelease(packId);
      };

      const loader = createTilAutoLoader({
        tilPackManager: mgr,
        fetchManifest: async () => makeManifest([
          { id: 'pack-c', file: 'pack-c.til1', sha256: rawHash, matchRules: { platforms: ['linux'] } },
        ]),
        baseUrl: 'til-hub',
      });

      const res = await loader.run({ binaryMeta: { platform: 'linux' }, signal: ac.signal });
      assert.equal(res.status, AUTO_ANALYSIS_STATUS.ABORTED);
      assert.ok(releasedIds.includes('pack-a'), 'evicted pack-a TID base must be released even on cache-fallback abort');
      // pack-c mounted during aborted call must be rolled back (unmounted & TID released)
      assert.ok(releasedIds.includes('pack-c'), 'rolled-back pack-c TID base must be released');
      assert.equal(mgr.getMountedSlots().A, null);
      assert.equal(mgr.getMountedSlots().B?.packId, 'pack-b');
    });

    it('rolls back all mounted slots on mid-run abort while protecting TOCTOU re-mounted same packId via lastAccess', async () => {
      const rawHash = await sha256Hex(SAMPLE_TIL1_BYTES);
      const ac = new AbortController();
      let fetchCount = 0;

      const mgr = new TilPackManager({
        fetcher: async () => {
          fetchCount++;
          if (fetchCount === 2) {
            // Simulate an external manual re-mount of pack-1 (updating its lastAccess) right before abort
            await mgr.mountPack('pack-1', SAMPLE_TIL1_BYTES, { expectedRawSha256: rawHash });
            ac.abort();
          }
          return makeFakeResponse(SAMPLE_TIL1_BYTES);
        },
      });

      const manifest = makeManifest([
        { id: 'pack-1', priority: 10, file: 'pack-1.til1', sha256: rawHash, matchRules: { platforms: ['linux'] } },
        { id: 'pack-2', priority: 5, file: 'pack-2.til1', sha256: rawHash, matchRules: { platforms: ['linux'] } },
      ]);

      const loader = createTilAutoLoader({
        tilPackManager: mgr,
        fetchManifest: async () => manifest,
        baseUrl: 'til-hub',
      });

      const res = await loader.run({ binaryMeta: { platform: 'linux' }, signal: ac.signal });
      assert.equal(res.status, AUTO_ANALYSIS_STATUS.ABORTED);
      // pack-1 was externally re-mounted (newer lastAccess) -> must NOT be unmounted!
      assert.equal(mgr.getMountedSlots().A?.packId, 'pack-1');
      // pack-2 mounted by this aborted run -> MUST be rolled back!
      assert.equal(mgr.getMountedSlots().B, null);
    });

    it('rolls back both slots on mid-run abort when no external TOCTOU occurred', async () => {
      const rawHash = await sha256Hex(SAMPLE_TIL1_BYTES);
      const ac = new AbortController();
      let fetchCount = 0;

      const mgr = new TilPackManager({
        fetcher: async () => {
          fetchCount++;
          if (fetchCount === 2) {
            ac.abort();
          }
          return makeFakeResponse(SAMPLE_TIL1_BYTES);
        },
      });

      const manifest = makeManifest([
        { id: 'pack-1', priority: 10, file: 'pack-1.til1', sha256: rawHash, matchRules: { platforms: ['linux'] } },
        { id: 'pack-2', priority: 5, file: 'pack-2.til1', sha256: rawHash, matchRules: { platforms: ['linux'] } },
      ]);

      const loader = createTilAutoLoader({
        tilPackManager: mgr,
        fetchManifest: async () => manifest,
        baseUrl: 'til-hub',
      });

      const res = await loader.run({ binaryMeta: { platform: 'linux' }, signal: ac.signal });
      assert.equal(res.status, AUTO_ANALYSIS_STATUS.ABORTED);
      assert.equal(mgr.getMountedSlots().A, null);
      assert.equal(mgr.getMountedSlots().B, null);
    });
  });
});
