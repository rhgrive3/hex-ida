/*
 * Track D (OSS Integration): Google BinExport v2 Real Protobuf Binary Encoder & Decoder.
 *
 * 1:1 wire-compatible with `third_party/binexport/binexport2.proto` (Apache-2.0, syntax = "proto2").
 * Zero external runtime dependencies, pure ESM JS, full 64-bit BigInt address support,
 * strict bounds/sanity validation against malformed inputs, control characters, and non-finite numbers.
 */

export const WIRE_TYPE = Object.freeze({
  VARINT: 0,
  FIXED64: 1,
  LEN: 2,
  FIXED32: 5,
});

export const BINEXPORT2_FIELDS = Object.freeze({
  META_INFORMATION: 1,
  EXPRESSION: 2,
  OPERAND: 3,
  MNEMONIC: 4,
  INSTRUCTION: 5,
  BASIC_BLOCK: 6,
  FLOW_GRAPH: 7,
  CALL_GRAPH: 8,
  STRING_TABLE: 9,
  ADDRESS_COMMENT: 10,
  STRING_REFERENCE: 11,
  EXPRESSION_SUBSTITUTION: 12,
  SECTION: 13,
  LIBRARY: 14,
  DATA_REFERENCE: 15,
  MODULE: 16,
  COMMENT: 17,
  MD_INDEX: 93992622,
});

export const CALL_GRAPH_VERTEX_TYPE = Object.freeze({
  NORMAL: 0,
  LIBRARY: 1,
  IMPORTED: 2,
  THUNK: 3,
  INVALID: 4,
});

export const EXPRESSION_TYPE = Object.freeze({
  SYMBOL: 1,
  IMMEDIATE_INT: 2,
  IMMEDIATE_FLOAT: 3,
  OPERATOR: 4,
  REGISTER: 5,
  SIZE_PREFIX: 6,
  DEREFERENCE: 7,
});

export const FLOW_GRAPH_EDGE_TYPE = Object.freeze({
  CONDITION_TRUE: 1,
  CONDITION_FALSE: 2,
  UNCONDITIONAL: 3,
  SWITCH: 4,
});

export const COMMENT_TYPE = Object.freeze({
  DEFAULT: 0,
  ANTERIOR: 1,
  POSTERIOR: 2,
  FUNCTION: 3,
  ENUM: 4,
  LOCATION: 5,
  GLOBAL_REFERENCE: 6,
  LOCAL_REFERENCE: 7,
});

export const MAX_BINEXPORT2_BYTES = 64 * 1024 * 1024; // 64 MiB hard cap
const MAX_UINT64 = 0xffffffffffffffffn;
const MIN_INT32 = -2147483648;
const MAX_INT32 = 2147483647;
const CTRL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

/* ── Safe Value Coercion & Validation ────────────────────────── */

function parseUint64(value, label = 'uint64') {
  if (typeof value === 'bigint') {
    if (value < 0n || value > MAX_UINT64) {
      throw new RangeError(`${label} out of uint64 range: ${value}`);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
      throw new RangeError(`${label} must be a non-negative safe integer or BigInt (got ${value})`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (/^(?:0x[0-9a-f]+|\d+)$/i.test(s)) {
      const big = BigInt(s);
      if (big < 0n || big > MAX_UINT64) throw new RangeError(`${label} out of uint64 range: ${s}`);
      return big;
    }
  }
  throw new TypeError(`Invalid ${label}: ${String(value)}`);
}

const MIN_INT64 = -(1n << 63n);
const MAX_INT64 = (1n << 63n) - 1n;

function parseInt64(value, label = 'int64') {
  let big;
  if (typeof value === 'bigint') {
    big = value;
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new RangeError(`${label} must be a finite safe integer (got ${value})`);
    }
    big = BigInt(value);
  } else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    big = BigInt(value.trim());
  } else {
    throw new TypeError(`Invalid ${label}: ${String(value)}`);
  }
  if (big < MIN_INT64 || big > MAX_INT64) {
    throw new RangeError(`${label} out of int64 range: ${big}`);
  }
  return big;
}

function parseInt32(value, label = 'int32') {
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_INT32 || n > MAX_INT32) {
    throw new RangeError(`${label} out of int32 range: ${value}`);
  }
  return n;
}

function sanitizeString(value, { allowNewlines = false } = {}) {
  const s = String(value ?? '');
  if (allowNewlines) return s.replace(CTRL_CHAR_RE, '');
  return s.replace(CTRL_CHAR_RE, '').replace(/[\r\n]/g, ' ');
}

/* ── Low-Level Protobuf Wire Writer ──────────────────────────── */

class ProtoWriter {
  constructor(initialCap = 256) {
    this.buf = new Uint8Array(initialCap);
    this.pos = 0;
  }

