import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBinary } from '../../js/binary/index.js';
import { buildSampleBinary } from '../../js/sample.js';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildCfg } from '../../js/cfg.js';
import { analyzeGraph } from '../../js/controlflow.js';
import { decompile } from '../../js/decompile.js';
import { analyzeSemanticFunction } from '../../js/analysis/semantic-function.js';
import {
  getFallbackCount,
  getFallbackCounts,
  getWasmCallCount,
  getWasmCallCounts,
  resetAllTelemetry,
} from '../../js/core/wasm-telemetry.js';
import { createCapstoneArm64Session } from '../machine-effects/helpers/arm64-capstone-session.mjs';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const REAL_CORPUS_SPECS = [
  { id: 'macho-sample-arm64', expectedArch: 'arm64', bytes: buildSampleBinary() },
  { id: 'arm64-semantic-holdout', expectedArch: 'arm64', file: 'tests/scpa/fixtures/arm64-real-byte-semantic-holdout.elf' },
  { id: 'arm64-fpsimd-holdout', expectedArch: 'arm64', file: 'tests/scpa/fixtures/arm64-real-byte-fpsimd-atomic-holdout.elf' },
  { id: 'arm64-threaded-int', expectedArch: 'arm64', file: 'tests/scpa/fixtures/threaded-integer.elf' },
  { id: 'arm64-threaded-mem', expectedArch: 'arm64', file: 'tests/scpa/fixtures/threaded-call-memory.elf' },
  { id: 'arm64-dispatch-table', expectedArch: 'arm64', file: 'tests/scpa/fixtures/dispatch-table.elf' },
  { id: 'arm64-gnu-b-key-cfi', expectedArch: 'arm64', file: 'tests/phase4/binary/fixtures/issue-4255-gnu-b-key-cfi.elf' },
  { id: 'arm64_32-objc', expectedArch: 'arm64_32', file: 'tests/phase12/integration/fixtures/issue-8280-arm64_32-objc.o' },
  { id: 'x86_64-sysv-elf', expectedArch: 'x86_64', file: 'tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf' },
  { id: 'x86_64-pe-exe', expectedArch: 'x86_64', file: 'tests/phase5/corpus/fixtures/vertical-microsoft-x64.exe' },
  { id: 'x86_64-macho-o', expectedArch: 'x86_64', file: 'tests/phase12/rebuild/fixtures/vertical-macho-x86_64.o' },
  { id: 'x86_64-stripped-elf', expectedArch: 'arm64', file: 'tests/fixtures/cxx-dwarf-holdout/holdout.stripped.elf' },
  { id: 'x86-pe-exe', expectedArch: 'x86', file: 'tests/phase12/rebuild/fixtures/vertical-microsoft-x86.exe' },
];

function buildCorruptCases() {
  const sampleElf = new Uint8Array(
    fs.readFileSync(path.join(ROOT, 'tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf')),
  );
  const sampleMacho = buildSampleBinary();
  const samplePe = new Uint8Array(
    fs.readFileSync(path.join(ROOT, 'tests/phase5/corpus/fixtures/vertical-microsoft-x64.exe')),
  );
  const mutantElf = sampleElf.slice();
  const dv = new DataView(mutantElf.buffer, mutantElf.byteOffset, mutantElf.byteLength);
  dv.setBigUint64(40, 0x00000000deadbeefn, true); // corrupt e_shoff

  return [
    { id: 'corrupt-empty', bytes: new Uint8Array(0) },
    { id: 'corrupt-bad-magic', bytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03]) },
    { id: 'corrupt-truncated-elf', bytes: sampleElf.subarray(0, 40) },
    { id: 'corrupt-truncated-macho', bytes: sampleMacho.subarray(0, 24) },
    { id: 'corrupt-truncated-pe', bytes: samplePe.subarray(0, 64) },
    { id: 'corrupt-mutant-elf-shoff', bytes: mutantElf },
  ];
}

function resolveExecutableSection(img) {
  const sections = img.sections || [];
  return sections.find((s) => s.perms?.execute && Number(s.fileSize ?? s.size ?? 0n) > 0)
    || sections.find((s) => /\.text|__text/i.test(s.name || '') && Number(s.fileSize ?? s.size ?? 0n) > 0)
    || null;
}

