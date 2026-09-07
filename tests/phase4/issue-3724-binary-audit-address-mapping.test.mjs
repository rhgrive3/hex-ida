import assert from 'node:assert/strict';
import { auditBinary, capabilitiesOf } from '../../js/binary/audit.js';

function imageWith({ segments = [], sections = [] } = {}) {
  return {
    format: 'elf',
    arch: 'arm64',
    endian: 'little',
    bits: 64,
    fileSize: 0x200n,
    segments,
    sections,
    imports: [],
    exports: [],
    symbols: [],
    relocations: [],
    functions: [],
    libraries: [],
    entrypoint: null,
    metadata: {},
    sectionAt() { return null; },
    segmentAt() { return null; },
    addressToOffset() { return null; },
    offsetToAddress() { return null; },
  };
}

{
  const image = imageWith({
    sections: [{
      name: '.symtab',
      source: 'section-header',
      flags: 0n,
      address: 0n,
      fileOffset: 0x100n,
      fileSize: 0x40n,
    }],
  });
  assert.equal(capabilitiesOf(image).addressMapping, false);
  const audit = auditBinary(image);
  assert.equal(audit.stats.mappedSections, 0);
  assert.equal(audit.capabilities.addressMapping, false);
}

{
  const image = imageWith({
    sections: [{
      name: '.text',
      source: 'section-header',
      flags: 0x2n,
      address: 0x1000n,
      fileOffset: 0x100n,
      fileSize: 0x40n,
    }],
  });
  assert.equal(capabilitiesOf(image).addressMapping, true);
}

{
  const image = imageWith({
    segments: [{
      name: 'LOAD',
      address: 0x1000n,
      size: 0x40n,
      fileOffset: 0x100n,
      fileSize: 0x40n,
    }],
  });
  assert.equal(capabilitiesOf(image).addressMapping, true);
}

{
  const image = imageWith({
    sections: [{
      name: '.debug_info',
      source: 'unmapped-section',
      address: 0n,
      fileOffset: 0x100n,
      fileSize: 0x40n,
    }],
  });
  assert.equal(capabilitiesOf(image).addressMapping, false);
}

console.log('issue-3724-binary-audit-address-mapping: PASS');