  _ensure(extra) {
    const needed = this.pos + extra;
    if (needed <= this.buf.length) return;
    if (needed > MAX_BINEXPORT2_BYTES) {
      throw new RangeError(`BinExport2 output exceeds max size (${MAX_BINEXPORT2_BYTES} bytes)`);
    }
    let nextLen = this.buf.length * 2;
    while (nextLen < needed) nextLen *= 2;
    const next = new Uint8Array(Math.min(nextLen, MAX_BINEXPORT2_BYTES));
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  writeVarintBigInt(val) {
    if (val < MIN_INT64 || val > MAX_UINT64) {
      throw new RangeError(`Protobuf varint out of 64-bit range: ${val}`);
    }
    // Convert signed negative values to 64-bit two's complement (Protobuf proto2 int32/int64 encoding)
    let v = val < 0n ? (val & MAX_UINT64) : val;
    this._ensure(10);
    while (v >= 0x80n) {
      this.buf[this.pos++] = Number((v & 0x7fn) | 0x80n);
      v >>= 7n;
    }
    this.buf[this.pos++] = Number(v);
  }

  writeTag(fieldNumber, wireType) {
    const tag = (BigInt(fieldNumber) << 3n) | BigInt(wireType);
    this.writeVarintBigInt(tag);
  }

  writeUint64(fieldNumber, val) {
    this.writeTag(fieldNumber, WIRE_TYPE.VARINT);
    this.writeVarintBigInt(parseUint64(val, `field ${fieldNumber}`));
  }

  writeInt64(fieldNumber, val) {
    this.writeTag(fieldNumber, WIRE_TYPE.VARINT);
    this.writeVarintBigInt(parseInt64(val, `field ${fieldNumber}`));
  }

  writeInt32(fieldNumber, val) {
    this.writeTag(fieldNumber, WIRE_TYPE.VARINT);
    this.writeVarintBigInt(BigInt(parseInt32(val, `field ${fieldNumber}`)));
  }

  writeBool(fieldNumber, val) {
    this.writeTag(fieldNumber, WIRE_TYPE.VARINT);
    this.writeVarintBigInt(val ? 1n : 0n);
  }

  writeDouble(fieldNumber, val) {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      throw new RangeError(`field ${fieldNumber} double must be finite (got ${val})`);
    }
    this.writeTag(fieldNumber, WIRE_TYPE.FIXED64);
    this._ensure(8);
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    dv.setFloat64(0, val, true);
    this.pos += 8;
  }

  writeBytes(fieldNumber, bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.writeTag(fieldNumber, WIRE_TYPE.LEN);
    this.writeVarintBigInt(BigInt(u8.byteLength));
    this._ensure(u8.byteLength);
    this.buf.set(u8, this.pos);
    this.pos += u8.byteLength;
  }

  writeString(fieldNumber, str) {
    const encoded = textEncoder.encode(str);
    this.writeBytes(fieldNumber, encoded);
  }

  writeMessage(fieldNumber, subWriter) {
    this.writeBytes(fieldNumber, subWriter.finish());
  }

  finish() {
    return this.buf.slice(0, this.pos);
  }
}

/* ── Low-Level Protobuf Wire Reader ──────────────────────────── */

class ProtoReader {
  constructor(bytes, start = 0, end = bytes.byteLength) {
    this.buf = bytes;
    this.pos = start;
    this.end = end;
  }

  eof() {
    return this.pos >= this.end;
  }

  readVarintBigInt() {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i += 1) {
      if (this.pos >= this.end) throw new RangeError('Truncated Protobuf varint');
      const b = this.buf[this.pos++];
      if (i === 9 && b > 0x01) {
        throw new RangeError('Protobuf varint exceeds 64 bits');
      }
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new RangeError('Malformed Protobuf varint (>10 bytes)');
  }

  readInt32() {
    const u = this.readVarintBigInt();
    // Sign-extend lower 32 bits
    return Number(BigInt.asIntN(32, u));
  }

  readInt64() {
    return BigInt.asIntN(64, this.readVarintBigInt());
  }

  readUint64() {
    return BigInt.asUintN(64, this.readVarintBigInt());
  }

  readBool() {
    return this.readVarintBigInt() !== 0n;
  }

  readDouble() {
    if (this.pos + 8 > this.end) throw new RangeError('Truncated Protobuf fixed64');
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    const val = dv.getFloat64(0, true);
    this.pos += 8;
    return val;
  }

  readTag() {
    const tag = this.readVarintBigInt();
    const wireType = Number(tag & 7n);
    const fieldNumber = Number(tag >> 3n);
    if (!Number.isSafeInteger(fieldNumber) || fieldNumber <= 0) {
      throw new RangeError(`Invalid Protobuf field number: ${fieldNumber}`);
    }
    return { fieldNumber, wireType };
  }