function decodeSectionWithCapstone(img, sec, sessions) {
  const baseAddr = BigInt(sec.address ?? sec.va ?? 0n);
  const fileOff = Number(sec.fileOffset ?? sec.offset ?? 0n);
  const fileLen = Number(sec.fileSize ?? sec.size ?? 0n);
  const rawBytes = img.bytes?.subarray(fileOff, fileOff + fileLen);
  if (!rawBytes || rawBytes.length === 0) return [];

  if (img.arch === 'arm64' || img.arch === 'arm64_32') {
    const dv = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
    return sessions.arm64.decode(rawBytes, baseAddr).map((ins, idx) => {
      const relOff = Number(ins.address - baseAddr);
      const word = relOff >= 0 && relOff + 4 <= rawBytes.length ? dv.getUint32(relOff, true) : 0;
      const insBytes = relOff >= 0 && relOff + ins.size <= rawBytes.length
        ? rawBytes.subarray(relOff, relOff + ins.size)
        : new Uint8Array(0);
      const mn = String(ins.mnemonic || '').toLowerCase();
      const opStr = String(ins.opStr || '');
      return {
        row: idx,
        address: BigInt(ins.address),
        size: Number(ins.size || 4),
        length: Number(ins.size || 4),
        mn,
        mnemonic: mn,
        ops: opStr,
        opStr,
        word,
        rawBytes: insBytes,
      };
    });
  }

  if (img.arch === 'x86_64') {
    return sessions.x86.decode(rawBytes, baseAddr).map((ins, idx) => {
      const addr = BigInt(ins.address);
      const size = Number(ins.length ?? ins.size ?? 1);
      const relOff = Number(addr - baseAddr);
      const insBytes = relOff >= 0 && relOff + size <= rawBytes.length
        ? rawBytes.subarray(relOff, relOff + size)
        : new Uint8Array(0);
      const mn = String(ins.mnemonic || '').toLowerCase();
      const opStr = String(ins.opStr || '');
      return {
        ...ins,
        row: idx,
        address: addr,
        size,
        length: size,
        mn,
        mnemonic: mn,
        ops: opStr,
        opStr,
        rawBytes: insBytes,
      };
    });
  }

  return [];
}

function extractFunctionsFromSection(img, sec, decoded) {
  if (!decoded.length) return [];
  const baseAddr = BigInt(sec.address ?? sec.va ?? 0n);
  const secEnd = baseAddr + BigInt(Number(sec.fileSize ?? sec.size ?? 0n));

  const seeds = (img.functionSeeds || img.functions || [])
    .map((f) => ({
      name: f.name || `sub_${BigInt(f.address).toString(16)}`,
      address: BigInt(f.address),
    }))
    .filter((f) => f.address >= baseAddr && f.address < secEnd)
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

  const uniqueSeeds = [];
  for (const s of seeds) {
    if (!uniqueSeeds.length || uniqueSeeds[uniqueSeeds.length - 1].address !== s.address) {
      uniqueSeeds.push(s);
    }
  }
  if (!uniqueSeeds.length) {
    uniqueSeeds.push({ name: `sub_${baseAddr.toString(16)}`, address: baseAddr });
  }

  const out = [];
  for (let i = 0; i < uniqueSeeds.length; i += 1) {
    const startAddr = uniqueSeeds[i].address;
    const endAddr = i + 1 < uniqueSeeds.length ? uniqueSeeds[i + 1].address : secEnd;
    const slice = decoded.filter((ins) => ins.address >= startAddr && ins.address < endAddr);
    if (slice.length > 0) {
      out.push({
        name: uniqueSeeds[i].name,
        address: startAddr,
        insns: slice.map((ins, row) => ({ ...ins, row })),
      });
    }
  }
  return out;
}

function normalizeSourceMap(sm) {
  if (!sm) return [];
  if (sm instanceof Map) {
    return [...sm.entries()]
      .map(([k, v]) => [String(k), Array.isArray(v) ? v.map(String) : String(v)])
      .sort((a, b) => a[0].localeCompare(b[0]));
  }
  if (Array.isArray(sm)) {
    return sm.map((entry) => (typeof entry === 'object' && entry !== null
      ? Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]))
      : entry));
  }
  if (typeof sm === 'object') {
    return Object.entries(sm)
      .map(([k, v]) => [String(k), Array.isArray(v) ? v.map(String) : String(v)])
      .sort((a, b) => a[0].localeCompare(b[0]));
  }
  return [];
}

function normalizeLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => (typeof line === 'string'
    ? line
    : {
        indent: Number(line.indent || 0),
        text: String(line.text ?? ''),
      }));
}

