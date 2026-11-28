import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openBinarySource, detectBinary } from '../js/binary/index.js';
import { describeBinaryImage } from '../js/platform/describe.js';
import { analysisFromBinaryImage } from '../js/platform/analysis-result.js';
import { resolveRealFixturePath, REAL_FIXTURE_TARGETS } from './universal-binary-gate.mjs';
import { structuralReadabilityMetrics } from '../tools/validation/public-benchmark/metrics.mjs';
import { compareCase, aggregateComparisons } from '../tools/validation/public-benchmark/compare.mjs';
import { formatReport } from '../tools/validation/public-benchmark/report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function encodeUleb128(n) {
  const out = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return out;
}

function encodeString(str) {
  const bytes = [...new TextEncoder().encode(str)];
  return [...encodeUleb128(bytes.length), ...bytes];
}

function encodeSection(id, payload) {
  return [id, ...encodeUleb128(payload.length), ...payload];
}

function buildSampleWasm() {
  // Type 0: (i32, i32) -> i32
  const typeSection = encodeSection(1, [
    1,
    0x60, 2, 0x7f, 0x7f, 1, 0x7f,
  ]);
  // Import 0: env.ext_mul : func type 0 (funcIndex 0)
  const importSection = encodeSection(2, [
    1,
    ...encodeString('env'),
    ...encodeString('ext_mul'),
    0x00, 0x00,
  ]);
  // Defined functions: funcIndex 1 (type 0), funcIndex 2 (type 0)
  const functionSection = encodeSection(3, [2, 0, 0]);
  // Export "add" -> funcIndex 1
  const exportSection = encodeSection(7, [
    1,
    ...encodeString('add'),
    0x00, 1,
  ]);
  // Code bodies:
  // body 0 (funcIndex 1): local.get 0; local.get 1; i32.add; end
  const body0 = [0, 0x20, 0, 0x20, 1, 0x6a, 0x0b];
  // body 1 (funcIndex 2): local.get 0; local.get 1; i32.sub; end
  const body1 = [0, 0x20, 0, 0x20, 1, 0x6b, 0x0b];
  const codeSection = encodeSection(10, [
    2,
    ...encodeUleb128(body0.length), ...body0,
    ...encodeUleb128(body1.length), ...body1,
  ]);

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    ...typeSection,
    ...importSection,
    ...functionSection,
    ...exportSection,
    ...codeSection,
  ]);
}

// ============================================================
// 1. Bug #4: Real-fixture gate Fail-Closed & Path Resolution
// ============================================================
{
  const tempEmpty = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-agent-a-empty-'));
  try {
    // Empty fixtures dir MUST fail closed (exit 1) without HEX_ALLOW_EMPTY_REAL_FIXTURES=1
    const failRes = spawnSync(process.execPath, [path.join(ROOT, 'tests/universal-binary-gate.mjs')], {
      cwd: ROOT,
      env: { ...process.env, HEX_REAL_FIXTURES_DIR: tempEmpty, HEX_ALLOW_EMPTY_REAL_FIXTURES: '' },
      encoding: 'utf8',
    });
    assert.equal(failRes.status, 1, `expected exit 1 on empty fixtures dir, got ${failRes.status}: ${failRes.stdout} ${failRes.stderr}`);
    assert.match(failRes.stderr, /ran=0/);

    // Explicit HEX_ALLOW_EMPTY_REAL_FIXTURES=1 MUST allow empty dir (exit 0)
    const allowRes = spawnSync(process.execPath, [path.join(ROOT, 'tests/universal-binary-gate.mjs')], {
      cwd: ROOT,
      env: { ...process.env, HEX_REAL_FIXTURES_DIR: tempEmpty, HEX_ALLOW_EMPTY_REAL_FIXTURES: '1' },
      encoding: 'utf8',
    });
    assert.equal(allowRes.status, 0, `expected exit 0 when HEX_ALLOW_EMPTY_REAL_FIXTURES=1, got ${allowRes.status}: ${allowRes.stderr}`);

    // tests/browser.mjs MUST also fail closed on empty fixtures dir
    const browserFail = spawnSync(process.execPath, [path.join(ROOT, 'tests/browser.mjs')], {
      cwd: ROOT,
      env: { ...process.env, HEX_REAL_FIXTURES_DIR: tempEmpty, HEX_ALLOW_EMPTY_REAL_FIXTURES: '' },
      encoding: 'utf8',
    });
    assert.equal(browserFail.status, 1, `expected browser.mjs exit 1 on empty fixtures dir, got ${browserFail.status}`);

    const browserAllow = spawnSync(process.execPath, [path.join(ROOT, 'tests/browser.mjs')], {
      cwd: ROOT,
      env: { ...process.env, HEX_REAL_FIXTURES_DIR: tempEmpty, HEX_ALLOW_EMPTY_REAL_FIXTURES: '1' },
      encoding: 'utf8',
    });
    assert.equal(browserAllow.status, 0, `expected browser.mjs exit 0 when HEX_ALLOW_EMPTY_REAL_FIXTURES=1, got ${browserAllow.status}`);

    // Placeholder files MUST NOT be treated as real fixtures
    fs.writeFileSync(path.join(tempEmpty, 'battlecats'), 'HEX_LARGE_FIXTURE_PLACEHOLDER battlecats\nRun: npm run fixtures:large\n');
    const resolvedPlaceholder = resolveRealFixturePath(REAL_FIXTURE_TARGETS[0], { fixturesDir: tempEmpty });
    assert.equal(resolvedPlaceholder, null, 'placeholder file must not resolve as real fixture');

    // Alias resolution: TsumTsum resolves bainary-test
    const aliasPath = path.join(tempEmpty, 'bainary-test');
    fs.writeFileSync(aliasPath, Buffer.alloc(512, 0xab));
    const resolvedAlias = resolveRealFixturePath(REAL_FIXTURE_TARGETS[1], { fixturesDir: tempEmpty });
    assert.equal(resolvedAlias, aliasPath, 'TsumTsum target must resolve bainary-test alias');
  } finally {
    fs.rmSync(tempEmpty, { recursive: true, force: true });
  }

  // CI workflow consistency
  const universalYml = fs.readFileSync(path.join(ROOT, '.github/workflows/universal-platform.yml'), 'utf8');
  assert.match(universalYml, /HEX_ALLOW_EMPTY_REAL_FIXTURES:\s*'1'/);
  assert.match(universalYml, /Verify universal binary gate on real fixtures[\s\S]*npm run binary:gate/);

  const uiYml = fs.readFileSync(path.join(ROOT, '.github/workflows/ui-regression.yml'), 'utf8');
  assert.match(uiYml, /HEX_ALLOW_EMPTY_REAL_FIXTURES\s*=\s*'1'/);
}

