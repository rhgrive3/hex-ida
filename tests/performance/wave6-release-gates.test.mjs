import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as telemetry from '../../js/core/wasm-telemetry.js';
import * as engineWasm from '../../js/core/hex-engine-wasm.js';
import * as engineBridge from '../../js/core/hex-engine-bridge.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function collectJsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(full, out);
    } else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test('Wave 6 release gate: required docs, manifest, and core WASM/bridge public API contracts exist', () => {
  const requiredFiles = [
    'ABI.md',
    'ROLLBACK.md',
    'MANIFEST.json',
    'js/core/wasm-telemetry.js',
    'js/core/hex-engine-wasm.js',
    'js/core/hex-engine-bridge.js',
  ];
  for (const rel of requiredFiles) {
    const full = path.join(ROOT, rel);
    assert.ok(fs.existsSync(full), `required release file missing: ${rel}`);
    assert.ok(fs.statSync(full).size > 0, `required release file is empty: ${rel}`);
  }

  const abiText = fs.readFileSync(path.join(ROOT, 'ABI.md'), 'utf8');
  assert.ok(abiText.includes('HEX_ABI_VERSION') || abiText.includes('0x00010000'), 'ABI.md must specify ABI version');

  const rollbackText = fs.readFileSync(path.join(ROOT, 'ROLLBACK.md'), 'utf8');
  assert.ok(rollbackText.includes('HEX_ENGINE=js'), 'ROLLBACK.md must document HEX_ENGINE=js');
  assert.ok(rollbackText.includes("globalThis.HEX_ENGINE = 'js'"), 'ROLLBACK.md must document globalThis.HEX_ENGINE');

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'MANIFEST.json'), 'utf8'));
  assert.ok(manifest && typeof manifest.schemaVersion === 'number', 'MANIFEST.json must be valid JSON with schemaVersion');

  // Public API contracts
  for (const fn of [
    'recordWasmCall',
    'getWasmCallCount',
    'getWasmCallCounts',
    'recordFallback',
    'getFallbackCount',
    'getFallbackCounts',
    'resetAllTelemetry',
  ]) {
    assert.equal(typeof telemetry[fn], 'function', `wasm-telemetry.js missing export: ${fn}`);
  }

  assert.equal(
    typeof engineWasm.isWasmBulkMemorySupported,
    'function',
    'hex-engine-wasm.js must export isWasmBulkMemorySupported',
  );
  assert.ok(
    typeof engineWasm.getHexEngineExports === 'function' || typeof engineWasm.createWasmInstance === 'function' || typeof engineWasm.getEngineInstance === 'function',
    'hex-engine-wasm.js must export instance factory',
  );
  assert.equal(
    typeof engineBridge.wasmDecodeX86_64Batch,
    'function',
    'hex-engine-bridge.js must export wasmDecodeX86_64Batch',
  );
});

test('Wave 6 release gate: host UI/AI/auth/userscript layers do not directly depend on internal WASM engine modules', () => {
  const hostDirs = ['js/ui', 'js/ai', 'js/auth', 'js/userscript'];
  const forbiddenImportRe = /(?:from\s+['"]|import\s*\(\s*['"])[^'"]*(?:cpp\/|wasm\/|hex-engine-wasm\.js|hex-engine-unified-wasm\.js)/;

  const violations = [];
  for (const relDir of hostDirs) {
    const files = collectJsFiles(path.join(ROOT, relDir));
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      if (forbiddenImportRe.test(content)) {
        violations.push(path.relative(ROOT, file));
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `host layer files must not directly import internal engine modules: ${violations.join(', ')}`,
  );
});

test('Wave 6 release gate: HEX_ENGINE=js rollback mode and isWasmBulkMemorySupported() behavior', () => {
  const bulkSupported = engineWasm.isWasmBulkMemorySupported();
  assert.equal(typeof bulkSupported, 'boolean', 'isWasmBulkMemorySupported() must return boolean');
  assert.equal(bulkSupported, true, 'Node.js runtime must support WASM bulk memory');

  const prevEnv = process.env.HEX_ENGINE;
  const prevGlobal = globalThis.HEX_ENGINE;
  try {
    process.env.HEX_ENGINE = 'js';
    delete globalThis.HEX_ENGINE;
    assert.equal(typeof engineBridge.getEngineMode, 'function', 'hex-engine-bridge.js must export getEngineMode');
  {
      assert.equal(engineBridge.getEngineMode({}), 'js', 'HEX_ENGINE=js must resolve to js');
      assert.equal(engineBridge.getEngineMode({ _engine: 'wasm' }), 'wasm', 'opts._engine must override env');
      globalThis.HEX_ENGINE = 'auto';
      assert.equal(engineBridge.getEngineMode({}), 'auto', 'globalThis.HEX_ENGINE must override env');
    }
  } finally {
    if (prevEnv === undefined) delete process.env.HEX_ENGINE;
    else process.env.HEX_ENGINE = prevEnv;
    if (prevGlobal === undefined) delete globalThis.HEX_ENGINE;
    else globalThis.HEX_ENGINE = prevGlobal;
  }
});