  readBytes() {
    const lenBig = this.readVarintBigInt();
    if (lenBig < 0n || lenBig > BigInt(this.end - this.pos)) {
      throw new RangeError(`Truncated Protobuf length-delimited field (len=${lenBig})`);
    }
    const len = Number(lenBig);
    const slice = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  readSubReader() {
    const lenBig = this.readVarintBigInt();
    if (lenBig < 0n || lenBig > BigInt(this.end - this.pos)) {
      throw new RangeError(`Truncated Protobuf embedded message (len=${lenBig})`);
    }
    const len = Number(lenBig);
    const sub = new ProtoReader(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return sub;
  }

  readString() {
    return textDecoder.decode(this.readBytes());
  }

  skip(wireType) {
    if (wireType === WIRE_TYPE.VARINT) {
      this.readVarintBigInt();
    } else if (wireType === WIRE_TYPE.FIXED64) {
      if (this.pos + 8 > this.end) throw new RangeError('Truncated fixed64');
      this.pos += 8;
    } else if (wireType === WIRE_TYPE.LEN) {
      const lenBig = this.readVarintBigInt();
      if (lenBig < 0n || lenBig > BigInt(this.end - this.pos)) {
        throw new RangeError('Truncated length-delimited field');
      }
      this.pos += Number(lenBig);
    } else if (wireType === WIRE_TYPE.FIXED32) {
      if (this.pos + 4 > this.end) throw new RangeError('Truncated fixed32');
      this.pos += 4;
    } else {
      throw new RangeError(`Unsupported Protobuf wire type: ${wireType}`);
    }
  }
}

/* ── Message Encoders (1:1 with binexport2.proto) ────────────── */

function encodeMeta(meta) {
  const w = new ProtoWriter(64);
  if (meta.executableName != null || meta.executable_name != null) {
    w.writeString(1, sanitizeString(meta.executableName ?? meta.executable_name));
  }
  if (meta.executableId != null || meta.executable_id != null) {
    w.writeString(2, sanitizeString(meta.executableId ?? meta.executable_id));
  }
  if (meta.architectureName != null || meta.architecture_name != null) {
    w.writeString(3, sanitizeString(meta.architectureName ?? meta.architecture_name));
  }
  if (meta.timestamp != null) {
    w.writeInt64(4, meta.timestamp);
  }
  return w;
}

function encodeExpression(expr) {
  const w = new ProtoWriter(32);
  const typeVal = expr.type ?? EXPRESSION_TYPE.IMMEDIATE_INT;
  if (typeVal !== EXPRESSION_TYPE.IMMEDIATE_INT) {
    w.writeInt32(1, typeVal);
  }
  if (expr.symbol != null) {
    w.writeString(2, sanitizeString(expr.symbol));
  }
  if (expr.immediate != null) {
    w.writeUint64(3, expr.immediate);
  }
  const parentIdx = expr.parentIndex ?? expr.parent_index;
  if (parentIdx != null) {
    w.writeInt32(4, parentIdx);
  }
  const isReloc = expr.isRelocation ?? expr.is_relocation;
  if (isReloc) {
    w.writeBool(5, true);
  }
  return w;
}

function encodeOperand(op) {
  const w = new ProtoWriter(16);
  const indices = op.expressionIndex ?? op.expression_index ?? [];
  for (const idx of indices) {
    w.writeInt32(1, idx);
  }
  return w;
}

function encodeMnemonic(m) {
  const w = new ProtoWriter(16);
  const name = typeof m === 'string' ? m : (m?.name ?? '');
  w.writeString(1, sanitizeString(name));
  return w;
}

function encodeInstruction(insn) {
  const w = new ProtoWriter(32);
  if (insn.address != null) {
    w.writeUint64(1, insn.address);
  }
  const targets = insn.callTarget ?? insn.call_target ?? [];
  for (const t of targets) {
    w.writeUint64(2, t);
  }
  const mnemIdx = insn.mnemonicIndex ?? insn.mnemonic_index;
  if (mnemIdx != null && mnemIdx !== 0) {
    w.writeInt32(3, mnemIdx);
  }
  const opIndices = insn.operandIndex ?? insn.operand_index ?? [];
  for (const idx of opIndices) {
    w.writeInt32(4, idx);
  }
  const rawBytes = insn.rawBytes ?? insn.raw_bytes;
  if (rawBytes != null) {
    w.writeBytes(5, rawBytes);
  }
  const commentIndices = insn.commentIndex ?? insn.comment_index ?? [];
  for (const idx of commentIndices) {
    w.writeInt32(6, idx);
  }
  return w;
}

function encodeBasicBlock(bb) {
  const w = new ProtoWriter(24);
  const ranges = bb.instructionIndex ?? bb.instruction_index ?? [];
  for (const r of ranges) {
    const rw = new ProtoWriter(16);
    const begin = r.beginIndex ?? r.begin_index;
    const end = r.endIndex ?? r.end_index;
    if (begin != null) rw.writeInt32(1, begin);
    if (end != null) rw.writeInt32(2, end);
    w.writeMessage(1, rw);
  }
  return w;
}

function encodeFlowGraph(fg) {
  const w = new ProtoWriter(64);
  const bbIndices = fg.basicBlockIndex ?? fg.basic_block_index ?? [];
  for (const idx of bbIndices) {
    w.writeInt32(1, idx);
  }
  const edges = fg.edge ?? fg.edges ?? [];
  for (const e of edges) {
    const ew = new ProtoWriter(24);
    const src = e.sourceBasicBlockIndex ?? e.source_basic_block_index;
    const dst = e.targetBasicBlockIndex ?? e.target_basic_block_index;
    if (src != null) ew.writeInt32(1, src);
    if (dst != null) ew.writeInt32(2, dst);
    const typeVal = e.type ?? FLOW_GRAPH_EDGE_TYPE.UNCONDITIONAL;
    if (typeVal !== FLOW_GRAPH_EDGE_TYPE.UNCONDITIONAL) {
      ew.writeInt32(3, typeVal);
    }
    const isBack = e.isBackEdge ?? e.is_back_edge;
    if (isBack) {
      ew.writeBool(4, true);
    }
    w.writeMessage(2, ew);
  }
  const entry = fg.entryBasicBlockIndex ?? fg.entry_basic_block_index;
  if (entry != null) {
    w.writeInt32(3, entry);
  }
  return w;
}

function encodeCallGraph(cg) {
  const w = new ProtoWriter(128);
  const rawVertices = Array.isArray(cg.vertex ?? cg.vertices) ? (cg.vertex ?? cg.vertices) : [];
  const rawEdges = Array.isArray(cg.edge ?? cg.edges) ? (cg.edge ?? cg.edges) : [];

  // BinDiff invariant (binexport2.proto:142-145): vertices MUST be sorted ascending by address
  const indexed = rawVertices.map((v, origIdx) => ({
    origIdx,
    addr: parseUint64(v.address ?? 0n, 'CallGraph.Vertex.address'),
    v,
  }));
  indexed.sort((a, b) => (a.addr < b.addr ? -1 : (a.addr > b.addr ? 1 : a.origIdx - b.origIdx)));

  const oldToNew = new Map();
  indexed.forEach((item, newIdx) => oldToNew.set(item.origIdx, newIdx));

  for (const { addr, v } of indexed) {
    const vw = new ProtoWriter(48);
    vw.writeUint64(1, addr);
    const vType = v.type ?? CALL_GRAPH_VERTEX_TYPE.NORMAL;
    if (vType !== CALL_GRAPH_VERTEX_TYPE.NORMAL) {
      vw.writeInt32(2, vType);
    }
    const mangled = v.mangledName ?? v.mangled_name;
    if (mangled != null && String(mangled) !== '') {
      vw.writeString(3, sanitizeString(mangled));
    }
    const demangled = v.demangledName ?? v.demangled_name;
    if (demangled != null && String(demangled) !== '') {
      vw.writeString(4, sanitizeString(demangled));
    }
    const libIdx = v.libraryIndex ?? v.library_index;
    if (libIdx != null) {
      vw.writeInt32(5, libIdx);
    }
    const modIdx = v.moduleIndex ?? v.module_index;
    if (modIdx != null) {
      vw.writeInt32(6, modIdx);
    }
    w.writeMessage(1, vw);
  }

  for (const e of rawEdges) {
    const ew = new ProtoWriter(16);
    const origSrc = parseInt32(e.sourceVertexIndex ?? e.source_vertex_index, 'CallGraph.Edge.source_vertex_index');
    const origDst = parseInt32(e.targetVertexIndex ?? e.target_vertex_index, 'CallGraph.Edge.target_vertex_index');
    if (!oldToNew.has(origSrc) || !oldToNew.has(origDst)) {
      throw new RangeError(`CallGraph.Edge references out-of-range vertex index (source=${origSrc}, target=${origDst}, vertices=${rawVertices.length})`);
    }
    const mappedSrc = oldToNew.get(origSrc);
    const mappedDst = oldToNew.get(origDst);
    ew.writeInt32(1, mappedSrc);
    ew.writeInt32(2, mappedDst);
    w.writeMessage(2, ew);
  }
  return w;
}

function encodeSection(sec) {
  const w = new ProtoWriter(32);
  if (sec.address != null) w.writeUint64(1, sec.address);
  if (sec.size != null) w.writeUint64(2, sec.size);
  const flagR = sec.flagR ?? sec.flag_r;
  const flagW = sec.flagW ?? sec.flag_w;
  const flagX = sec.flagX ?? sec.flag_x;
  if (flagR != null) w.writeBool(3, Boolean(flagR));
  if (flagW != null) w.writeBool(4, Boolean(flagW));
  if (flagX != null) w.writeBool(5, Boolean(flagX));
  return w;
}

function encodeLibrary(lib) {
  const w = new ProtoWriter(32);
  const isStatic = lib.isStatic ?? lib.is_static;
  if (isStatic != null) w.writeBool(1, Boolean(isStatic));
  const loadAddr = lib.loadAddress ?? lib.load_address;
  if (loadAddr != null && parseUint64(loadAddr, 'Library.load_address') !== 0n) {
    w.writeUint64(2, loadAddr);
  }
  if (lib.name != null) w.writeString(3, sanitizeString(lib.name));
  return w;
}

function encodeDataReference(ref) {
  const w = new ProtoWriter(24);
  const insnIdx = ref.instructionIndex ?? ref.instruction_index;
  if (insnIdx != null) w.writeInt32(1, insnIdx);
  if (ref.address != null) w.writeUint64(2, ref.address);
  return w;
}

function encodeComment(c) {
  const w = new ProtoWriter(32);
  const insnIdx = c.instructionIndex ?? c.instruction_index;
  if (insnIdx != null) w.writeInt32(1, insnIdx);
  const opIdx = c.instructionOperandIndex ?? c.instruction_operand_index;
  if (opIdx != null && opIdx !== 0) w.writeInt32(2, opIdx);
  const exprIdx = c.operandExpressionIndex ?? c.operand_expression_index;
  if (exprIdx != null && exprIdx !== 0) w.writeInt32(3, exprIdx);
  const strIdx = c.stringTableIndex ?? c.string_table_index;
  if (strIdx != null) w.writeInt32(4, strIdx);
  if (c.repeatable != null) w.writeBool(5, Boolean(c.repeatable));
  const cType = c.type ?? COMMENT_TYPE.DEFAULT;
  if (cType !== COMMENT_TYPE.DEFAULT) w.writeInt32(6, cType);
  return w;
}

/**
 * Encodes a BinExport2 model object into a real Protobuf `.BinExport` v2 `Uint8Array`.
 * Accepts both camelCase (`metaInformation`, `callGraph`, `basicBlock`, ...) and
 * snake_case (`meta_information`, `call_graph`, `basic_block`, ...) field names.
 */
export function encodeBinExport2(model = {}) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    throw new TypeError('encodeBinExport2 requires a model object');
  }
  const w = new ProtoWriter(512);