function withEngineEnv(mode, fn) {
  const prevEnv = process.env.HEX_ENGINE;
  const prevGlobal = globalThis.HEX_ENGINE;
  try {
    if (mode === undefined) {
      delete process.env.HEX_ENGINE;
    } else {
      process.env.HEX_ENGINE = mode;
    }
    delete globalThis.HEX_ENGINE;
    return fn();
  } finally {
    if (prevEnv === undefined) {
      delete process.env.HEX_ENGINE;
    } else {
      process.env.HEX_ENGINE = prevEnv;
    }
    if (prevGlobal === undefined) {
      delete globalThis.HEX_ENGINE;
    } else {
      globalThis.HEX_ENGINE = prevGlobal;
    }
  }
}

function countTotalFallbacks() {
  return Object.values(getFallbackCounts()).reduce((acc, n) => acc + n, 0);
}

test('E2E differential: 13 real multi-arch binaries JS vs WASM/auto 0-diff + mandatory telemetry', async () => {
  const sessions = {
    arm64: await createCapstoneArm64Session(),
    x86: await createCapstoneX86Session(),
  };

  try {
    let totalFunctions = 0;
    let arm64Functions = 0;
    let x86Functions = 0;

    resetAllTelemetry();

    for (const spec of REAL_CORPUS_SPECS) {
      const bytes = spec.bytes || new Uint8Array(fs.readFileSync(path.join(ROOT, spec.file)));
      const imgJs = withEngineEnv('js', () => openBinary(bytes, { strings: true, _engine: 'js' }));
      const imgAuto = withEngineEnv('auto', () => openBinary(bytes, { strings: true, _engine: 'auto' }));
      assert.equal(imgAuto.format, imgJs.format, `${spec.id}: format mismatch`);
      assert.equal(imgAuto.arch, imgJs.arch, `${spec.id}: arch mismatch`);
      assert.equal(imgAuto.sections.length, imgJs.sections.length, `${spec.id}: section count mismatch`);

      const sec = resolveExecutableSection(imgAuto);
      if (!sec) continue;
      const decoded = decodeSectionWithCapstone(imgAuto, sec, sessions);
      const fns = extractFunctionsFromSection(imgAuto, sec, decoded);

      const isArm64 = imgAuto.arch === 'arm64' || imgAuto.arch === 'arm64_32';
      const isX86_64 = imgAuto.arch === 'x86_64';

      for (const fn of fns) {
        totalFunctions += 1;
        const addrToRow = new Map(fn.insns.map((ins, idx) => [ins.address, idx]));
        const rowOfAddress = (a) => addrToRow.get(BigInt(a)) ?? null;

        if (isArm64) {
          arm64Functions += 1;
          const model = buildSemanticModel(fn.insns, {
            startRow: 0,
            endRow: fn.insns.length - 1,
            rowOfAddress,
            symbolFor: () => null,
            name: fn.name,
          });

          const builtCfg = buildCfg(model, { rowOfAddress });
          const succs = (builtCfg?.nodes || []).map((node) => (node.succ || []).map((e) => e.to));
          const entry = builtCfg?.entry ?? 0;
          const cfgJs = withEngineEnv('js', () => analyzeGraph(succs, entry, null, { _forceJs: true, _engine: 'js' }));
          const cfgAuto = withEngineEnv('auto', () => analyzeGraph(succs, entry, null, { _engine: 'auto' }));
          assert.deepEqual(cfgAuto.idom, cfgJs.idom, `${spec.id}:${fn.name}: CFG idom mismatch`);

          const resJs = withEngineEnv('js', () => decompile(model, {
            addr: fn.address,
            name: fn.name,
            rowOfAddress,
            beginner: false,
            _engine: 'js',
          }));
          const resAuto = withEngineEnv('auto', () => decompile(model, {
            addr: fn.address,
            name: fn.name,
            rowOfAddress,
            beginner: false,
            _engine: 'auto',
          }));

          assert.equal(
            resAuto.pseudocode,
            resJs.pseudocode,
            `${spec.id}:${fn.name}: pseudocode mismatch`,
          );
          assert.deepEqual(
            normalizeLines(resAuto.lines),
            normalizeLines(resJs.lines),
            `${spec.id}:${fn.name}: lines mismatch`,
          );

          const smJs = normalizeSourceMap(resJs.sourceMap);
          const smAuto = normalizeSourceMap(resAuto.sourceMap);
          assert.ok(smAuto.length > 0, `${spec.id}:${fn.name}: sourceMap must be non-empty`);
          assert.deepEqual(smAuto, smJs, `${spec.id}:${fn.name}: sourceMap mismatch`);
        } else if (isX86_64) {
          x86Functions += 1;
          const semInput = {
            binaryId: spec.id,
            sliceId: `slice-${imgAuto.arch}`,
            snapshotId: 'snap',
            architecture: 'x86_64',
            platform: imgAuto.format === 'pe' ? 'windows' : 'linux',
            abiId: imgAuto.format === 'pe' ? 'microsoft-x64' : 'sysv-amd64',
            decoderSemanticVersion: fn.insns[0]?.decoderSemanticVersion || 'capstone-x86_64-v1',
            instructions: fn.insns.map((ins, row) => ({
              ...ins,
              row,
              origin: {
                byteRanges: [{ binaryId: spec.id, start: BigInt(row * ins.size), length: ins.size }],
                virtualRanges: [{ sliceId: `slice-${imgAuto.arch}`, start: ins.address, length: ins.size }],
              },
            })),
            dataEndianness: imgAuto.endian || 'little',
            instructionEndianness: imgAuto.endian || 'little',
          };

          const semJs = withEngineEnv('js', () => analyzeSemanticFunction(semInput, { _engine: 'js' }));
          const semAuto = withEngineEnv('auto', () => analyzeSemanticFunction(semInput, { _engine: 'auto' }));
          assert.equal(
            semAuto?.pseudocode ?? semAuto?.text ?? '',
            semJs?.pseudocode ?? semJs?.text ?? '',
            `${spec.id}:${fn.name}: x86_64 semantic pseudocode mismatch`,
          );
        }
      }
    }

    assert.ok(totalFunctions > 0 && arm64Functions > 0 && x86Functions > 0);
    const wasmCalls = getWasmCallCounts();
    assert.ok(
      getWasmCallCount('decompile') >= 1,
      `expected getWasmCallCount('decompile') >= 1, got ${JSON.stringify(wasmCalls)}`,
    );
    assert.ok(
      getWasmCallCount('cfg') >= 1 || getWasmCallCount('arm64_decode') >= 1,
      `expected cfg/arm64_decode wasm telemetry >= 1, got ${JSON.stringify(wasmCalls)}`,
    );
    const fallbacks = getFallbackCounts();
    assert.ok(
      getFallbackCount('decompile') >= 1 || countTotalFallbacks() >= 1,
      `expected fallback telemetry >= 1 for x86_64/unsupported functions, got ${JSON.stringify(fallbacks)}`,
    );
  } finally {
    sessions.arm64.close();
    sessions.x86.close();
  }
});

