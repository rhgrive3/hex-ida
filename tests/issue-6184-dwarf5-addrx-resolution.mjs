/**
 * #6184 regression: DWARF5 DW_FORM_addrx / addrx1..4 are zero-based indices
 * into the unit's `.debug_addr` address array (anchored at DW_AT_addr_base),
 * not addresses themselves. Previously the raw index was kept as the value and
 * `symbols()` published `0x0`, `0x1`, ... as the function address.
 */
import assert from 'node:assert/strict';
import { parseDebugInfo, DwarfDebugInfoProvider } from '../js/analysis/debug/dwarf.js';

const DW_TAG_compile_unit = 0x11;
const DW_TAG_subprogram = 0x2e;
const DW_AT_name = 0x03;
const DW_AT_low_pc = 0x11;
const DW_AT_high_pc = 0x12;
const DW_AT_addr_base = 0x73;
const DW_FORM_string = 0x08;
const DW_FORM_addr = 0x01;
const DW_FORM_sec_offset = 0x17;
const DW_FORM_data4 = 0x06;

const ADDRESS = 0x12345678n;

/** `.debug_addr`: DWARF32/64 contribution header plus address entries. */
function debugAddrSection(entries, {
  addressSize = 4,
  dwarf64 = false,
  version = 5,
  segmentSelectorSize = 0,
  segmentSelector = 0n,
} = {}) {
  const body = [];
  for (const entry of entries) {
    for (let i = 0; i < segmentSelectorSize; i += 1) {
      body.push(Number((segmentSelector >> BigInt(8 * i)) & 0xffn));
    }
    for (let i = 0; i < addressSize; i += 1) body.push(Number((entry >> BigInt(8 * i)) & 0xffn));
  }
  const length = body.length + 2 + 1 + 1;
  const bytes = [];
  if (dwarf64) bytes.push(0xff, 0xff, 0xff, 0xff, length & 0xff, (length >>> 8) & 0xff, (length >>> 16) & 0xff, (length >>> 24) & 0xff, 0, 0, 0, 0);
  else bytes.push(length & 0xff, (length >>> 8) & 0xff, (length >>> 16) & 0xff, (length >>> 24) & 0xff);
  bytes.push(
    version & 0xff, (version >>> 8) & 0xff,
    addressSize, segmentSelectorSize,
    ...body,
  );
  return Uint8Array.from(bytes);
}

/** One CU whose subprogram DIE uses `form` for DW_AT_low_pc with raw value `rawIndex`. */
function buildUnit({ form, raw, addrBase = 8, version = 5, dwarf64 = false, addressSize = 4 }) {
  const cuName = 't.c';
  const fnName = 'fn';
  const hasAddrBase = addrBase != null;
  const abbrev = Uint8Array.from([
    0x01, DW_TAG_compile_unit, 0x00,
    DW_AT_name, DW_FORM_string,
    ...(hasAddrBase ? [DW_AT_addr_base, DW_FORM_sec_offset] : []),
    0x00, 0x00,
    0x02, DW_TAG_subprogram, 0x00,
    DW_AT_name, DW_FORM_string,
    DW_AT_low_pc, form,
    0x00, 0x00,
    0x00,
  ]);
  const die = [
    0x01,
    ...Buffer.from(cuName), 0,
    ...(hasAddrBase
      ? dwarf64
        ? [addrBase & 0xff, (addrBase >>> 8) & 0xff, (addrBase >>> 16) & 0xff, (addrBase >>> 24) & 0xff, 0, 0, 0, 0]
        : [addrBase & 0xff, (addrBase >>> 8) & 0xff, (addrBase >>> 16) & 0xff, (addrBase >>> 24) & 0xff]
      : []),
    0x02,
    ...Buffer.from(fnName), 0,
  ];
  const payload = [];
  const pushU16 = (v) => payload.push(v & 0xff, (v >>> 8) & 0xff);
  const pushWidth = (v) => {
    const wide = BigInt(v);
    if (dwarf64) for (let i = 0; i < 8; i += 1) payload.push(Number((wide >> BigInt(8 * i)) & 0xffn));
    else payload.push(Number(wide & 0xffn), Number((wide >> 8n) & 0xffn), Number((wide >> 16n) & 0xffn), Number((wide >> 24n) & 0xffn));
  };
  pushU16(version);
  if (version >= 5) {
    payload.push(0x01, addressSize); // DW_UT_compile, address_size
    pushWidth(0);                    // abbrev_offset
  } else {
    pushWidth(0);                    // abbrev_offset (DWARF2-4: before address_size)
    payload.push(addressSize);
  }
  payload.push(...die, ...(Array.isArray(raw) ? raw : [raw]));

  const info = [];
  const bodyLength = payload.length;
  if (dwarf64) {
    info.push(0xff, 0xff, 0xff, 0xff, bodyLength & 0xff, (bodyLength >>> 8) & 0xff, (bodyLength >>> 16) & 0xff, (bodyLength >>> 24) & 0xff, 0, 0, 0, 0);
  } else {
    info.push(bodyLength & 0xff, (bodyLength >>> 8) & 0xff, (bodyLength >>> 16) & 0xff, (bodyLength >>> 24) & 0xff);
  }
  info.push(...payload);
  return { debug_info: Uint8Array.from(info), debug_abbrev: abbrev };
}

