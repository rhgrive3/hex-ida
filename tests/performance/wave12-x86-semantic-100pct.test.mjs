
function canonicalizeSsaTemps(code) {
  const loadMap = new Map();
  let nextLoad = 0;
  const localNumMap = new Map();
  let nextLocal = 0;
  const lines = String(code || '').split('\n');
  const bodyStart = lines.findIndex((l) => l.trim() === '{');
  for (let i = bodyStart + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (/^u?int(?:8|16|32|64)\s+load_\d+;$/.test(trimmed)) continue;
    lines[i].replace(/\bload_\d+\b/g, (m) => {
      if (!loadMap.has(m)) loadMap.set(m, `load_T${nextLoad++}`);
      return m;
    });
    lines[i].replace(/\blocal_\d+\b/g, (m) => {
      if (!localNumMap.has(m)) localNumMap.set(m, `local_T${nextLocal++}`);
      return m;
    });
  }
  const renamed = lines.map((line) => line
    .replace(/\bload_\d+\b/g, (m) => loadMap.get(m) ?? m)
    .replace(/\blocal_\d+\b/g, (m) => localNumMap.get(m) ?? m));
  const out = [];
  let i = 0;
  while (i < renamed.length) {
    if (/^\s*u?int(?:8|16|32|64)\s+load_T\d+;$/.test(renamed[i])) {
      const decls = [];
      while (i < renamed.length && /^\s*u?int(?:8|16|32|64)\s+load_T\d+;$/.test(renamed[i])) {
        decls.push(renamed[i]);
        i += 1;
      }
      decls.sort();
      out.push(...decls);
    } else {
      out.push(renamed[i]);
      i += 1;
    }
  }
  return out.join('\n');
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openBinary } from '../../js/binary/index.js';
import { analyzeSemanticFunction } from '../../js/analysis/semantic-function.js';
import {
  getWasmCallCount,
  getWasmCallCounts,
  resetAllTelemetry,
} from '../../js/core/wasm-telemetry.js';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const X86_64_CORPUS = [
  { id: 'x86_64-sysv-elf', file: 'tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf' },
  { id: 'x86_64-pe-exe', file: 'tests/phase5/corpus/fixtures/vertical-microsoft-x64.exe' },
  { id: 'x86_64-macho-o', file: 'tests/phase12/rebuild/fixtures/vertical-macho-x86_64.o' },
];

function withEngineEnv(mode, fn) {
  const prevGlobal = globalThis.HEX_ENGINE;
  const prevInternal = globalThis.__HEX_ENGINE_MODE__;
  const prevEnv = process.env.HEX_ENGINE;
  try {
    if (mode == null) {
      delete globalThis.HEX_ENGINE;
      delete globalThis.__HEX_ENGINE_MODE__;
      delete process.env.HEX_ENGINE;
    } else {
      globalThis.HEX_ENGINE = mode;
      delete globalThis.__HEX_ENGINE_MODE__;
      delete process.env.HEX_ENGINE;
    }
    return fn();
  } finally {
    if (prevGlobal === undefined) delete globalThis.HEX_ENGINE;
    else globalThis.HEX_ENGINE = prevGlobal;
    if (prevInternal === undefined) delete globalThis.__HEX_ENGINE_MODE__;
    else globalThis.__HEX_ENGINE_MODE__ = prevInternal;
    if (prevEnv === undefined) delete process.env.HEX_ENGINE;
    else process.env.HEX_ENGINE = prevEnv;
  }
}

function resolveExecutableSection(img) {
  const sections = img.sections || [];
  return sections.find((s) => s.perms?.execute && Number(s.fileSize ?? s.size ?? 0n) > 0)
    || sections.find((s) => /\.text|__text/i.test(s.name || '') && Number(s.fileSize ?? s.size ?? 0n) > 0)
    || null;
}