  const meta = model.metaInformation ?? model.meta_information ?? model.meta;
  if (meta && typeof meta === 'object') {
    w.writeMessage(BINEXPORT2_FIELDS.META_INFORMATION, encodeMeta(meta));
  }

  for (const expr of (model.expression ?? model.expressions ?? [])) {
    w.writeMessage(BINEXPORT2_FIELDS.EXPRESSION, encodeExpression(expr));
  }
  for (const op of (model.operand ?? model.operands ?? [])) {
    w.writeMessage(BINEXPORT2_FIELDS.OPERAND, encodeOperand(op));
  }
  for (const mnem of (model.mnemonic ?? model.mnemonics ?? [])) {
    w.writeMessage(BINEXPORT2_FIELDS.MNEMONIC, encodeMnemonic(mnem));
  }
  for (const insn of (model.instruction ?? model.instructions ?? [])) {
    w.writeMessage(BINEXPORT2_FIELDS.INSTRUCTION, encodeInstruction(insn));
  }
  for (const bb of (model.basicBlock ?? model.basic_block ?? model.basicBlocks ?? [])) {
    w.writeMessage(BINEXPORT2_FIELDS.BASIC_BLOCK, encodeBasicBlock(bb));
  }
  for (const fg of (model.flowGraph ?? model.flow_graph ?? model.flowGraphs ?? [])) {
    w.writeMessage(BINEXPORT2_FIELDS.FLOW_GRAPH, encodeFlowGraph(fg));
  }
  const cg = model.callGraph ?? model.call_graph;
  if (cg && typeof cg === 'object') {
    w.writeMessage(BINEXPORT2_FIELDS.CALL_GRAPH, encodeCallGraph(cg));
  }
  for (const s of (model.stringTable ?? model.string_table ?? [])) {
    w.writeString(BINEXPORT2_FIELDS.STRING_TABLE, sanitizeString(s, { allowNewlines: true }));
  }
  for (const sec of (model.section ?? model.sections ?? [])) {
    w.writeMessage(BINEXPORT2_FIELDS.SECTION, encodeSection(sec));
  }
  for (const lib of (model.library ?? model.libraries ?? [])) {
    w.writeMessage(BINEXPORT2_FIELDS.LIBRARY, encodeLibrary(lib));
  }
  for (const ref of (model.dataReference ?? model.data_reference ?? model.dataReferences ?? [])) {
    w.writeMessage(BINEXPORT2_FIELDS.DATA_REFERENCE, encodeDataReference(ref));
  }
  for (const mod of (model.module ?? model.modules ?? [])) {
    const mw = new ProtoWriter(16);
    mw.writeString(1, sanitizeString(typeof mod === 'string' ? mod : mod?.name));
    w.writeMessage(BINEXPORT2_FIELDS.MODULE, mw);
  }
  for (const c of (model.comment ?? model.comments ?? [])) {
    w.writeMessage(BINEXPORT2_FIELDS.COMMENT, encodeComment(c));
  }
  for (const md of (model.mdIndex ?? model.md_index ?? [])) {
    const mdw = new ProtoWriter(24);
    if (md.address != null) mdw.writeUint64(1, md.address);
    const score = md.mdIndex ?? md.md_index;
    if (score != null) mdw.writeDouble(2, score);
    w.writeMessage(BINEXPORT2_FIELDS.MD_INDEX, mdw);
  }