function addrBaseFor(dwarf64) { return dwarf64 ? 16 : 8; }

function parseWith(form, raw, { tableEntries = [ADDRESS], addrBase, dwarf64 = false, withTable = true } = {}) {
  const unit = buildUnit({ form, raw, addrBase: addrBase === undefined ? addrBaseFor(dwarf64) : addrBase, dwarf64 });
  return parseDebugInfo({
    ...unit,
    debug_addr: withTable ? debugAddrSection(tableEntries, { dwarf64 }) : null,
  });
}

// 1. Acceptance: addrx1(0) with .debug_addr[0] = 0x12345678 resolves the address.
{
  const parsed = parseWith(0x29, 0);
  assert.equal(parsed.complete, true);
  const subprogram = [...parsed.dies.values()].find((die) => die.tag === DW_TAG_subprogram);
  const lowPc = subprogram.attributes.get(DW_AT_low_pc);
  assert.equal(lowPc.value, ADDRESS);
}

// 2. addrx1..4 and addrx (uleb) all share the same address-class semantics.
for (const [form, encoded] of [
  [0x1b, [0x01]],            // addrx, uleb(1)
  [0x29, [0x01]],            // addrx1
  [0x2a, [0x01, 0x00]],      // addrx2
  [0x2b, [0x01, 0x00, 0x00]],// addrx3
  [0x2c, [0x01, 0x00, 0x00, 0x00]], // addrx4
]) {
  const parsed = parseWith(form, encoded, { tableEntries: [0n, ADDRESS] });
  const subprogram = [...parsed.dies.values()].find((die) => die.tag === DW_TAG_subprogram);
  assert.equal(subprogram.attributes.get(DW_AT_low_pc).value, ADDRESS, `form 0x${form.toString(16)}`);
}

// 3. DW_AT_addr_base is honored: the entry is selected relative to the base.
{
  const table = debugAddrSection([0xdeadbeefn, ADDRESS]);
  const parsed = parseDebugInfo({
    ...buildUnit({ form: 0x2c, raw: [0x01, 0x00, 0x00, 0x00], addrBase: addrBaseFor(false) }),
    debug_addr: table,
  });
  const subprogram = [...parsed.dies.values()].find((die) => die.tag === DW_TAG_subprogram);
  assert.equal(subprogram.attributes.get(DW_AT_low_pc).value, ADDRESS);
}

// 4. Out-of-range index: raw index must not become an address; DIE is partial.
{
  const parsed = parseWith(0x29, 7, { tableEntries: [ADDRESS] });
  assert.equal(parsed.complete, false);
  assert.ok(parsed.diagnostics.some((d) => /addrx/.test(d)));
  const subprogram = [...parsed.dies.values()].find((die) => die.tag === DW_TAG_subprogram);
  assert.equal(subprogram.attributes.get(DW_AT_low_pc).value, null);
  assert.equal(subprogram.complete, false);
}

// 5. Truncated table (entry crosses the section end) fails closed the same way.
{
  const table = debugAddrSection([ADDRESS]);
  const truncated = table.subarray(0, table.length - 1);
  const parsed = parseDebugInfo({ ...buildUnit({ form: 0x2c, raw: [0, 0, 0, 0] }), debug_addr: truncated });
  const subprogram = [...parsed.dies.values()].find((die) => die.tag === DW_TAG_subprogram);
  assert.equal(subprogram.attributes.get(DW_AT_low_pc).value, null);
  assert.equal(subprogram.complete, false);
}

// 6. Missing DW_AT_addr_base: addrx cannot resolve, fails closed.
{
  const parsed = parseDebugInfo({
    ...buildUnit({ form: 0x2c, raw: [0, 0, 0, 0], addrBase: null }),
    debug_addr: debugAddrSection([ADDRESS]),
  });
  const subprogram = [...parsed.dies.values()].find((die) => die.tag === DW_TAG_subprogram);
  assert.equal(subprogram.attributes.get(DW_AT_low_pc).value, null);
  assert.equal(subprogram.complete, false);
}

