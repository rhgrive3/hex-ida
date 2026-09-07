import assert from 'node:assert/strict';
import { ProductRouter, createChildTaskScope } from '../js/ui/router.js';
import { PluginHost } from '../js/plugins.js';
import { ByteView } from '../js/binary/reader.js';
import { parseTlsDirectory } from '../js/binary/pe-loader.js';

// Setup browser globals for Node test environment
const previousWindow = globalThis.window;
const previousHistory = globalThis.history;
const previousLocalStorage = globalThis.localStorage;

try {
  let locationHash = '#/home';
  globalThis.window = {
    location: {
      get href() { return `https://hex.test/${locationHash}`; },
      get hash() { return locationHash; },
      set hash(v) { locationHash = String(v); },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.history = {
    state: { hexUi: true, key: 1, depth: 0, viewState: null },
    pushState(state, _title, url) { this.state = state; if (url?.includes('#')) locationHash = '#' + url.split('#')[1]; },
    replaceState(state, _title, url) { this.state = state; if (url?.includes('#')) locationHash = '#' + url.split('#')[1]; },
    back() {}, forward() {},
  };

  // ── #2623: ProductRouter route-level AbortSignal lifecycle ──
  {
    const routes = [
      { id: 'home', pattern: '/home' },
      { id: 'about', pattern: '/about' },
      { id: 'broken', pattern: '/broken' },
    ];

    let currentSignal = null;
    const signalHistory = [];

    const router = new ProductRouter(routes, {
      defaultPath: '/home',
      onRoute: (route, meta) => {
        if (route.route.id === 'broken') {
          throw new Error('boom');
        }
        currentSignal = meta.signal;
        signalHistory.push({ id: route.route.id, signal: meta.signal });
        return {
          root: {},
          getState: () => ({ ok: true }),
          dispose: () => {},
        };
      },
    });

    // Start router
    router.start();
    assert.ok(currentSignal, 'route signal must be provided to onRoute');
    assert.equal(currentSignal.aborted, false, 'active route signal must not be aborted');
    const homeSignal = currentSignal;

    // Navigate to about
    const navigated = router.navigate('/about');
    assert.equal(navigated, true);
    assert.equal(homeSignal.aborted, true, 'previous route signal must be aborted on navigation');
    assert.equal(homeSignal.reason, 'route-changed');
    assert.equal(currentSignal.aborted, false, 'new route signal must be active');
    const aboutSignal = currentSignal;

    // Navigate to broken route -> should fail render and keep aboutSignal active
    const brokenNav = router.navigate('/broken');
    assert.equal(brokenNav, false);
    assert.equal(aboutSignal.aborted, false, 'current route signal must remain active when destination fails');

    // Child task scope
    const childScope = createChildTaskScope(aboutSignal);
    const task1 = childScope.spawn('first-task');
    assert.equal(task1.aborted, false);
    const task2 = childScope.spawn('second-task');
    assert.equal(task1.aborted, true, 'previous child task must be aborted when next spawns');
    assert.equal(task2.aborted, false);

    // Stopping router
    router.stop();
    assert.equal(aboutSignal.aborted, true, 'stopping router must abort active route signal');
    assert.equal(aboutSignal.reason, 'router-stopped');
    assert.equal(task2.aborted, true, 'child task must be aborted when parent route signal aborts');
  }

  // ── #2621: PluginHost v3 manifest fast startup ──
  {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };

    const fakeApp = { store: new Map() };
    const host = new PluginHost(fakeApp);
    await host.ready;

    // Pre-seed v3 manifest into localStorage
    const v3Data = [
      {
        v: 3,
        installationId: 'test-uuid-1',
        source: 'hex.plugin({ name: "FastPlugin", description: "demo" });',
        origin: 'test',
        definitions: [
          { index: 0, name: 'FastPlugin', description: 'demo' },
        ],
        enabledIndexes: [0],
      },
    ];
    localStorage.setItem('hex.plugins', JSON.stringify(v3Data));

    // Instantiate new PluginHost - must load without running sandbox discovery
    const host2 = new PluginHost(fakeApp);
    await host2.ready;
    assert.equal(host2.plugins.length, 1);
    assert.equal(host2.plugins[0].name, 'FastPlugin');
    assert.equal(host2.plugins[0].installationId, 'test-uuid-1');

    // Verify save produces v3 format
    host2.save();
    const savedRaw = localStorage.getItem('hex.plugins');
    const saved = JSON.parse(savedRaw);
    assert.equal(saved[0].v, 3);
    assert.equal(saved[0].definitions[0].name, 'FastPlugin');
  }

  // ── #2630: PE TLS callback target in executable zero-fill tail rejected ──
  {
    const textSec = {
      index: 1,
      address: 0x140001000n,
      size: 0x200n,
      fileOffset: 0x200n,
      fileSize: 0x100n,
      perms: { read: true, execute: true },
    };

    const rdataSec = {
      index: 2,
      address: 0x140002000n,
      size: 0x200n,
      fileOffset: 0x300n,
      fileSize: 0x200n,
      perms: { read: true, execute: false },
    };

    const bytes = new Uint8Array(0x1000);
    const dv = new DataView(bytes.buffer);
    dv.setBigUint64(0x300 + 24, 0x140002050n, true); // callbacks address at RVA 0x2050 (offset 0x350)
    dv.setBigUint64(0x350 + 0, 0x140001080n, true);  // file-backed inside .text -> valid
    dv.setBigUint64(0x350 + 8, 0x140001180n, true);  // zero-fill tail inside .text -> rejected
    dv.setBigUint64(0x350 + 16, 0n, true);           // terminator

    const image = {
      imageBase: 0x140000000n, bits: 64, sections: [textSec, rdataSec], segments: [textSec, rdataSec],
      metadata: {}, warnings: [], symbols: [], functions: [], imports: [], exports: [], relocations: [], libraries: [],
      sectionAt(address) {
        const a = BigInt(address);
        return [textSec, rdataSec].find((s) => a >= s.address && a < s.address + s.size) || null;
      },
    };

    parseTlsDirectory(new ByteView(bytes), { rva: 0x2000, size: 40 }, image);
    assert.equal(image.metadata.tls.callbacks.length, 1);
    assert.equal(image.metadata.tls.callbacks[0], 0x140001080n);
    assert.equal(image.functions.length, 1);
    assert.equal(image.functions[0].address, 0x140001080n);
  }

  console.log('Issue #2623, #2621, #2630 regression tests PASS!');
} finally {
  if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  if (previousHistory === undefined) delete globalThis.history; else globalThis.history = previousHistory;
  if (previousLocalStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousLocalStorage;
}
