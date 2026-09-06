import assert from 'node:assert/strict';
import { ByteView } from '../../js/binary/reader.js';
import { parseProgramDynamic } from '../../js/binary/elf-dynamic.js';

const DT_DEBUG = 21n;
const DT_NULL = 0n;

function image() {
  return {
    warnings: [],
    metadata: {},
    libraries: [],
    symbols: [],
    imports: [],
    exports: [],
    functions: [],
    relocations: [],
    sections: [],
    segments: [],
  };
}

function fixture(entries, bits, trailingBytes = 0) {
  const entrySize = bits === 64 ? 16 : 8;
  const bytes = new Uint8Array(entries.length * entrySize + trailingBytes);
  const view = new DataView(bytes.buffer);
  entries.forEach(([tag, value], index) => {
    const offset = index * entrySize;
    if (bits === 64) {
      view.setBigInt64(offset, tag, true);
      view.setBigUint64(offset + 8, value, true);
    } else {
      view.setInt32(offset, Number(tag), true);
      view.setUint32(offset + 4, Number(value), true);
    }
  });
  return { bytes, entrySize };
}

for (const bits of [32, 64]) {
  const label = `ELF${bits}`;
  const { bytes } = fixture([[DT_DEBUG, 0n], [DT_NULL, 0n]], bits);
  const parsed = image();
  const result = parseProgramDynamic(new ByteView(bytes), [{ type: 2, offset: 0n, filesz: BigInt(bytes.length) }], parsed, bits);
  assert.equal(result.parsed, true, `${label} terminated table remains parseable`);
  assert.equal(parsed.metadata.programDynamic.terminated, true, `${label} records DT_NULL termination`);
  assert.equal(parsed.metadata.programDynamic.entrySpanAligned, true);
  assert.equal(parsed.metadata.programDynamicPartial, undefined);
}

for (const bits of [32, 64]) {
  const label = `ELF${bits}`;
  const { bytes, entrySize } = fixture([[DT_DEBUG, 0n]], bits);
  const parsed = image();
  const result = parseProgramDynamic(new ByteView(bytes), [{ type: 2, offset: 0n, filesz: BigInt(bytes.length) }], parsed, bits);
  assert.equal(result.parsed, true, `${label} best-effort entries remain available`);
  assert.equal(parsed.metadata.programDynamic.terminated, false, `${label} records missing DT_NULL`);
  assert.equal(parsed.metadata.programDynamic.entrySpanAligned, true);
  assert.equal(parsed.metadata.programDynamicPartial, true, `${label} missing DT_NULL is partial`);
  assert.ok(parsed.warnings.some((warning) => warning.includes('DT_NULL')), `${label} explains missing DT_NULL`);
  assert.equal(parsed.metadata.programDynamic.entrySize, entrySize);
}

for (const bits of [32, 64]) {
  const label = `ELF${bits}`;
  const { bytes, entrySize } = fixture([[DT_DEBUG, 0n], [DT_NULL, 0n]], bits, 1);
  const parsed = image();
  const result = parseProgramDynamic(new ByteView(bytes), [{ type: 2, offset: 0n, filesz: BigInt(bytes.length) }], parsed, bits);
  assert.equal(result.parsed, true, `${label} valid entries remain available with a malformed tail`);
  assert.equal(parsed.metadata.programDynamic.terminated, true);
  assert.equal(parsed.metadata.programDynamic.entrySpanAligned, false, `${label} records entry-size remainder`);
  assert.equal(parsed.metadata.programDynamicPartial, true, `${label} entry-size remainder is partial`);
  assert.ok(parsed.warnings.some((warning) => warning.includes(`entry size ${entrySize}`)), `${label} explains entry-size remainder`);
}

console.log('issue #6104 ELF PT_DYNAMIC termination boundaries: PASS');
