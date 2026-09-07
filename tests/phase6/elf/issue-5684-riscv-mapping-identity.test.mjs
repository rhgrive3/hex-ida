import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRiscvMappingSymbol, resolveRiscvIsaProfile } from '../../../js/binary/riscv-isa.js';

const fileProfile = Object.freeze({
  canonical:'rv64i',
  xlen:64,
  compressedInstructions:false,
  instructionAlignment:4,
  evidence:'elf-attribute',
});

function metadata(mapping, file = fileProfile) {
  return {
    file,
    sections:[{ start:0x1000n, end:0x3000n, sectionIndex:1 }],
    mappings:[mapping],
  };
}

test('5684: mapping symbols require primitive names', () => {
  assert.equal(parseRiscvMappingSymbol(['$xrv64imc']), null);
  assert.equal(parseRiscvMappingSymbol({ toString:() => '$xrv64imc' }), null);
  assert.equal(parseRiscvMappingSymbol('$xrv64imc')?.isa?.canonical, 'rv64imc');
});

test('5684: structured mapping identity fields cannot select an exact profile', () => {
  const valid = parseRiscvMappingSymbol('$xrv64imc');
  const malformed = [
    { address:['4096'], sectionIndex:1, kind:'instruction', isa:valid.isa },
    { address:0x1000n, sectionIndex:['1'], kind:'instruction', isa:valid.isa },
    { address:0x1000n, sectionIndex:1, kind:'instruction', isa:{ ...valid.isa, canonical:['rv64imc'] } },
    { address:0x1000n, sectionIndex:1, kind:'instruction', isa:{ ...valid.isa, xlen:['64'] } },
    { address:0x1000n, sectionIndex:1, kind:'instruction', isa:{ ...valid.isa, instructionAlignment:['2'] } },
  ];

  for (const mapping of malformed) {
    const result = resolveRiscvIsaProfile(metadata(mapping, null), 0x1800n, { allowAssumed:false });
    assert.equal(result, null);
  }
});

test('5684: canonical primitive mapping metadata still overrides file ISA', () => {
  const mapped = parseRiscvMappingSymbol('$xrv64imc');
  const result = resolveRiscvIsaProfile(metadata({
    address:0x1000n,
    sectionIndex:1,
    kind:'instruction',
    isa:mapped.isa,
  }), 0x1800n, { allowAssumed:false });

  assert.equal(result?.canonical, 'rv64imc');
  assert.equal(result?.compressedInstructions, true);
  assert.equal(result?.evidence, 'mapping-symbol');
  assert.equal(result?.exact, true);
});

test('5684: malformed file profile does not become exact evidence', () => {
  const result = resolveRiscvIsaProfile({ file:{
    canonical:['rv64i'],
    xlen:64,
    compressedInstructions:false,
    instructionAlignment:4,
    evidence:'elf-attribute',
  } }, 0x1800n, { allowAssumed:false });

  assert.equal(result, null);
});