test('E2E differential: 6 corrupt/truncated/mutant binaries fail-closed consistently', () => {
  const corruptCases = buildCorruptCases();
  assert.equal(corruptCases.length, 6);

  for (const tc of corruptCases) {
    let jsErr = null;
    let autoErr = null;
    let jsRes = null;
    let autoRes = null;
    try {
      jsRes = withEngineEnv('js', () => openBinary(tc.bytes, { strings: true, _engine: 'js' }));
    } catch (e) {
      jsErr = e;
    }
    try {
      autoRes = withEngineEnv('auto', () => openBinary(tc.bytes, { strings: true, _engine: 'auto' }));
    } catch (e) {
      autoErr = e;
    }
    assert.equal(Boolean(autoErr), Boolean(jsErr), `${tc.id}: error parity mismatch`);
    if (!jsErr && jsRes && autoRes) {
      assert.equal(autoRes.format, jsRes.format, `${tc.id}: format parity mismatch`);
    }
  }
});

test('E2E regression: ORR / FMOV / MNEG / SMULL / MOVN 0-diff parity and safe fallback', async () => {
  const arm64 = await createCapstoneArm64Session();
  try {
    const cases = [
      { name: 'reg_orr_imm', words: [0xb2401fe0, 0xd65f03c0], expectFallback: true },
      { name: 'reg_fmov_imm', words: [0x1e6e1000, 0xd65f03c0], expectFallback: true },
      { name: 'reg_mneg', words: [0x1b01fc00, 0xd65f03c0], expectFallback: true },
      { name: 'reg_smull', words: [0x9b217c00, 0xd65f03c0], expectFallback: true },
      { name: 'reg_movn_w', words: [0x12800000, 0xd65f03c0], expectFallback: false },
      { name: 'reg_movn_x', words: [0x92800000, 0xd65f03c0], expectFallback: false },
    ];

    for (const tc of cases) {
      const raw = new Uint8Array(tc.words.length * 4);
      const dv = new DataView(raw.buffer);
      tc.words.forEach((w, i) => dv.setUint32(i * 4, w >>> 0, true));

      const decoded = arm64.decode(raw, 0x1000n).map((ins, row) => ({
        row,
        address: BigInt(ins.address),
        size: 4,
        length: 4,
        mn: String(ins.mnemonic || '').toLowerCase(),
        mnemonic: String(ins.mnemonic || '').toLowerCase(),
        ops: String(ins.opStr || ''),
        opStr: String(ins.opStr || ''),
        word: tc.words[row] >>> 0,
      }));
      const addrToRow = new Map(decoded.map((ins, idx) => [ins.address, idx]));
      const rowOfAddress = (a) => addrToRow.get(BigInt(a)) ?? null;
      const model = buildSemanticModel(decoded, {
        startRow: 0,
        endRow: decoded.length - 1,
        rowOfAddress,
        symbolFor: () => null,
        name: tc.name,
      });

      const jsRes = withEngineEnv('js', () => decompile(model, {
        addr: 0x1000n,
        name: tc.name,
        rowOfAddress,
        beginner: false,
        _engine: 'js',
      }));

      resetAllTelemetry();
      const autoRes = withEngineEnv('auto', () => decompile(model, {
        addr: 0x1000n,
        name: tc.name,
        rowOfAddress,
        beginner: false,
        _engine: 'auto',
      }));

      assert.equal(autoRes.pseudocode, jsRes.pseudocode, `${tc.name}: pseudocode mismatch`);
      assert.deepEqual(normalizeLines(autoRes.lines), normalizeLines(jsRes.lines), `${tc.name}: lines mismatch`);
      if (tc.expectFallback) {
        assert.equal(getWasmCallCount('decompile'), 0, `${tc.name}: must not count decompile WASM call on fallback`);
        assert.ok(countTotalFallbacks() >= 1, `${tc.name}: must record fallback reason`);
      }
    }
  } finally {
    arm64.close();
  }
});