// ============================================================
// 2. Bug #9: Async openBinarySource for .wasm + BinaryImage adapter
// ============================================================
{
  const wasmBytes = buildSampleWasm();
  const image = await openBinarySource(wasmBytes);

  assert.equal(image.format, 'wasm');
  assert.equal(image.managedFrontend, 'wasm');
  assert.equal(image.arch, 'wasm32');
  assert.equal(image.bits, 32);
  assert.equal(image.endian, 'little');
  assert.equal(image.fileSize, BigInt(wasmBytes.byteLength));
  assert.equal(typeof image.summary, 'function');

  const summary = image.summary();
  assert.equal(summary.format, 'wasm');
  assert.equal(summary.functions, 2);
  assert.equal(summary.imports, 1);
  assert.equal(summary.exports, 1);
  assert.ok(image.sections.length >= 5);
  assert.deepEqual(image.libraries, ['env']);
  assert.equal(image.imports[0].library, 'env');
  assert.equal(image.imports[0].name, 'ext_mul');
  assert.equal(image.exports[0].name, 'add');
  assert.equal(image.functions.map((f) => f.name).includes('add'), true);
  assert.equal(image.functions.map((f) => f.name).includes('func_2'), true);

  // describeBinaryImage must wire managedFrontend into supportTruthForImage and show WebAssembly
  const desc = describeBinaryImage(image, { name: 'sample.wasm' });
  assert.equal(desc.format, 'WebAssembly');
  assert.equal(desc.formatId, 'wasm');
  assert.ok(desc.support.managed, 'support.managed must be populated for managed images');
  assert.equal(desc.support.managed.id, 'wasm');
  assert.equal(desc.support.managed.level, 'M5');
  assert.equal(desc.productDescriptor.formatMetadata.managedFrontend, 'wasm');

  // analysisFromBinaryImage must surface functions & exported symbols cleanly
  const analysis = analysisFromBinaryImage(image);
  assert.equal(analysis.funcCount, 2);
  assert.ok(analysis.names.includes('add'));

  // 0xCAFEBABE Mach-O FAT detection must remain intact
  const fatPrefix = new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02, 0, 0, 0, 0, 0, 0, 0, 0]);
  const fatDetected = detectBinary(fatPrefix, { probeLength: 16n, totalSize: 4096n });
  assert.equal(fatDetected.format, 'macho');
  assert.equal(fatDetected.fat, true);
}