  return w.finish();
}

/* ── Message Decoders (1:1 with binexport2.proto) ────────────── */

function decodeMeta(r) {
  const out = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1 && wireType === WIRE_TYPE.LEN) out.executableName = r.readString();
    else if (fieldNumber === 2 && wireType === WIRE_TYPE.LEN) out.executableId = r.readString();
    else if (fieldNumber === 3 && wireType === WIRE_TYPE.LEN) out.architectureName = r.readString();
    else if (fieldNumber === 4 && wireType === WIRE_TYPE.VARINT) out.timestamp = r.readInt64();
    else r.skip(wireType);
  }
  return out;
}

function decodeExpression(r) {
  const out = { type: EXPRESSION_TYPE.IMMEDIATE_INT, isRelocation: false };
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1 && wireType === WIRE_TYPE.VARINT) out.type = r.readInt32();
    else if (fieldNumber === 2 && wireType === WIRE_TYPE.LEN) out.symbol = r.readString();
    else if (fieldNumber === 3 && wireType === WIRE_TYPE.VARINT) out.immediate = r.readUint64();
    else if (fieldNumber === 4 && wireType === WIRE_TYPE.VARINT) out.parentIndex = r.readInt32();
    else if (fieldNumber === 5 && wireType === WIRE_TYPE.VARINT) out.isRelocation = r.readBool();
    else r.skip(wireType);
  }
  return out;
}