test('E2E regression: HEX_ENGINE=js executes with 0 WASM calls & WebAssembly.validate=false falls back cleanly', async () => {
  const arm64 = await createCapstoneArm64Session();
  try {
    const words = [0x0b010000, 0xd65f03c0]; // add w0, w0, w1; ret
    const raw = new Uint8Array(8);
    const dv = new DataView(raw.buffer);
    dv.setUint32(0, words[0], true);
    dv.setUint32(4, words[1], true);

    const decoded = arm64.decode(raw, 0x1000n).map((ins, row) => ({
      row,
      address: BigInt(ins.address),
      size: 4,
      length: 4,
      mn: String(ins.mnemonic || '').toLowerCase(),
      mnemonic: String(ins.mnemonic || '').toLowerCase(),
      ops: String(ins.opStr || ''),
      opStr: String(ins.opStr || ''),
      word: words[row] >>> 0,
    }));
    const addrToRow = new Map(decoded.map((ins, idx) => [ins.address, idx]));
    const rowOfAddress = (a) => addrToRow.get(BigInt(a)) ?? null;
    const model = buildSemanticModel(decoded, {
      startRow: 0,
      endRow: decoded.length - 1,
      rowOfAddress,
      symbolFor: () => null,
      name: '_add',
    });

    // 1. HEX_ENGINE=js -> 0 WASM calls
    resetAllTelemetry();
    const jsOut = withEngineEnv('js', () => decompile(model, {
      addr: 0x1000n,
      name: '_add',
      rowOfAddress,
      beginner: false,
    }));
    assert.ok(jsOut.pseudocode.includes('return'));
    assert.equal(getWasmCallCount('decompile'), 0, 'HEX_ENGINE=js must record 0 decompile WASM calls');
    assert.equal(getWasmCallCount('engine_runtime'), 0, 'HEX_ENGINE=js must record 0 engine_runtime WASM calls');

    // 2. WebAssembly.validate temporarily returning false -> graceful JS fallback (wasm_unavailable)
    const origValidate = WebAssembly.validate;
    try {
      WebAssembly.validate = () => false;
      resetAllTelemetry();
      const fbOut = withEngineEnv('auto', () => decompile(model, {
        addr: 0x1000n,
        name: '_add',
        rowOfAddress,
        beginner: false,
      }));
      assert.equal(fbOut.pseudocode, jsOut.pseudocode, 'wasm_unavailable fallback must match JS output');
    } finally {
      WebAssembly.validate = origValidate;
    }
  } finally {
    arm64.close();
  }
});