// ============================================================
// 3. Honest Benchmark Metrics (metrics / compare / report)
// ============================================================
{
  const cleanCode = `int answer(void) {\n  return 42;\n}`;
  const cleanM = structuralReadabilityMetrics(cleanCode);
  assert.equal(cleanM.hasPseudoStack, false);
  assert.equal(cleanM.hasStateMachine, false);
  assert.equal(cleanM.registerLeakRate, 0);
  assert.equal(cleanM.castCount, 0);
  assert.equal(cleanM.castDensity, 0);

  const fallbackCode = [
    'uint64_t f(uint64_t x0, uint64_t x1) {',
    '  uint8_t __hex_stack_frame[4096] = {0};',
    '  uint32_t __hex_state = 0;',
    '  while (1) {',
    '    switch (__hex_state) {',
    '      case 0: x0 = (uint64_t)((int32_t)x1 + (int32_t)sp); return x0;',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const fbM = structuralReadabilityMetrics(fallbackCode);
  assert.equal(fbM.hasPseudoStack, true);
  assert.equal(fbM.hasStateMachine, true);

  // Larger __hex_stack_frame sizes (e.g. 65536) must also be detected as pseudo-stack
  const largePseudoStackCode = `void big_frame(void) {\n  uint8_t __hex_stack_frame[65536] = {0};\n}`;
  assert.equal(structuralReadabilityMetrics(largePseudoStackCode).hasPseudoStack, true);
  const stack4096Code = `void legacy_stack(void) {\n  uint8_t stack_frame[4096] = {0};\n}`;
  assert.equal(structuralReadabilityMetrics(stack4096Code).hasPseudoStack, true);
  const normalBufCode = `void ok_buf(void) {\n  uint8_t buf[65536] = {0};\n}`;
  assert.equal(structuralReadabilityMetrics(normalBufCode).hasPseudoStack, false);
  assert.ok(fbM.registerLeakRate > 0, `expected registerLeakRate > 0, got ${fbM.registerLeakRate}`);
  assert.ok(fbM.castCount >= 2, `expected castCount >= 2, got ${fbM.castCount}`);
  assert.ok(fbM.castDensity > 0, `expected castDensity > 0, got ${fbM.castDensity}`);

  const tempSuite = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-bench-agent-a-'));
  try {
    fs.mkdirSync(path.join(tempSuite, 'ref'), { recursive: true });
    fs.writeFileSync(
      path.join(tempSuite, 'ref', 'case.c'),
      '/* Function: add @ 0x10 */\nint add(int a, int b) { return a + b; }\n/* Function: ugly @ 0x20 */\nint ugly(int a) { return a; }\n',
    );
    const cmp = compareCase({
      caseEntry: { id: 'case-1', reference: { path: 'ref/case.c' } },
      hexResult: {
        functions: [
          { address: '16', name: 'add', state: 'PASS', completeness: 'complete', pseudocode: cleanCode },
          { address: '32', name: 'ugly', state: 'PARTIAL', completeness: 'partial', pseudocode: fallbackCode },
        ],
      },
      suiteRoot: tempSuite,
    });

    // Backward-compatible fields
    assert.equal(cmp.denominator, 2);
    assert.equal(cmp.matchedByAddress, 2);
    assert.equal(cmp.hexPseudocode, 2);
    assert.equal(cmp.hexCoverage, 1);

    // New honest fields
    assert.deepEqual(cmp.completeness, { completeStructuredCount: 1, partialOrFallbackCount: 1 });
    assert.equal(cmp.pseudoStackCount, 1);
    assert.equal(cmp.stateMachineCount, 1);
    assert.ok(cmp.registerLeakRate > 0);
    assert.ok(cmp.castDensity > 0);

    const agg = aggregateComparisons([cmp]);
    assert.equal(agg.hexCoverage, 1);
    assert.deepEqual(agg.completeness, { completeStructuredCount: 1, partialOrFallbackCount: 1 });
    assert.equal(agg.pseudoStackCount, 1);
    assert.equal(agg.stateMachineCount, 1);
    assert.ok(agg.registerLeakRate > 0);
    assert.ok(agg.castDensity > 0);

    const md = formatReport({
      suite: 'test-suite',
      total: 1,
      states: { PASS: 1 },
      functionStates: { PASS: 1, PARTIAL: 1 },
      comparison: { scope: 'unit', aggregate: agg },
    });
    assert.match(md, /Complete structured pseudocode: 1/);
    assert.match(md, /Partial or fallback pseudocode: 1/);
    assert.match(md, /Pseudo-stack \(4096B\) fallbacks: 1/);
    assert.match(md, /State-machine fallbacks: 1/);
    assert.match(md, /Register leak rate: /);
    assert.match(md, /Cast density: /);
  } finally {
    fs.rmSync(tempSuite, { recursive: true, force: true });
  }
}

console.log('claude-review-agent-a tests: ALL PASS');
