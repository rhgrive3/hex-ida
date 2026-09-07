// Issue #5746 (and #5744) regression: parseModuleInfo() must report whether it
// scanned the DBI module substream completely. A malformed/truncated substream
// that silently stopped the scan used to be indistinguishable from a valid
// empty module list, letting the PDB provider publish "complete" evidence with
// missing per-module procedure symbols.
import assert from 'node:assert/strict';
import { parseModuleInfo } from '../../../js/analysis/debug/pdb.js';

const DBI_HEADER_SIZE = 64;

function dbiFixture({ moduleSubstreamSize, fill, tailNulCount = 0 }) {
  const bytes = new Uint8Array(DBI_HEADER_SIZE + moduleSubstreamSize + 64);
  const view = new DataView(bytes.buffer);
  const dbi = { moduleSubstreamSize };
  if (fill === 'prefix-no-name-nul') {
    // One valid 64-byte module prefix at the substream start; after it, the
    // module name has no NUL before the substream end (malformed cstring).
    view.setInt16(DBI_HEADER_SIZE + 34, 5, true);
    view.setUint32(DBI_HEADER_SIZE + 36, 64, true);
    bytes.set(new TextEncoder().encode('mod'), DBI_HEADER_SIZE + 64);
    // remaining substream bytes are zero already (no NUL-terminated name end
    // is impossible since zeros ARE NULs; so instead fill with 0x41 'A').
    for (let i = DBI_HEADER_SIZE + 67; i < DBI_HEADER_SIZE + moduleSubstreamSize; i++) bytes[i] = 0x41;
    // put a terminator only after the declared substream end (outside it)
    bytes[DBI_HEADER_SIZE + moduleSubstreamSize] = 0;
  } else if (fill === 'trailing-garbage') {
    // A fully valid module entry, then 4+ bytes of garbage that is not a valid
    // next module prefix (shorter than 64 bytes remain -> loop cannot continue
    // but substream has residue).
    view.setInt16(DBI_HEADER_SIZE + 34, 5, true);
    view.setUint32(DBI_HEADER_SIZE + 36, 32, true);
    bytes.set(new TextEncoder().encode('mod\0obj\0'), DBI_HEADER_SIZE + 64);
    for (let i = DBI_HEADER_SIZE + 76; i < DBI_HEADER_SIZE + moduleSubstreamSize; i++) bytes[i] = 0x7f;
  } else if (fill === 'clean') {
    view.setInt16(DBI_HEADER_SIZE + 34, 5, true);
    view.setUint32(DBI_HEADER_SIZE + 36, 32, true);
    bytes.set(new TextEncoder().encode('mod\0obj\0'), DBI_HEADER_SIZE + 64);
  }
  return { bytes, dbi };
}

// 1. Un-terminated module name inside the declared substream: scan reports
//    incomplete, module dropped rather than silently complete.
{
  const { bytes, dbi } = dbiFixture({ moduleSubstreamSize: 128, fill: 'prefix-no-name-nul' });
  const result = parseModuleInfo(bytes, dbi);
  assert.equal(result.complete, false, 'un-terminated module name must mark the scan incomplete');
  assert.ok(result.modules.length <= 1);
}

// 2. Trailing garbage that cannot form a module prefix: incomplete.
{
  const { bytes, dbi } = dbiFixture({ moduleSubstreamSize: 128, fill: 'trailing-garbage' });
  const result = parseModuleInfo(bytes, dbi);
  assert.equal(result.complete, false, 'unparseable substream residue must mark the scan incomplete');
  assert.equal(result.modules.length, 1, 'the valid module is still decoded');
}

// 3. A clean, fully-decoded substream stays complete.
{
  const { bytes, dbi } = dbiFixture({ moduleSubstreamSize: 72, fill: 'clean' });
  const result = parseModuleInfo(bytes, dbi);
  assert.equal(result.complete, true);
  assert.equal(result.modules.length, 1);
  assert.equal(result.modules[0].moduleName, 'mod');
  assert.equal(result.modules[0].objectName, 'obj');
}

// 3b. A valid entry may consume the final 1-3 bytes as alignment padding.
{
  const bytes = new Uint8Array(DBI_HEADER_SIZE + 72);
  const view = new DataView(bytes.buffer);
  view.setInt16(DBI_HEADER_SIZE + 34, 5, true);
  view.setUint32(DBI_HEADER_SIZE + 36, 0, true);
  bytes.set(new TextEncoder().encode('m\0oo\0'), DBI_HEADER_SIZE + 64);
  const result = parseModuleInfo(bytes, { moduleSubstreamSize: 72 });
  assert.equal(result.complete, true, 'alignment padding inside the declared end is valid');
  assert.equal(result.modules.length, 1);
  assert.equal(result.modules[0].objectName, 'oo');
}

// 4. A declared substream with residue that cannot form a module prefix
//    (>= 4 unconsumed bytes) is incomplete, not a valid empty list.
{
  const bytes = new Uint8Array(DBI_HEADER_SIZE + 32);
  const result = parseModuleInfo(bytes, { moduleSubstreamSize: 32 });
  assert.equal(result.complete, false, 'declared substream bytes that parse to no module are a contradiction');
  assert.deepEqual(result.modules, []);
}

// 4b. An aligned entry whose padding would cross the declared end is
// incomplete and must not publish a module.
{
  const { bytes, dbi } = dbiFixture({ moduleSubstreamSize: 67, fill: 'clean' });
  bytes.set(new TextEncoder().encode('m\0\0'), DBI_HEADER_SIZE + 64);
  const result = parseModuleInfo(bytes, dbi);
  assert.equal(result.complete, false, 'alignment beyond the declared end is incomplete');
  assert.deepEqual(result.modules, []);
}

// 4c. A truly empty module list (no substream declared) is complete-and-empty.
{
  assert.deepEqual(parseModuleInfo(new Uint8Array(128), { moduleSubstreamSize: 0 }), { modules: [], complete: true });
}

// 5. A bytes buffer shorter than the declared substream (truncation) is incomplete.
{
  const { bytes, dbi } = dbiFixture({ moduleSubstreamSize: 128, fill: 'clean' });
  const truncated = bytes.subarray(0, DBI_HEADER_SIZE + 80);
  const result = parseModuleInfo(truncated, dbi);
  assert.equal(result.complete, false, 'declared extent beyond the buffer must be incomplete');
}

// 6. Missing bytes for a declared module substream are truncation, not a
//    complete empty list.
{
  assert.deepEqual(parseModuleInfo(null, { moduleSubstreamSize: 128 }), { modules: [], complete: false });
}

// 7. No declared module substream remains a valid empty result.
{
  assert.deepEqual(parseModuleInfo(new Uint8Array(128), { moduleSubstreamSize: 0 }), { modules: [], complete: true });
}

console.log('issue #5746/#5744 parseModuleInfo completeness regressions: PASS');

// A nonempty declared substream cannot consist solely of initial padding.
for (const moduleSubstreamSize of [1, 2, 3]) {
  const result = parseModuleInfo(new Uint8Array(DBI_HEADER_SIZE + moduleSubstreamSize), { moduleSubstreamSize });
  assert.equal(result.complete, false, 'short declared substream must be incomplete');
  assert.deepEqual(result.modules, []);
}
