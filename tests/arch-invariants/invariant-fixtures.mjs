/*
 * Synthetic fixtures for the architecture-invariant regressions.
 *
 * Every fixture here is built from literals produced inside this file: no
 * benchmark corpus, no real binary, no captured producer payload. That keeps
 * the regressions independent of the public benchmark gate and of any single
 * implementation strategy that later fixes the defects.
 *
 * Three fixtures are exported, one per architecture invariant:
 *   - threeBlockUnknownStoreFixture()   -> Semantic IR reachability + unknown store
 *   - smallUnknownFreeStoreFixture()    -> same, with no unknown store (control)
 *   - hugeDecompilerProducer()          -> large/deep internal decompiler state
 *   - aarch64SymbolImage(order)         -> same-address ELF symbol identity
 */

import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, OP, MK } from '../../js/ir.js';

/* ── Semantic IR fixtures (invariant 1) ─────────────────────────────────── */

const IR_BASE = 0x300000000n;

function semanticsOf(source) {
  const rows = source.map((line, index) => {
    const text = line.trim();
    const split = text.indexOf(' ');
    return {
      row: index,
      address: IR_BASE + BigInt(index * 4),
      mn: split < 0 ? text : text.slice(0, split),
      ops: split < 0 ? '' : text.slice(split + 1),
    };
  });
  const rowOfAddress = (address) => {
    const delta = address - IR_BASE;
    if (delta < 0n || delta >= BigInt(source.length * 4)) return null;
    return Number(delta / 4n);
  };
  const model = buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
  return { model, rowOfAddress };
}

/**
 * A three-block CFG: entry (null check) -> body -> return, where the body holds
 * a concrete field store, an unknown indexed store, and a load of the concrete
 * field. The unknown store sits between the concrete store and the load, so the
 * barrier query must report it and the load's concrete proof must be blocked.
 *
 * Rows: 0 cmp | 1 b.eq -> row 5 | 2 concrete store | 3 unknown store | 4 load | 5 ret
 */
export function threeBlockUnknownStoreFixture() {
  const source = [
    'cmp w0, #0',
    `b.eq #${IR_BASE + 20n}`,
    'str w1, [x19, #0x20]',
    'str w2, [x19, x3, lsl #2]',
    'ldr w8, [x19, #0x20]',
    'ret',
  ];
  const { model, rowOfAddress } = semanticsOf(source);
  const ir = buildIR(model, { rowOfAddress });
  const atRow = (row, op) => (ir?.instructions || []).find((inst) => inst.row === row && inst.op === op) || null;
  const concreteStore = atRow(2, OP.STORE);
  const unknownStore = atRow(3, OP.STORE);
  const load = atRow(4, OP.LOAD);
  assertFixture('three-block CFG has at least three blocks', ir.blocks.length >= 3, ir.blocks.length);
  assertFixture('concrete store is known-location', concreteStore?.loc && concreteStore.loc.kind !== MK.UNKNOWN, concreteStore?.loc?.kind);
  assertFixture('unknown store is MK.UNKNOWN', unknownStore?.loc?.kind === MK.UNKNOWN, unknownStore?.loc?.kind);
  assertFixture('load exists', !!load);
  return { ir, concreteStore, unknownStore, load, blockCount: ir.blocks.length };
}

/** One block, one concrete store, one load, no unknown store anywhere. */
export function smallUnknownFreeStoreFixture() {
  const source = ['str w1, [x19, #0x20]', 'ldr w8, [x19, #0x20]', 'ret'];
  const { model, rowOfAddress } = semanticsOf(source);
  const ir = buildIR(model, { rowOfAddress });
  const concreteStore = (ir?.instructions || []).find((inst) => inst.row === 0 && inst.op === OP.STORE) || null;
  const load = (ir?.instructions || []).find((inst) => inst.row === 1 && inst.op === OP.LOAD) || null;
  assertFixture('control fixture has a concrete store', !!concreteStore);
  assertFixture('control fixture has a load', !!load);
  assertFixture('control fixture has no unknown store',
    !(ir.instructions || []).some((inst) => inst.op === OP.STORE && inst.loc && inst.loc.kind === MK.UNKNOWN));
  return { ir, concreteStore, load };
}

