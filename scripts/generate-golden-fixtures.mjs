#!/usr/bin/env node
/**
 * Golden fixture generator for Wave 0/1/2 boundaries:
 *   - fixtures/golden/binary-outputs.json       (19 cases: 13 real + 6 corrupt/truncated/mutant)
 *   - fixtures/golden/arm64-decode-outputs.json (structured Words.decodeWord fields)
 *   - fixtures/golden/cfg-outputs.json          (all functions via nodes[i].succ: idom/ipdom/reachable/backEdges)
 *   - fixtures/golden/identity-outputs.json     (fnv64ByteView, stableDigestHex, stableStringify)
 */
import fs from 'node:fs';
import path from 'node:path';

import '../js/words.js';
import { openBinary } from '../js/binary/index.js';
import { buildSampleBinary } from '../js/sample.js';
import { buildSemanticModel } from '../js/blocks.js';
import { analyzeGraph } from '../js/controlflow.js';
import { buildCfg } from '../js/cfg.js';
import { stableDigest, stableStringify } from '../js/core/identity/index.js';
import { fnv64ByteView } from '../js/core/identity/fnv64.js';

const { decodeWord } = globalThis.Words;
const OUT_DIR = 'fixtures/golden';
fs.mkdirSync(OUT_DIR, { recursive: true });

// 13 real multi-architecture binaries
const realCorpus = [
  { id: 'macho-sample-arm64', arch: 'arm64', format: 'macho', bytes: buildSampleBinary() },
  { id: 'arm64-semantic-holdout', arch: 'arm64', format: 'elf', file: 'tests/scpa/fixtures/arm64-real-byte-semantic-holdout.elf' },
  { id: 'arm64-fpsimd-holdout', arch: 'arm64', format: 'elf', file: 'tests/scpa/fixtures/arm64-real-byte-fpsimd-atomic-holdout.elf' },
  { id: 'arm64-threaded-int', arch: 'arm64', format: 'elf', file: 'tests/scpa/fixtures/threaded-integer.elf' },
  { id: 'arm64-threaded-mem', arch: 'arm64', format: 'elf', file: 'tests/scpa/fixtures/threaded-call-memory.elf' },
  { id: 'arm64-dispatch-table', arch: 'arm64', format: 'elf', file: 'tests/scpa/fixtures/dispatch-table.elf' },
  { id: 'arm64-gnu-b-key-cfi', arch: 'arm64', format: 'elf', file: 'tests/phase4/binary/fixtures/issue-4255-gnu-b-key-cfi.elf' },
  { id: 'arm64_32-objc', arch: 'arm64_32', format: 'macho', file: 'tests/phase12/integration/fixtures/issue-8280-arm64_32-objc.o' },
  { id: 'x86_64-sysv-elf', arch: 'x86_64', format: 'elf', file: 'tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf' },
  { id: 'x86_64-pe-exe', arch: 'x86_64', format: 'pe', file: 'tests/phase5/corpus/fixtures/vertical-microsoft-x64.exe' },
  { id: 'x86_64-macho-o', arch: 'x86_64', format: 'macho', file: 'tests/phase12/rebuild/fixtures/vertical-macho-x86_64.o' },
  { id: 'x86_64-stripped-elf', arch: 'x86_64', format: 'elf', file: 'tests/fixtures/cxx-dwarf-holdout/holdout.stripped.elf' },
  { id: 'x86-pe-exe', arch: 'x86', format: 'pe', file: 'tests/phase12/rebuild/fixtures/vertical-microsoft-x86.exe' },
];

for (const item of realCorpus) {
  if (item.file) item.bytes = new Uint8Array(fs.readFileSync(item.file));
}

// 6 corrupt / truncated / mutant cases
const sampleElf = realCorpus.find((x) => x.id === 'arm64-semantic-holdout').bytes;
const sampleMacho = realCorpus.find((x) => x.id === 'macho-sample-arm64').bytes;
const samplePe = realCorpus.find((x) => x.id === 'x86_64-pe-exe').bytes;
const mutantElf = sampleElf.slice();
for (let i = 40; i < 48; i += 1) mutantElf[i] = 0xff;