function extractFunctions(img, sec, decoded) {
  const baseAddr = BigInt(sec.address ?? sec.va ?? 0n);
  const secEnd = baseAddr + BigInt(Number(sec.fileSize ?? sec.size ?? 0n));
  const seeds = (img.functionSeeds || img.functions || [])
    .map((f) => ({
      name: f.name || `sub_${BigInt(f.address).toString(16)}`,
      address: BigInt(f.address),
    }))
    .filter((f) => f.address >= baseAddr && f.address < secEnd)
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

  const unique = [];
  for (const s of seeds) {
    if (!unique.length || unique[unique.length - 1].address !== s.address) unique.push(s);
  }
  if (!unique.length) {
    unique.push({ name: `sub_${baseAddr.toString(16)}`, address: baseAddr });
  }

  const out = [];
  for (let i = 0; i < unique.length; i += 1) {
    const startAddr = unique[i].address;
    const endAddr = i + 1 < unique.length ? unique[i + 1].address : secEnd;
    const slice = decoded.filter((ins) => ins.address >= startAddr && ins.address < endAddr);
    if (slice.length > 0) {
      out.push({
        name: unique[i].name,
        address: startAddr,
        insns: slice.map((ins, row) => ({ ...ins, row })),
      });
    }
  }
  return out;
}

function buildCorpusInputs(x86Session) {
  const cases = [];
  for (const spec of X86_64_CORPUS) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, spec.file)));
    const img = openBinary(bytes, { _engine: 'js' });
    assert.equal(img.arch, 'x86_64', `${spec.id}: expected x86_64 arch`);
    const sec = resolveExecutableSection(img);
    assert.ok(sec, `${spec.id}: missing executable section`);

    const baseAddr = BigInt(sec.address ?? sec.va ?? 0n);
    const fileOff = Number(sec.fileOffset ?? sec.offset ?? 0n);
    const fileLen = Number(sec.fileSize ?? sec.size ?? 0n);
    const rawBytes = img.bytes.subarray(fileOff, fileOff + fileLen);
    const decoded = x86Session.decode(rawBytes, baseAddr).map((ins, idx) => {
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

    const fns = extractFunctions(img, sec, decoded);
    assert.ok(fns.length >= 1, `${spec.id}: expected at least 1 decoded function`);
    for (const fn of fns) {
      const semInput = {
        binaryId: spec.id,
        sliceId: `slice-${img.arch}`,
        snapshotId: 'snap',
        architecture: 'x86_64',
        platform: img.format === 'pe' ? 'windows' : 'linux',
        abiId: img.format === 'pe' ? 'microsoft-x64' : 'sysv-amd64',
        decoderSemanticVersion: fn.insns[0]?.decoderSemanticVersion || 'capstone-x86_64-v1',
        instructions: fn.insns.map((ins, row) => ({
          ...ins,
          row,
          origin: {
            byteRanges: [{ binaryId: spec.id, start: BigInt(row * ins.size), length: ins.size }],
            virtualRanges: [{ sliceId: `slice-${img.arch}`, start: ins.address, length: ins.size }],
          },
        })),
        dataEndianness: img.endian || 'little',
        instructionEndianness: img.endian || 'little',
      };
      cases.push({ id: `${spec.id}::${fn.name}`, semInput });
    }
  }
  return cases;
}