function decodeOperand(r) {
  const out = { expressionIndex: [] };
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1 && wireType === WIRE_TYPE.VARINT) out.expressionIndex.push(r.readInt32());
    else r.skip(wireType);
  }
  return out;
}

function decodeMnemonic(r) {
  const out = { name: '' };
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1 && wireType === WIRE_TYPE.LEN) out.name = r.readString();
    else r.skip(wireType);
  }
  return out;
}

function decodeInstruction(r) {
  const out = { callTarget: [], mnemonicIndex: 0, operandIndex: [], commentIndex: [] };
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1 && wireType === WIRE_TYPE.VARINT) out.address = r.readUint64();
    else if (fieldNumber === 2 && wireType === WIRE_TYPE.VARINT) out.callTarget.push(r.readUint64());
    else if (fieldNumber === 3 && wireType === WIRE_TYPE.VARINT) out.mnemonicIndex = r.readInt32();
    else if (fieldNumber === 4 && wireType === WIRE_TYPE.VARINT) out.operandIndex.push(r.readInt32());
    else if (fieldNumber === 5 && wireType === WIRE_TYPE.LEN) out.rawBytes = r.readBytes();
    else if (fieldNumber === 6 && wireType === WIRE_TYPE.VARINT) out.commentIndex.push(r.readInt32());
    else r.skip(wireType);
  }
  return out;
}

function decodeBasicBlock(r) {
  const out = { instructionIndex: [] };
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1 && wireType === WIRE_TYPE.LEN) {
      const sub = r.readSubReader();
      const range = {};
      while (!sub.eof()) {
        const t = sub.readTag();
        if (t.fieldNumber === 1 && t.wireType === WIRE_TYPE.VARINT) range.beginIndex = sub.readInt32();
        else if (t.fieldNumber === 2 && t.wireType === WIRE_TYPE.VARINT) range.endIndex = sub.readInt32();
        else sub.skip(t.wireType);
      }
      out.instructionIndex.push(range);
    } else {
      r.skip(wireType);
    }
  }
  return out;
}

function decodeFlowGraph(r) {
  const out = { basicBlockIndex: [], edge: [] };
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1 && wireType === WIRE_TYPE.VARINT) {
      out.basicBlockIndex.push(r.readInt32());
    } else if (fieldNumber === 2 && wireType === WIRE_TYPE.LEN) {
      const sub = r.readSubReader();
      const edge = { type: FLOW_GRAPH_EDGE_TYPE.UNCONDITIONAL, isBackEdge: false };
      while (!sub.eof()) {
        const t = sub.readTag();
        if (t.fieldNumber === 1 && t.wireType === WIRE_TYPE.VARINT) edge.sourceBasicBlockIndex = sub.readInt32();
        else if (t.fieldNumber === 2 && t.wireType === WIRE_TYPE.VARINT) edge.targetBasicBlockIndex = sub.readInt32();
        else if (t.fieldNumber === 3 && t.wireType === WIRE_TYPE.VARINT) edge.type = sub.readInt32();
        else if (t.fieldNumber === 4 && t.wireType === WIRE_TYPE.VARINT) edge.isBackEdge = sub.readBool();
        else sub.skip(t.wireType);
      }
      out.edge.push(edge);
    } else if (fieldNumber === 3 && wireType === WIRE_TYPE.VARINT) {
      out.entryBasicBlockIndex = r.readInt32();
    } else {
      r.skip(wireType);
    }
  }
  return out;
}