function assertFixture(message, condition, detail) {
  if (!condition) throw new Error(`arch-invariant fixture invalid: ${message}${detail === undefined ? '' : ` (${String(detail)})`}`);
}

/* ── Huge internal decompiler producer (invariant 2) ────────────────────── */

export const HUGE_PSEUDOCODE = 'int synthetic_huge(void) { return probe_marker; }';
export const HUGE_LINE_COUNT = 2048;
export const HUGE_PROVENANCE = Object.freeze({
  source: 'decompiler',
  contract: 'arch-invariant-regression/v1',
  semanticIrVersion: 'v2',
  regionId: 'synthetic-huge-region',
});

export function hugeProducedLines(count = HUGE_LINE_COUNT) {
  const lines = new Array(count);
  for (let index = 0; index < count; index++) {
    lines[index] = { indent: index % 4, text: `synthetic_line_${index}`, address: BigInt(0x8000 + index) };
  }
  return lines;
}

/*
 * Deep expression tree: a 20000-level `args[0]` chain. This is the shape a real
 * decompiler hands back for heavily chained dataflow, and it is deeper than any
 * recursive walk (clone or freeze) can survive.
 */
function deepExpressionChain(depth) {
  let node = { kind: 'value', id: 'synthetic_leaf', bits: 64 };
  for (let index = 0; index < depth; index++) {
    node = {
      kind: 'binary',
      operator: 'add',
      id: `synthetic_op_${index}`,
      bits: 64,
      args: [node, { kind: 'constant', value: BigInt(index) }],
    };
  }
  return node;
}

/** A high-variable-like graph: every value defined by one node and used by the next. */
function variableGraph(size) {
  const nodes = new Array(size);
  const values = new Array(size);
  for (let index = 0; index < size; index++) {
    nodes[index] = { id: `node_${index}`, kind: 'op', inputs: index > 0 ? [`value_${index - 1}`] : [], outputs: [`value_${index}`] };
    values[index] = { id: `value_${index}`, def: `node_${index}`, uses: index + 1 < size ? [`node_${index + 1}`] : [], bits: 64 };
  }
  return { nodes, values };
}

/**
 * Product-critical surface (pseudocode / lines / provenance) plus an internal
 * IR-like state that is both large and deep. The public query must keep the
 * former and must not die on the latter; it is not required to publish the
 * internal graph at all.
 */
export function hugeDecompilerProducer({ unrelatedCallback = false, depth = 20000, size = 20000 } = {}) {
  const graph = variableGraph(size);
  const producer = {
    pseudocode: HUGE_PSEUDOCODE,
    lines: hugeProducedLines(),
    provenance: { ...HUGE_PROVENANCE },
    ir: {
      schemaVersion: 'legacy-ir/v1',
      provenance: { source: 'semantic-ir/v2' },
      expression: deepExpressionChain(depth),
      nodes: graph.nodes,
      values: graph.values,
    },
    variables: graph.values.slice(0, size),
  };
  if (unrelatedCallback) {
    producer.metadata = { resolver: () => 'this callback is not a query value' };
  }
  return producer;
}

/* ── Same-address ELF symbol identity (invariant 3) ─────────────────────── */

export const SYMBOL_ADDRESS = 0x10000n;
export const SYMBOL_FUNCTION_SIZE = 0x20n;

const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;
const ET_EXEC = 2;
const EM_AARCH64 = 183;
const SECTION_INDEX = 1;
const STB_LOCAL = 0;
const STT_NOTYPE = 0;
const STT_FUNC = 2;

/*
 * A local STT_NOTYPE zero-sized AArch64 mapping marker and a local STT_FUNC
 * symbol with a real size share one address inside one executable section.
 * `order` decides which record the raw symbol table lists first; nothing else
 * changes, so any difference in the canonical result is raw-input-order
 * dependence.
 */
