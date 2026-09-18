// Regression for #3992: the conformance descriptor WitnessTablePattern field
// carries the witness-table representation kind in its low 2 bits. Accessor
// kinds must be decoded (tag removed, never promoted to a concrete table)
// and the reserved kind fails closed.
import assert from 'node:assert/strict';
import { parseSwiftConformanceDescriptor, buildSwiftMetadataModel } from '../js/swift.js';

const mem = new Map();
const put = (addr, bytes) => { for (let i = 0; i < bytes.length; i++) mem.set(Number(addr) + i, bytes[i]); };
const u32 = (v) => Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
const i32 = (v) => u32(v >>> 0);
const u64 = (v) => { let x = BigInt(v), b = new Uint8Array(8); for (let i = 0; i < 8; i++) { b[i] = Number(x & 255n); x >>= 8n; } return b; };
const rel32 = (field, target) => i32(Number(BigInt(target) - BigInt(field)));
const cstr = (s) => new TextEncoder().encode(s + '\0');
const read = async (addr, len) => { const out = new Uint8Array(len); for (let i = 0; i < len; i++) { const v = mem.get(Number(addr) + i); if (v == null) return i ? out.subarray(0, i) : null; out[i] = v; } return out; };
const write32 = (a, v) => put(a, u32(v));
const writeRel = (field, target) => put(field, rel32(field, target));

const CONF = 0x1000n, WITNESS_FIELD = CONF + 8n;
const PROTO_REF = 0x1200n, TYPE_REF = 0x1300n;
put(CONF, new Uint8Array(16));

function setWitnessField(raw) { put(WITNESS_FIELD, i32(raw)); }

// kind 0 direct table, positive offset.
const DIRECT = 0x5000n;
writeRel(CONF, PROTO_REF); writeRel(CONF + 4n, TYPE_REF);
setWitnessField(Number(BigInt(DIRECT) - WITNESS_FIELD));
write32(CONF + 12n, 0);
let c = await parseSwiftConformanceDescriptor(read, CONF);
assert.equal(c.witnessTable, DIRECT, 'kind 0 positive keeps its exact table address');
assert.equal(c.witnessTableKind, 0);

// kind 0 direct table, negative offset.
const NEG_DIRECT = 0x0900n;
setWitnessField(Number(BigInt(NEG_DIRECT) - WITNESS_FIELD));
c = await parseSwiftConformanceDescriptor(read, CONF);
assert.equal(c.witnessTable, NEG_DIRECT, 'kind 0 negative keeps its exact table address');

// kind 1 unconditional accessor: low bit is the tag, not address distance.
const ACCESSOR = 0x2000n;
setWitnessField(Number(BigInt(ACCESSOR) - WITNESS_FIELD) | 1);
c = await parseSwiftConformanceDescriptor(read, CONF);
assert.equal(c.witnessTableKind, 1, 'unconditional accessor kind decoded');
assert.equal(c.witnessTable, null, 'accessor must not surface as a concrete witness table');
assert.equal(c.witnessTableAccessor, ACCESSOR, 'accessor address keeps its exact tag-stripped target');

// kind 2 conditional accessor with a negative base offset.
const NEG_ACCESSOR = 0x0800n;
setWitnessField(Number(BigInt(NEG_ACCESSOR) - WITNESS_FIELD) | 2);
c = await parseSwiftConformanceDescriptor(read, CONF);
assert.equal(c.witnessTableKind, 2, 'conditional accessor kind decoded');
assert.equal(c.witnessTable, null);
assert.equal(c.witnessTableAccessor, NEG_ACCESSOR, 'tag must not shift a negative accessor target');

// kind 3 reserved: fail closed, no witness target at all.
setWitnessField(Number(BigInt(ACCESSOR) - WITNESS_FIELD) | 3);
c = await parseSwiftConformanceDescriptor(read, CONF);
assert.equal(c.witnessTableKind, 3, 'reserved kind decoded');
assert.equal(c.witnessTable, null);
assert.equal(c.witnessTableAccessor, null, 'reserved kind must not expose any target');

// Model gate: an accessor conformance must never project code bytes as entries.
const TYPE_SEC = 0x3000n, PROTO_SEC = 0x3100n, CONF_SEC = 0x3200n;
const TYPE = 0x4000n, TYPE_NAME = 0x4100n, PROTO = 0x4200n, PROTO_NAME = 0x4300n;
const CONF2 = 0x4400n, ACCESSOR_FN = 0x6000n;
put(TYPE, new Uint8Array(28)); put(PROTO, new Uint8Array(32)); put(CONF2, new Uint8Array(16));
put(ACCESSOR_FN, new Uint8Array(32));
writeRel(TYPE_SEC, TYPE); writeRel(PROTO_SEC, PROTO); writeRel(CONF_SEC, CONF2);
write32(TYPE, 17); writeRel(TYPE + 8n, TYPE_NAME); put(TYPE_NAME, cstr('T'));
write32(PROTO, 3); writeRel(PROTO + 8n, PROTO_NAME); put(PROTO_NAME, cstr('P'));
write32(PROTO + 16n, 1); write32(PROTO + 24n, 1);
writeRel(CONF2, PROTO); writeRel(CONF2 + 4n, TYPE);
put(CONF2 + 8n, i32(Number(BigInt(ACCESSOR_FN) - (CONF2 + 8n)) | 1));
write32(CONF2 + 12n, 0);
const sections = [
  { section: '__swift5_types', vmAddr: TYPE_SEC, size: 4 },
  { section: '__swift5_protos', vmAddr: PROTO_SEC, size: 4 },
  { section: '__swift5_proto', vmAddr: CONF_SEC, size: 4 },
];
const opts = { budget: 128, resolvePointer: async (raw) => raw };
const model = await buildSwiftMetadataModel(read, sections, opts);
assert.equal(model.conformances[0].witnessTableKind, 1);
assert.equal(model.witnessTables.length, 0, 'accessor representation must not be parsed as a witness table');
assert.equal(model.witnessTablesComplete ?? model.completeness.witnessTables.complete, false,
  'unprojectable accessor conformance must be reported incomplete');
assert.ok(model.warnings.some((w) => String(w).includes(String(CONF2))), 'accessor gate records a warning');

// kind 0 regression: the concrete-table projection path is untouched.
put(CONF2 + 8n, i32(Number(0x7000n - (CONF2 + 8n))));
const WIT = 0x7000n, IMPL = 0x8000n;
put(WIT, new Uint8Array(16)); put(WIT, u64(CONF2)); put(WIT + 8n, u64(IMPL));
const directModel = await buildSwiftMetadataModel(read, sections, opts);
assert.equal(directModel.conformances[0].witnessTableKind, 0);
assert.equal(directModel.witnessTables.length, 1);
assert.equal(directModel.witnessTables[0].source, 'conformance');
assert.equal(directModel.witnessTables[0].entries[0].target, IMPL);
assert.equal(directModel.complete, true);

console.log('issue #3992 swift witness table representation: PASS');
