import assert from 'node:assert/strict';
import { CodeViewer } from '../js/viewer.js';
import { parseELF } from '../js/binary/elf-core.js';

// Issue #5019: CodeViewer converted the global row identity of fixed-width
// regions to Number. Past 2^53 rows the address->row->address round trip
// silently drops a row, so goToAddress() lands on a different instruction.
// Canonical row/address identity must stay BigInt-exact; only the bounded DOM
// scroll window may use Number.

const MAX_SAFE_ROW = BigInt(Number.MAX_SAFE_INTEGER);
const rowExact = 9007199254740993n; // 2^53 + 1
const regionSize = 4n * 9007199255000000n; // past the 2^53-row boundary with headroom
const target = rowExact * 4n; // 36028797018963972

const identity = (rowBig) => rowBig <= MAX_SAFE_ROW ? Number(rowBig) : rowBig;

function classList() { return { toggle() {}, add() {}, remove() {}, contains() { return false; } }; }
function viewport() { return { clientHeight: 240, scrollTop: 0, classList: classList(), addEventListener() {}, removeEventListener() {} }; }
function rows() { return { style: {}, appendChild() {} }; }
function root() { return { classList: classList(), style: { setProperty() {} } }; }
globalThis.__HEX_UI_ROOT__ = root();
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

function hugeViewer(mode = 'asm', region = {
  id: 'huge-exec',
  vmAddr: 0n,
  size: regionSize,
  disasm: true,
  capability: { architecture: 'arm64', fixedInstructionSize: 4, capabilities: { decode: 'exact' } },
}) {
  const viewer = new CodeViewer({
    viewport: viewport(),
    rows: rows(),
    backend: {
      platformInfo: { capability: { architecture: 'arm64', fixedInstructionSize: 4, capabilities: { decode: 'exact' } } },
      legacyInfo: null,
      peek() { return null; },
      request() {},
      disassembleAt() { throw new Error('fixed-width viewer must not call the variable decoder'); },
    },
  });
  viewer.setRegion(region);
  if (mode !== 'asm') viewer.setMode(mode);
  return viewer;
}

{
  // Acceptance 1/5: global row identity past 2^53 is lossless and exact.
  const viewer = hugeViewer();
  assert.equal(viewer.totalRowsBig, regionSize / 4n);
  assert.ok(Number.isSafeInteger(viewer.totalRows) && viewer.totalRows >= 1);
  assert.ok(Number.isSafeInteger(viewer.windowRows) && viewer.windowRows >= 1);
  for (const row of [MAX_SAFE_ROW - 2n, MAX_SAFE_ROW - 1n, MAX_SAFE_ROW, MAX_SAFE_ROW + 1n, rowExact]) {
    const address = row * 4n;
    assert.equal(viewer.rowOfAddress(address), identity(row), `rowOfAddress must not round row ${row}`);
    assert.equal(viewer.rowAddress(row), address, 'rowAddress stays exact BigInt');
    assert.equal(viewer.rowAddress(viewer.rowOfAddress(address)), address, 'address->row->address round trip must be exact');
  }
  assert.equal(viewer.rowOfAddress(regionSize), null);
  viewer.dispose();
}

{
  // Acceptance 2: goToAddress() navigates the exact row, not 4 bytes short.
  const viewer = hugeViewer();
  assert.equal(viewer.goToAddress(target), true);
  const row = viewer.rowOfAddress(target);
  assert.equal(row, identity(rowExact));
  assert.equal(viewer.rowAddress(row), target);
  assert.equal(viewer.topRow(), identity(rowExact - 3n), 'third-placement keeps the target exactly three rows below the top');
  assert.equal(viewer.topAddress(), target - 12n);
  assert.equal(viewer.rowAddress(viewer.topRow()), target - 12n);
  viewer.select(row, false);
  assert.equal(viewer.selectedRow, row);
  assert.equal(viewer.rowAddress(viewer.selectedRow), target, 'selection identity is exact');
  assert.equal(viewer.rowData(row).address, target);
  assert.equal(viewer.rowData(row - 1n).address, target - 4n);
  assert.equal(viewer.rowData(row + 1n).address, target + 4n);
  assert.equal(viewer.rowData(viewer.totalRowsBig), null);
  viewer.dispose();
}

{
  // Acceptance 3: hex/asm anchor restoration keeps the same address.
  const viewer = hugeViewer();
  assert.equal(viewer.goToAddress(target), true);
  const asmTop = viewer.topAddress();
  assert.equal(asmTop, target - 12n);
  viewer.setMode('hex');
  assert.equal(viewer.mode, 'hex');
  assert.equal(viewer.totalRowsBig, regionSize / 4n);
  assert.equal(viewer.topAddress(), asmTop, 'hex anchor restore must not land 4 bytes short');
  assert.equal(viewer.rowAddress(viewer.topRow()), asmTop);
  assert.equal(viewer.rowOfAddress(asmTop), viewer.topRow());
  viewer.setMode('asm');
  const restored = viewer.topAddress();
  assert.equal(restored % 4n, 0n);
  assert.equal(viewer.rowAddress(viewer.rowOfAddress(restored)), restored, 'asm anchor round trip stays exact');
  assert.ok(asmTop - restored === 12n || restored === asmTop, 'anchor may only shift by the placement lead, never by a rounding row');
  viewer.dispose();
}