export function aarch64SymbolRecords(order) {
  const marker = Object.freeze({
    role: 'mapping-marker',
    name: '$x',
    info: (STB_LOCAL << 4) | STT_NOTYPE,
    value: SYMBOL_ADDRESS,
    size: 0n,
  });
  const functionRecord = Object.freeze({
    role: 'real-function',
    name: 'synthetic_tick_core',
    info: (STB_LOCAL << 4) | STT_FUNC,
    value: SYMBOL_ADDRESS,
    size: SYMBOL_FUNCTION_SIZE,
  });
  if (order === 'marker-first') return [marker, functionRecord];
  if (order === 'function-first') return [functionRecord, marker];
  if (order === 'marker-only') return [marker];
  if (order === 'function-only') return [functionRecord];
  throw new TypeError(`unknown symbol order: ${String(order)}`);
}

/** Minimal ELF64 AArch64 ET_EXEC carrying exactly the supplied symbol records. */
export function buildAarch64Elf(symbols) {
  const sectionHeaderOffset = 0x200;
  const sectionHeaderSize = 64;
  const bytes = new Uint8Array(sectionHeaderOffset + sectionHeaderSize * 4);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, ET_EXEC, true);
  view.setUint16(18, EM_AARCH64, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(24, 0n, true);
  view.setBigUint64(32, 0x40n, true);
  view.setBigUint64(40, BigInt(sectionHeaderOffset), true);
  view.setUint32(48, 0, true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 1, true);
  view.setUint16(58, sectionHeaderSize, true);
  view.setUint16(60, 4, true);
  view.setUint16(62, 0, true);
  view.setUint32(0x40, 1, true);              // PT_LOAD
  view.setUint32(0x44, 5, true);              // R | X
  view.setBigUint64(0x48, 0x80n, true);       // p_offset
  view.setBigUint64(0x50, SYMBOL_ADDRESS, true);
  view.setBigUint64(0x58, SYMBOL_ADDRESS, true);
  view.setBigUint64(0x60, 0x100n, true);      // p_filesz
  view.setBigUint64(0x68, 0x100n, true);      // p_memsz
  view.setBigUint64(0x70, 4n, true);          // p_align (offset/vaddr congruent)

  const section = (index, fields) => {
    const at = sectionHeaderOffset + index * sectionHeaderSize;
    view.setUint32(at + 4, fields.type || 0, true);
    view.setBigUint64(at + 8, BigInt(fields.flags || 0), true);
    view.setBigUint64(at + 16, fields.address || 0n, true);
    view.setBigUint64(at + 24, BigInt(fields.offset || 0), true);
    view.setBigUint64(at + 32, BigInt(fields.size || 0), true);
    view.setUint32(at + 40, fields.link || 0, true);
    view.setUint32(at + 44, fields.info || 0, true);
    view.setBigUint64(at + 48, BigInt(fields.align || 1), true);
    view.setBigUint64(at + 56, BigInt(fields.entsize || 0), true);
  };

  section(SECTION_INDEX, {
    type: SHT_PROGBITS,
    flags: SHF_ALLOC | SHF_EXECINSTR,
    address: SYMBOL_ADDRESS,
    offset: 0x80,
    size: 0x100,
    align: 4,
  });

  const stringOffset = 0x90;
  const stringBytes = [0];
  for (const symbol of symbols) stringBytes.push(...[...symbol.name].map((character) => character.charCodeAt(0)), 0);
  bytes.set(stringBytes, stringOffset);
  section(2, { type: SHT_STRTAB, offset: stringOffset, size: stringBytes.length, align: 1 });

  const symbolOffset = 0x140;
  const entrySize = 24;
  let nameOffset = 1;
  symbols.forEach((symbol, index) => {
    const at = symbolOffset + (index + 1) * entrySize;
    view.setUint32(at, nameOffset, true);
    bytes[at + 4] = symbol.info;
    bytes[at + 5] = 0;
    view.setUint16(at + 6, SECTION_INDEX, true);
    view.setBigUint64(at + 8, symbol.value, true);
    view.setBigUint64(at + 16, symbol.size, true);
    nameOffset += symbol.name.length + 1;
  });
  section(3, {
    type: SHT_SYMTAB,
    offset: symbolOffset,
    size: (symbols.length + 1) * entrySize,
    link: 2,
    info: 1,
    align: 8,
    entsize: entrySize,
  });
  return bytes;
}