const corruptCorpus = [
  { id: 'corrupt-empty', bytes: new Uint8Array(0) },
  { id: 'corrupt-bad-magic', bytes: new Uint8Array(64).fill(0x5a) },
  { id: 'corrupt-truncated-elf', bytes: sampleElf.subarray(0, 32) },
  { id: 'corrupt-truncated-macho', bytes: sampleMacho.subarray(0, 24) },
  { id: 'corrupt-truncated-pe', bytes: samplePe.subarray(0, 96) },
  { id: 'corrupt-mutant-elf-shoff', bytes: mutantElf },
];

// 1. binary-outputs.json (19 cases)
const binaryGolden = [];
for (const fx of [...realCorpus, ...corruptCorpus]) {
  try {
    const img = openBinary(fx.bytes, { strings: true });
    binaryGolden.push({
      id: fx.id,
      ok: true,
      size: fx.bytes.length,
      format: img.format,
      arch: img.arch,
      bits: img.bits,
      endian: img.endian,
      imageBase: String(img.imageBase ?? 0n),
      entrypoint: img.entrypoint != null ? String(img.entrypoint) : null,
      sectionCount: (img.sections || []).length,
      sections: (img.sections || []).map((s) => ({
        name: s.name,
        address: String(s.address ?? 0n),
        size: String(s.size ?? 0n),
        fileOffset: String(s.fileOffset ?? 0n),
        fileSize: String(s.fileSize ?? 0n),
        exec: !!s.perms?.execute,
      })),
      functionCount: (img.functions || []).length,
      functions: (img.functions || []).slice(0, 32).map((f) => ({
        name: f.name,
        address: String(f.address ?? 0n),
        size: String(f.size ?? 0n),
      })),
      stringCount: (img.strings || []).length,
    });
  } catch (err) {
    binaryGolden.push({
      id: fx.id,
      ok: false,
      size: fx.bytes.length,
      errorName: err?.name || 'Error',
      errorMessage: String(err?.message || err),
    });
  }
}

// 2. arm64-decode-outputs.json, cfg-outputs.json, identity-outputs.json
const decodeGolden = [];
const cfgGolden = [];
const identityGolden = [];