function decodeCallGraph(r) {
  const out = { vertex: [], edge: [] };
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1 && wireType === WIRE_TYPE.LEN) {
      const sub = r.readSubReader();
      const v = { type: CALL_GRAPH_VERTEX_TYPE.NORMAL };
      while (!sub.eof()) {
        const t = sub.readTag();
        if (t.fieldNumber === 1 && t.wireType === WIRE_TYPE.VARINT) v.address = sub.readUint64();
        else if (t.fieldNumber === 2 && t.wireType === WIRE_TYPE.VARINT) v.type = sub.readInt32();
        else if (t.fieldNumber === 3 && t.wireType === WIRE_TYPE.LEN) v.mangledName = sub.readString();
        else if (t.fieldNumber === 4 && t.wireType === WIRE_TYPE.LEN) v.demangledName = sub.readString();
        else if (t.fieldNumber === 5 && t.wireType === WIRE_TYPE.VARINT) v.libraryIndex = sub.readInt32();
        else if (t.fieldNumber === 6 && t.wireType === WIRE_TYPE.VARINT) v.moduleIndex = sub.readInt32();
        else sub.skip(t.wireType);
      }
      out.vertex.push(v);
    } else if (fieldNumber === 2 && wireType === WIRE_TYPE.LEN) {
      const sub = r.readSubReader();
      const e = {};
      while (!sub.eof()) {
        const t = sub.readTag();
        if (t.fieldNumber === 1 && t.wireType === WIRE_TYPE.VARINT) e.sourceVertexIndex = sub.readInt32();
        else if (t.fieldNumber === 2 && t.wireType === WIRE_TYPE.VARINT) e.targetVertexIndex = sub.readInt32();
        else sub.skip(t.wireType);
      }
      out.edge.push(e);
    } else {
      r.skip(wireType);
    }
  }
  return out;
}

function decodeSection(r) {
  const out = { flagR: false, flagW: false, flagX: false };
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1 && wireType === WIRE_TYPE.VARINT) out.address = r.readUint64();
    else if (fieldNumber === 2 && wireType === WIRE_TYPE.VARINT) out.size = r.readUint64();
    else if (fieldNumber === 3 && wireType === WIRE_TYPE.VARINT) out.flagR = r.readBool();
    else if (fieldNumber === 4 && wireType === WIRE_TYPE.VARINT) out.flagW = r.readBool();
    else if (fieldNumber === 5 && wireType === WIRE_TYPE.VARINT) out.flagX = r.readBool();
    else r.skip(wireType);
  }
  return out;
}

function decodeLibrary(r) {
  const out = { isStatic: false, loadAddress: 0n, name: '' };
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1 && wireType === WIRE_TYPE.VARINT) out.isStatic = r.readBool();
    else if (fieldNumber === 2 && wireType === WIRE_TYPE.VARINT) out.loadAddress = r.readUint64();
    else if (fieldNumber === 3 && wireType === WIRE_TYPE.LEN) out.name = r.readString();
    else r.skip(wireType);
  }
  return out;
}

function decodeDataReference(r) {
  const out = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1 && wireType === WIRE_TYPE.VARINT) out.instructionIndex = r.readInt32();
    else if (fieldNumber === 2 && wireType === WIRE_TYPE.VARINT) out.address = r.readUint64();
    else r.skip(wireType);
  }
  return out;
}

function decodeComment(r) {
  const out = { instructionOperandIndex: 0, operandExpressionIndex: 0, repeatable: false, type: COMMENT_TYPE.DEFAULT };
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1 && wireType === WIRE_TYPE.VARINT) out.instructionIndex = r.readInt32();
    else if (fieldNumber === 2 && wireType === WIRE_TYPE.VARINT) out.instructionOperandIndex = r.readInt32();
    else if (fieldNumber === 3 && wireType === WIRE_TYPE.VARINT) out.operandExpressionIndex = r.readInt32();
    else if (fieldNumber === 4 && wireType === WIRE_TYPE.VARINT) out.stringTableIndex = r.readInt32();
    else if (fieldNumber === 5 && wireType === WIRE_TYPE.VARINT) out.repeatable = r.readBool();
    else if (fieldNumber === 6 && wireType === WIRE_TYPE.VARINT) out.type = r.readInt32();
    else r.skip(wireType);
  }
  return out;
}

