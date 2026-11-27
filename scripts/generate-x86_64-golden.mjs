#!/usr/bin/env node
/**
 * Generate fixtures/golden/x86_64-decode-outputs.json using Capstone x86_64 session
 * across all real x86_64 binaries in the repository corpus.
 */
import fs from 'node:fs';
import path from 'node:path';

import { openBinary } from '../js/binary/index.js';
import { createCapstoneX86Session } from '../tests/phase5/helpers/capstone-session.mjs';

const OUT_DIR = 'fixtures/golden';
fs.mkdirSync(OUT_DIR, { recursive: true });

const x86Corpus = [
  { id: 'x86_64-sysv-elf', file: 'tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf' },
  { id: 'x86_64-pe-exe', file: 'tests/phase5/corpus/fixtures/vertical-microsoft-x64.exe' },
  { id: 'x86_64-macho-o', file: 'tests/phase12/rebuild/fixtures/vertical-macho-x86_64.o' },
];

const session = await createCapstoneX86Session();
const out = [];

try {
  for (const fx of x86Corpus) {
    const bytes = new Uint8Array(fs.readFileSync(fx.file));
    const img = openBinary(bytes, { strings: false });
    const sec = (img.sections || []).find((s) => s.perms?.execute && Number(s.fileSize ?? s.size ?? 0n) > 0)
      || (img.sections || []).find((s) => /\.text|__text/i.test(s.name || '') && Number(s.fileSize ?? s.size ?? 0n) > 0);
    if (!sec) continue;
    const baseAddr = BigInt(sec.address ?? 0n);
    const fileOff = Number(sec.fileOffset ?? 0n);
    const fileLen = Number(sec.fileSize ?? sec.size ?? 0n);
    const raw = img.bytes.subarray(fileOff, fileOff + fileLen);
    if (!raw || raw.length === 0) continue;

    const decoded = session.decode(raw, baseAddr);
    for (const ins of decoded) {
      const addr = BigInt(ins.address);
      const size = Number(ins.length ?? ins.size ?? 1);
      const rel = Number(addr - baseAddr);
      const slice = rel >= 0 && rel + size <= raw.length
        ? Array.from(raw.subarray(rel, rel + size))
        : [];
      out.push({
        binary: fx.id,
        addr: addr.toString(16),
        size,
        bytes: slice,
        hex: slice.map((b) => b.toString(16).padStart(2, '0')).join(''),
        mnemonic: String(ins.mnemonic || '').toLowerCase(),
        opStr: String(ins.opStr || ''),
        groups: Array.isArray(ins.groups) ? ins.groups.slice() : [],
        operands: Array.isArray(ins.operands) ? ins.operands.map((op) => ({
          type: op.type ?? null,
          size: op.size ?? null,
          reg: op.reg ?? null,
          imm: op.imm != null ? String(op.imm) : null,
          mem: op.mem ? {
            base: op.mem.base ?? null,
            index: op.mem.index ?? null,
            scale: op.mem.scale ?? 1,
            disp: op.mem.disp != null ? String(op.mem.disp) : '0',
          } : null,
        })) : [],
      });
    }
  }
} finally {
  session.close();
}

fs.writeFileSync(path.join(OUT_DIR, 'x86_64-decode-outputs.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`x86_64-decode-outputs.json generated: ${out.length} instructions across ${x86Corpus.length} binaries`);