for (const fx of realCorpus.filter((x) => x.arch === 'arm64')) {
  const img = openBinary(fx.bytes, { strings: true });
  const sec = (img.sections || []).find((s) => s.perms?.execute || /\.text|__text/i.test(s.name || ''));
  if (!sec) continue;
  const baseAddr = BigInt(sec.address ?? 0n);
  const fileOff = Number(sec.fileOffset ?? 0n);
  const fileLen = Number(sec.fileSize ?? sec.size ?? 0n);
  const rawBytes = img.bytes?.subarray(fileOff, fileOff + fileLen);
  if (!rawBytes || rawBytes.length < 4) continue;

  const dv = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  const insns = [];
  for (let off = 0; off + 4 <= rawBytes.length; off += 4) {
    const word = dv.getUint32(off, true);
    const addr = baseAddr + BigInt(off);
    const d = decodeWord(word, addr);
    insns.push({ row: insns.length, address: addr, mn: d?.kindName?.toLowerCase() || 'other', ops: '', word });
    decodeGolden.push({
      binary: fx.id,
      word,
      addr: addr.toString(16),
      kind: d.kind,
      kindName: d.kindName,
      rd: d.rd,
      rn: d.rn,
      rm: d.rm,
      target: d.target != null ? d.target.toString(16) : null,
      pcRel: d.pcRel ? d.pcRel.value.toString(16) : null,
      pcRelReg: d.pcRel ? d.pcRel.reg : -1,
      pcRelPage: d.pcRel ? Boolean(d.pcRel.page) : false,
      compareWith: d.compareWith != null ? String(d.compareWith) : null,
      memLoad: Boolean(d.memory?.load),
      memStore: Boolean(d.memory?.store),
      memSize: d.memory?.size ?? 0,
      memBase: d.memory?.base ?? -1,
      memDisp: d.memory?.disp != null ? String(d.memory.disp) : null,
    });
  }

  const fnvRes = fnv64ByteView(rawBytes);
  identityGolden.push({
    binary: fx.id,
    kind: 'fnv64ByteView',
    inputLen: rawBytes.length,
    low: fnvRes.low >>> 0,
    high: fnvRes.high >>> 0,
    stableDigestHex: stableDigest({ binary: fx.id, len: rawBytes.length, base: baseAddr.toString(16), insnCount: insns.length }),
    stableStringify: stableStringify({ b: 2, a: [1, -0, null, true, 'hex'], c: { z: 9, y: 8 } }),
  });

  const seeds = (img.functions || [])
    .map((f) => ({ name: f.name || `sub_${BigInt(f.address).toString(16)}`, address: BigInt(f.address) }))
    .filter((f) => f.address >= baseAddr && f.address < baseAddr + BigInt(rawBytes.length))
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

  for (let i = 0; i < seeds.length; i += 1) {
    const startAddr = seeds[i].address;
    const endAddr = i + 1 < seeds.length ? seeds[i + 1].address : baseAddr + BigInt(rawBytes.length);
    const startRow = Number((startAddr - baseAddr) / 4n);
    const endRow = Math.min(insns.length - 1, Number((endAddr - baseAddr) / 4n) - 1);
    if (endRow < startRow) continue;

    const slice = insns.slice(startRow, endRow + 1).map((ins, r) => ({ ...ins, row: r }));
    const rowOfAddress = (a) => {
      const diff = BigInt(a) - startAddr;
      return diff >= 0n && diff < BigInt(slice.length * 4) ? Number(diff / 4n) : null;
    };
    const model = buildSemanticModel(slice, {
      startRow: 0, endRow: slice.length - 1, rowOfAddress, symbolFor: () => null, name: seeds[i].name,
    });
    const builtCfg = buildCfg(model, { rowOfAddress });
    const succsList = (builtCfg?.nodes || []).map((node) => (node.succ || []).map((e) => e.to));
    if (succsList.length > 0) {
      const succs = succsList.map((arr) => Array.from(arr || []));
      const entry = builtCfg?.entry ?? 0;
      const g = analyzeGraph(succs, entry, null, { _forceJs: true });
      cfgGolden.push({
        binary: fx.id,
        func: seeds[i].name,
        entry,
        succs,
        idom: Array.from(g.immediateDominators || g.idom || []),
        ipdom: Array.from(g.immediatePostDominators || g.ipdom || []),
        reachable: Array.from(g.reachable || []),
        backEdges: (g.backEdges || []).map((e) => [e.from, e.to]),
      });
    }
  }
}

fs.writeFileSync(path.join(OUT_DIR, 'binary-outputs.json'), `${JSON.stringify(binaryGolden, null, 2)}\n`);
fs.writeFileSync(path.join(OUT_DIR, 'arm64-decode-outputs.json'), `${JSON.stringify(decodeGolden, null, 2)}\n`);
fs.writeFileSync(path.join(OUT_DIR, 'cfg-outputs.json'), `${JSON.stringify(cfgGolden, null, 2)}\n`);
fs.writeFileSync(path.join(OUT_DIR, 'identity-outputs.json'), `${JSON.stringify(identityGolden, null, 2)}\n`);

console.log(`Golden fixtures generated in ${OUT_DIR}:`);
console.log(`  binary-outputs.json: ${binaryGolden.length} cases (${realCorpus.length} real + ${corruptCorpus.length} corrupt/mutant)`);
console.log(`  arm64-decode-outputs.json: ${decodeGolden.length} instructions`);
console.log(`  cfg-outputs.json: ${cfgGolden.length} function CFGs`);
console.log(`  identity-outputs.json: ${identityGolden.length} identity records`);