/**
 * Decodes a Protobuf `.BinExport` v2 `Uint8Array` (or `ArrayBuffer`) back into a
 * structured JS object with BigInt 64-bit addresses.
 */
export function decodeBinExport2(input) {
  const bytes = input instanceof Uint8Array
    ? input
    : (input instanceof ArrayBuffer ? new Uint8Array(input) : null);
  if (!bytes) {
    throw new TypeError('decodeBinExport2 requires a Uint8Array or ArrayBuffer');
  }
  if (bytes.byteLength > MAX_BINEXPORT2_BYTES) {
    throw new RangeError(`BinExport2 input exceeds max size (${MAX_BINEXPORT2_BYTES} bytes)`);
  }

  const r = new ProtoReader(bytes);
  const out = {
    metaInformation: null,
    expression: [],
    operand: [],
    mnemonic: [],
    instruction: [],
    basicBlock: [],
    flowGraph: [],
    callGraph: null,
    stringTable: [],
    section: [],
    library: [],
    dataReference: [],
    module: [],
    comment: [],
    mdIndex: [],
  };

  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === BINEXPORT2_FIELDS.META_INFORMATION && wireType === WIRE_TYPE.LEN) {
      out.metaInformation = decodeMeta(r.readSubReader());
    } else if (fieldNumber === BINEXPORT2_FIELDS.EXPRESSION && wireType === WIRE_TYPE.LEN) {
      out.expression.push(decodeExpression(r.readSubReader()));
    } else if (fieldNumber === BINEXPORT2_FIELDS.OPERAND && wireType === WIRE_TYPE.LEN) {
      out.operand.push(decodeOperand(r.readSubReader()));
    } else if (fieldNumber === BINEXPORT2_FIELDS.MNEMONIC && wireType === WIRE_TYPE.LEN) {
      out.mnemonic.push(decodeMnemonic(r.readSubReader()));
    } else if (fieldNumber === BINEXPORT2_FIELDS.INSTRUCTION && wireType === WIRE_TYPE.LEN) {
      out.instruction.push(decodeInstruction(r.readSubReader()));
    } else if (fieldNumber === BINEXPORT2_FIELDS.BASIC_BLOCK && wireType === WIRE_TYPE.LEN) {
      out.basicBlock.push(decodeBasicBlock(r.readSubReader()));
    } else if (fieldNumber === BINEXPORT2_FIELDS.FLOW_GRAPH && wireType === WIRE_TYPE.LEN) {
      out.flowGraph.push(decodeFlowGraph(r.readSubReader()));
    } else if (fieldNumber === BINEXPORT2_FIELDS.CALL_GRAPH && wireType === WIRE_TYPE.LEN) {
      out.callGraph = decodeCallGraph(r.readSubReader());
    } else if (fieldNumber === BINEXPORT2_FIELDS.STRING_TABLE && wireType === WIRE_TYPE.LEN) {
      out.stringTable.push(r.readString());
    } else if (fieldNumber === BINEXPORT2_FIELDS.SECTION && wireType === WIRE_TYPE.LEN) {
      out.section.push(decodeSection(r.readSubReader()));
    } else if (fieldNumber === BINEXPORT2_FIELDS.LIBRARY && wireType === WIRE_TYPE.LEN) {
      out.library.push(decodeLibrary(r.readSubReader()));
    } else if (fieldNumber === BINEXPORT2_FIELDS.DATA_REFERENCE && wireType === WIRE_TYPE.LEN) {
      out.dataReference.push(decodeDataReference(r.readSubReader()));
    } else if (fieldNumber === BINEXPORT2_FIELDS.MODULE && wireType === WIRE_TYPE.LEN) {
      const sub = r.readSubReader();
      let name = '';
      while (!sub.eof()) {
        const t = sub.readTag();
        if (t.fieldNumber === 1 && t.wireType === WIRE_TYPE.LEN) name = sub.readString();
        else sub.skip(t.wireType);
      }
      out.module.push({ name });
    } else if (fieldNumber === BINEXPORT2_FIELDS.COMMENT && wireType === WIRE_TYPE.LEN) {
      out.comment.push(decodeComment(r.readSubReader()));
    } else if (fieldNumber === BINEXPORT2_FIELDS.MD_INDEX && wireType === WIRE_TYPE.LEN) {
      const sub = r.readSubReader();
      const md = {};
      while (!sub.eof()) {
        const t = sub.readTag();
        if (t.fieldNumber === 1 && t.wireType === WIRE_TYPE.VARINT) md.address = sub.readUint64();
        else if (t.fieldNumber === 2 && t.wireType === WIRE_TYPE.FIXED64) md.mdIndex = sub.readDouble();
        else sub.skip(t.wireType);
      }
      out.mdIndex.push(md);
    } else {
      r.skip(wireType);
    }
  }

  return out;
}