test('Wave 12 x86_64 semantic-function 3/3 real binaries 0-diff parity and WASM call telemetry', async () => {
  const x86Session = await createCapstoneX86Session();
  try {
    const cases = buildCorpusInputs(x86Session);
    assert.ok(cases.length >= 3, `expected >= 3 x86_64 functions across 3 binaries, got ${cases.length}`);

    resetAllTelemetry();
    for (const item of cases) {
      const jsRes = withEngineEnv('js', () => analyzeSemanticFunction(item.semInput, { _engine: 'js' }));
      const beforeX86 = getWasmCallCount('x86_64_decompile');
      const autoRes = withEngineEnv('auto', () => analyzeSemanticFunction(item.semInput, { _engine: 'auto' }));
      const afterX86 = getWasmCallCount('x86_64_decompile');
      assert.equal(afterX86 - beforeX86, 1, `${item.id}: expected exactly 1 x86_64_decompile WASM call`);
      assert.ok(
        Array.isArray(autoRes?.pipeline?.cfg?.blocks?.[0]?.successors)
        && autoRes.pipeline.cfg.blocks[0].successors.every((e) => typeof e === 'object' && typeof e.to === 'string'),
        `${item.id}: CFG successors must be edge objects { to, kind }`,
      );

      assert.equal(
        typeof jsRes?.decompiler?.pseudocode,
        'string',
        `${item.id}: expected string jsRes.decompiler.pseudocode`,
      );
      assert.ok(
        jsRes.decompiler.pseudocode.length > 0,
        `${item.id}: expected non-empty jsRes.decompiler.pseudocode`,
      );
      assert.equal(
        canonicalizeSsaTemps(autoRes?.decompiler?.pseudocode),
        canonicalizeSsaTemps(jsRes.decompiler.pseudocode),
        `${item.id}: x86_64 semantic-function pseudocode 0-diff mismatch`,
      );
      assert.equal(
        autoRes?.pipeline?.cfg?.blocks?.length,
        jsRes?.pipeline?.cfg?.blocks?.length,
        `${item.id}: x86_64 semantic-function CFG block count mismatch`,
      );
    }

    const x86DecompileCalls = getWasmCallCount('x86_64_decompile');
    assert.ok(
      x86DecompileCalls >= 3,
      `expected getWasmCallCount('x86_64_decompile') >= 3, got ${x86DecompileCalls} (all=${JSON.stringify(getWasmCallCounts())})`,
    );
  } finally {
    x86Session.close();
  }
});

test('Wave 12 x86_64 semantic-function JS isolation gate: { _engine: "js" } records 0 WASM calls', async () => {
  const x86Session = await createCapstoneX86Session();
  try {
    const cases = buildCorpusInputs(x86Session);
    assert.ok(cases.length >= 3);

    resetAllTelemetry();
    for (const item of cases) {
      const jsRes = withEngineEnv(null, () => analyzeSemanticFunction(item.semInput, { _engine: 'js' }));
      assert.ok(
        typeof jsRes?.decompiler?.pseudocode === 'string' && jsRes.decompiler.pseudocode.length > 0,
        `${item.id}: JS-mode analyzeSemanticFunction failed`,
      );
    }

    const allCounts = getWasmCallCounts();
    const totalWasmCalls = Object.values(allCounts).reduce((a, b) => a + b, 0);
    assert.equal(
      totalWasmCalls,
      0,
      `expected 0 total WASM calls under { _engine: 'js' }, got ${JSON.stringify(allCounts)}`,
    );
  } finally {
    x86Session.close();
  }
});

test('Wave 12 x86_64 semantic-function fail-closed fallback on unsupported instruction & custom name', async () => {
  const x86Session = await createCapstoneX86Session();
  try {
    const cases = buildCorpusInputs(x86Session);
    resetAllTelemetry();

    // 1. Custom name must fail-closed to JS (0-diff protection)
    const namedInput = { ...cases[0].semInput, name: 'custom_fn_name' };
    const beforeNamed = getWasmCallCount('x86_64_decompile');
    const namedRes = withEngineEnv('auto', () => analyzeSemanticFunction(namedInput, { _engine: 'auto' }));
    assert.equal(getWasmCallCount('x86_64_decompile'), beforeNamed, 'custom name must fail-closed to JS');
    assert.ok(namedRes?.decompiler?.pseudocode?.includes('custom_fn_name'));

    // 2. Truncated / unsupported instruction sequence must fail-closed to JS
    const truncInput = {
      ...cases[0].semInput,
      instructions: cases[0].semInput.instructions.slice(0, 3),
    };
    const beforeTrunc = getWasmCallCount('x86_64_decompile');
    const truncRes = withEngineEnv('auto', () => analyzeSemanticFunction(truncInput, { _engine: 'auto' }));
    assert.equal(getWasmCallCount('x86_64_decompile'), beforeTrunc, 'truncated x86_64 function must fail-closed to JS');
    assert.equal(typeof truncRes?.decompiler?.pseudocode, 'string');
  } finally {
    x86Session.close();
  }
});
