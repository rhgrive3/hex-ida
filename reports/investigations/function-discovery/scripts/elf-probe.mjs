#!/usr/bin/env node
/**
 * function-discovery investigation / Phase 2 ELF evidence probe.
 *
 * For a given benchmark case id and a set of virtual addresses, print:
 *  - ELF type / entry point / machine
 *  - the section and segment each address falls in
 *  - the symbol table entries at exactly that address (if any)
 *  - the nearest preceding symbol (IDA/spread over)
 *  - whether a mapping symbol ($x/$d/$c) governs that address
 *  - .plt / .init / .fini / .text extents and whether the address is inside
 *
 * Read-only. Uses whichever of readelf/llvm-readelf is available.
 *
 * Usage: node elf-probe.mjs <caseId> <addr> [<addr> ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'benchmarks/public/codefuse-arm64/manifest.json'), 'utf8'),
);
const byId = new Map(MANIFEST.cases.map((c) => [c.id, c]));

const READELF = (() => {
  for (const t of ['readelf', 'llvm-readelf']) {
    try {
      execFileSync(t, ['--version'], { stdio: 'ignore' });
      return t;
    } catch {
      /* keep looking */
    }
  }
  throw new Error('no readelf available');
})();

function run(bin, args) {
  return execFileSync(READELF, [bin, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseSections(text) {
  const out = [];
  const re = /^\s*\[\s*(\d+)\]\s+(\S+)\s+(\S+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(\S*)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/;
  for (const line of text.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    if (m[2] === 'NULL') continue;
    out.push({
      index: Number(m[1]),
      name: m[2],
      type: m[3],
      addr: parseInt(m[4], 16),
      off: parseInt(m[5], 16),
      size: parseInt(m[6], 16),
      flags: m[8],
    });
  }
  return out;
}

function parseEntry(text) {
  const m = /Entry point\s+(0x[0-9a-f]+)/i.exec(text);
  return m ? BigInt(m[1]) : null;
}

function parseSymbols(text) {
  const out = [];
  // GNU readelf symbol line: "  12: 00000000000006d0    16 FUNC    LOCAL  DEFAULT   12 foo"
  const re = /^\s*(\d+):\s+([0-9a-f]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/;
  for (const line of text.split('\n')) {
    if (/^Symbol table/.test(line)) out.push({ table: line.trim() });
    const m = re.exec(line);
    if (!m) continue;
    out.push({
      num: Number(m[1]),
      value: m[2],
      size: Number(m[3]),
      type: m[4],
      bind: m[5],
      vis: m[6],
      ndx: m[7],
      name: m[8].trim(),
    });
  }
  return out;
}

const caseId = process.argv[2];
const addrs = process.argv.slice(3).map((a) => BigInt(a));
const meta = byId.get(caseId);
if (!meta) throw new Error(`unknown case id: ${caseId}`);
const bin = path.join(ROOT, 'benchmarks/public/codefuse-arm64', meta.binary);

const secText = run(bin, ['-SW']);
const symText = run(bin, ['-sW']);
const sections = parseSections(secText);
const symbols = parseSymbols(symText).filter((s) => s.value !== undefined && s.value !== null);

const allocExec = sections.filter((s) => s.addr > 0 || s.off > 0);
const sorted = [...sections].sort((a, b) => a.addr - b.addr);

function sectionOf(addr) {
  for (const s of sections) {
    if (s.type === 'NOBITS') {
      if (addr >= BigInt(s.addr) && addr < BigInt(s.addr + s.size) && s.size > 0 && s.addr > 0) {
        if (addr >= BigInt(s.addr) && addr < BigInt(s.addr) + BigInt(s.size)) return s;
      }
      continue;
    }
    if (addr >= BigInt(s.addr) && addr < BigInt(s.addr) + BigInt(s.size)) return s;
  }
  return null;
}

console.log(`case=${caseId} compiler=${meta.compiler} opt=${meta.optimization} debug=${meta.debug}`);
console.log(`binary=${meta.binary}`);
console.log(`readelf=${READELF}`);
console.log(
  'exec/alloc sections:',
  sorted
    .filter((s) => s.flags.includes('X') || s.flags.includes('A'))
    .map((s) => `${s.name}@0x${s.addr.toString(16)}+0x${s.size.toString(16)}${s.flags ? '[' + s.flags + ']' : ''}`)
    .join(' '),
);

for (const addr of addrs) {
  const hexAddr = '0x' + addr.toString(16);
  const sec = sectionOf(addr);
  const exact = symbols.filter((s) => BigInt('0x' + s.value) === addr);
  const before = symbols
    .filter((s) => BigInt('0x' + s.value) <= addr && s.type !== undefined)
    .sort((a, b) => (BigInt('0x' + b.value) > BigInt('0x' + a.value) ? 1 : -1))[0];
  const nextSym = symbols
    .filter((s) => BigInt('0x' + s.value) > addr)
    .sort((a, b) => (BigInt('0x' + a.value) < BigInt('0x' + b.value) ? -1 : 1))[0];
  console.log(`\n${hexAddr}`);
  console.log(`  section=${sec ? sec.name : 'NONE'} (addr=0x${sec ? sec.addr.toString(16) : '-'} size=0x${sec ? sec.size.toString(16) : '-'} ${sec ? sec.flags : ''})`);
  console.log(`  exact symbols=${exact.length}`);
  for (const s of exact.slice(0, 8)) {
    console.log(`    ${s.table ?? ''} ${s.type} ${s.bind} ${s.vis} ndx=${s.ndx} size=${s.size} name=${s.name}`);
  }
  console.log(
    `  nearest-before=${before ? `${before.name || '<anon>'} ${before.type} 0x${before.value} size=${before.size} ndx=${before.ndx}` : '-'}`,
  );
  console.log(
    `  nearest-after =${nextSym ? `${nextSym.name || '<anon>'} ${nextSym.type} 0x${nextSym.value} size=${nextSym.size} ndx=${nextSym.ndx}` : '-'}`,
  );
}