{
  // hex mode past 2^53 rows uses the same BigInt identity.
  const viewer = hugeViewer('hex');
  assert.equal(viewer.mode, 'hex');
  assert.equal(viewer.totalRowsBig, regionSize / 4n);
  assert.equal(viewer.rowOfAddress(target), identity(rowExact));
  assert.equal(viewer.goToAddress(target), true);
  assert.equal(viewer.topAddress(), target - 12n);
  assert.equal(viewer.rowAddress(viewer.topRow()), target - 12n);
  viewer.dispose();
}

{
  // Acceptance 4: sub-2^53 virtualization behavior is unchanged.
  const viewer = new CodeViewer({
    viewport: viewport(),
    rows: rows(),
    backend: {
      platformInfo: { capability: { architecture: 'arm64', fixedInstructionSize: 4, capabilities: { decode: 'exact' } } },
      legacyInfo: null,
      peek() { return null; },
      request() {},
      disassembleAt() { throw new Error('fixed-width viewer must not call the variable decoder'); },
    },
  });
  viewer.setRegion({ id: 'small', vmAddr: 0x1000n, size: 0x400n, disasm: true, capability: { architecture: 'arm64', fixedInstructionSize: 4, capabilities: { decode: 'exact' } } });
  assert.equal(viewer.totalRowsBig, 256n);
  assert.equal(viewer.totalRows, 256);
  assert.equal(viewer.rowOfAddress(0x1183n), null);
  assert.equal(viewer.rowOfAddress(0x1180n), 96);
  assert.equal(typeof viewer.rowOfAddress(0x1180n), 'number', 'safe rows stay plain Numbers');
  assert.equal(viewer.rowAddress(96), 0x1180n);
  assert.equal(viewer.goToAddress(0x1180n), true);
  assert.equal(viewer.rowAddress(viewer.topRow()), 0x1174n);
  viewer.dispose();
}

// Acceptance 6: a production-shaped ELF64 with p_filesz=0 and a >2^53-row
// p_memsz survives the canonical loader and drives the same viewer identity.
function buildElf64HugeExec() {
  const b = new Uint8Array(120);
  const dv = new DataView(b.buffer);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  dv.setUint16(16, 2, true); // ET_EXEC
  dv.setUint16(18, 183, true); // EM_AARCH64
  dv.setUint32(20, 1, true);
  dv.setBigUint64(24, 0n, true); // e_entry
  dv.setBigUint64(32, 64n, true); // e_phoff
  dv.setBigUint64(40, 0n, true); // e_shoff
  dv.setUint32(48, 0, true);
  dv.setUint16(52, 64, true); // e_ehsize
  dv.setUint16(54, 56, true); // e_phentsize
  dv.setUint16(56, 1, true); // e_phnum
  dv.setUint16(58, 64, true); // e_shentsize
  dv.setUint16(60, 0, true); // e_shnum
  dv.setUint16(62, 0, true); // e_shstrndx
  dv.setUint32(64, 1, true); // PT_LOAD
  dv.setUint32(68, 5, true); // PF_R|PF_X
  dv.setBigUint64(72, 0n, true); // p_offset
  dv.setBigUint64(80, 0n, true); // p_vaddr
  dv.setBigUint64(88, 0n, true); // p_paddr
  dv.setBigUint64(96, 0n, true); // p_filesz
  dv.setBigUint64(104, regionSize, true); // p_memsz = 4 * (2^53 + 2)
  dv.setBigUint64(112, 0x10000n, true); // p_align
  return b;
}

{
  const image = parseELF(buildElf64HugeExec());
  const segment = image.segments.find((s) => s.source === 'PT_LOAD');
  assert.ok(segment, 'the canonical loader keeps the huge-extent PT_LOAD');
  assert.equal(segment.size, regionSize, 'p_memsz must survive as an exact 64-bit BigInt');
  assert.equal(segment.fileSize, 0n);
  const viewer = hugeViewer('asm', {
    id: segment.name,
    vmAddr: segment.address,
    size: segment.size,
    disasm: true,
    capability: { architecture: 'arm64', fixedInstructionSize: 4, capabilities: { decode: 'exact' } },
  });
  assert.equal(viewer.goToAddress(target), true);
  assert.equal(viewer.rowAddress(viewer.rowOfAddress(target)), target, 'ELF64-driven region must navigate the exact instruction address');
  assert.equal(viewer.topAddress(), target - 12n);
  viewer.dispose();
}

{
  // Acceptance 7: a maximum-shaped virtual extent degrades to bounded
  // coordinates instead of hanging or producing Infinity.
  const huge = 1n << 63n;
  const viewer = hugeViewer('asm', {
    id: 'u64-extent',
    vmAddr: 0n,
    size: huge,
    disasm: true,
    capability: { architecture: 'arm64', fixedInstructionSize: 4, capabilities: { decode: 'exact' } },
  });
  assert.ok(Number.isFinite(viewer.totalRows) && viewer.totalRows > 0);
  assert.ok(Number.isFinite(viewer.windowRows) && viewer.windowRows >= 1);
  assert.equal(viewer.rowAddress(viewer.rowOfAddress(huge - 4n)), huge - 4n);
  assert.equal(viewer.goToAddress(huge - 4n), true);
  assert.equal(typeof viewer.topRow(), 'bigint');
  assert.equal(viewer.rowAddress(viewer.topRow()), viewer.topAddress());
  assert.equal((huge - 4n - viewer.topAddress()) % 4n, 0n, 'the placed top must stay exactly row-aligned at the region end');
  assert.ok(huge - 4n - viewer.topAddress() < BigInt(viewer.windowRows) * 4n);
  assert.ok(Number.isFinite(viewer.vp.scrollTop));
  viewer.dispose();
}

console.log('Issue #5019 viewer BigInt row identity regression passed');