// 7. DWARF64 layout: 12-byte initial length + 8-byte addr_base offset.
{
  const parsed = parseWith(0x29, 0, { dwarf64: true, tableEntries: [ADDRESS] });
  const subprogram = [...parsed.dies.values()].find((die) => die.tag === DW_TAG_subprogram);
  assert.equal(subprogram.attributes.get(DW_AT_low_pc).value, ADDRESS);
}

// 8. Direct DW_FORM_addr keeps its existing behavior (no table involvement).
{
  const parsed = parseDebugInfo({
    ...buildUnit({ form: 0x01, raw: [0x78, 0x56, 0x34, 0x12] }),
    debug_addr: null,
  });
  const subprogram = [...parsed.dies.values()].find((die) => die.tag === DW_TAG_subprogram);
  assert.equal(subprogram.attributes.get(DW_AT_low_pc).value, ADDRESS);
  assert.equal(parsed.complete, true);
}

// 9. Provider symbols(): the resolved address, never the raw index.
{
  const provider = new DwarfDebugInfoProvider();
  const { debug_info, debug_abbrev } = buildUnit({ form: 0x2c, raw: [0, 0, 0, 0] });
  const image = {
    snapshotId: 'snap',
    identity: {},
    debugSections: {
      debug_info,
      debug_abbrev,
      debug_addr: debugAddrSection([ADDRESS]),
    },
  };
  const result = provider.probe(image);
  const records = provider.symbols(result, {}).records;
  const fn = records.find((r) => r.descriptor.isFunction);
  assert.equal(fn.address, '0x12345678');
  assert.equal(result.status.completeness, 'complete');
}

// 10. Provider symbols(): unresolved addrx is partial and exposes no address.
{
  const provider = new DwarfDebugInfoProvider();
  const { debug_info, debug_abbrev } = buildUnit({ form: 0x2c, raw: [5, 0, 0, 0] });
  const image = {
    snapshotId: 'snap',
    identity: {},
    debugSections: {
      debug_info,
      debug_abbrev,
      debug_addr: debugAddrSection([ADDRESS]),
    },
  };
  const result = provider.probe(image);
  const records = provider.symbols(result, {}).records;
  const fn = records.find((r) => r.descriptor.isFunction);
  assert.equal(fn.address, null);
  assert.equal(fn.descriptor.complete, false);
  assert.equal(result.status.completeness, 'partial');
}

// 11. DWARF4 unit with a constant-class low_pc is unaffected (no regression).
{
  const parsed = parseDebugInfo({
    ...buildUnit({ form: DW_FORM_data4, raw: [0x78, 0x56, 0x34, 0x12], version: 4 }),
    debug_addr: debugAddrSection([0n]),
  });
  const subprogram = [...parsed.dies.values()].find((die) => die.tag === DW_TAG_subprogram);
  assert.equal(subprogram.attributes.get(DW_AT_low_pc).value, ADDRESS);
  assert.equal(parsed.complete, true);
}

function assertAddrxRejected(debugAddr, { addrBase = 8 } = {}) {
  const parsed = parseDebugInfo({
    ...buildUnit({ form: 0x29, raw: 0, addrBase }),
    debug_addr: debugAddr,
  });
  assert.equal(parsed.complete, false);
  assert.ok(parsed.diagnostics.some((d) => /unresolved DW_FORM_addrx/.test(d)));
  const subprogram = [...parsed.dies.values()].find((die) => die.tag === DW_TAG_subprogram);
  assert.equal(subprogram.attributes.get(DW_AT_low_pc).value, null);
  assert.equal(subprogram.complete, false);
}

// 12. A non-zero segment selector changes the entry stride; unsupported segmented
// addresses must stay partial instead of publishing segment bytes as a PC.
{
  const table = debugAddrSection([0x89abcdefn], {
    segmentSelectorSize: 2,
    segmentSelector: 0x1234n,
  });
  assertAddrxRejected(table);
}

// 13. The contribution's address_size is authoritative and must match the CU.
{
  assertAddrxRejected(debugAddrSection([ADDRESS], { addressSize: 8 }));
}

// 14. addrx is a DWARF5 contribution contract; another header version is unknown.
{
  assertAddrxRejected(debugAddrSection([ADDRESS], { version: 4 }));
}

// 15. DW_AT_addr_base must name the first entry area, never contribution header bytes.
{
  assertAddrxRejected(debugAddrSection([ADDRESS]), { addrBase: 4 });
}

// 16. Nor may addr_base point into the middle of the address array/body.
{
  assertAddrxRejected(debugAddrSection([ADDRESS, 0x89abcdefn]), { addrBase: 9 });
}

console.log('issue #6184 DWARF5 addrx resolution: PASS');
