import assert from 'node:assert/strict';
import { SwiftMetadataProvider } from '../js/metadata/swift.js';
import { ObjcMetadataProvider } from '../js/metadata/objc.js';
import { buildSelectorIndex, resolveSelectorStub } from '../js/objc.js';

console.log('Testing Swift & Objective-C Metadata Providers...');

// 1. Swift Metadata Provider: Stripped (no swift sections)
{
  const provider = new SwiftMetadataProvider({
    sections: [{ name: '__text', size: 1024, vmAddr: 0x1000n }],
    readAt: async () => new Uint8Array(16),
    binaryIdentity: 'sha256:stripped-swift',
  });

  const probe = await provider.probe();
  assert.equal(probe.authoritative, false);
  assert.equal(probe.completeness.present, false);
  assert.equal(probe.identity.verdict, 'identity-unavailable');
}

// 2. Swift Metadata Provider: Active swift5 sections
{
  const mem = new Uint8Array(0x4000);
  const dv = new DataView(mem.buffer);

  // Setup __swift5_types section with 1 struct
  // struct nominal descriptor at 0x1100
  dv.setUint32(0x1100, 17, true); // Struct
  dv.setInt32(0x1104, 0, true);
  dv.setInt32(0x1108, 0x1200 - 0x1108, true); // name -> 0x1200
  dv.setInt32(0x110c, 0, true);
  dv.setInt32(0x1110, 0, true);
  dv.setUint32(0x1114, 0, true); // 0 fields
  dv.setUint32(0x1118, 0, true);

  const nameStr = 'AppState';
  for (let i = 0; i < nameStr.length; i++) mem[0x1200 + i] = nameStr.charCodeAt(i);
  mem[0x1200 + nameStr.length] = 0;

  // __swift5_types relative pointer table at 0x1000 pointing to 0x1100
  dv.setInt32(0x1000, 0x1100 - 0x1000, true);

  const readAt = async (addr, len) => {
    const a = Number(addr);
    if (a < 0 || a >= mem.length) return null;
    return mem.subarray(a, Math.min(mem.length, a + len));
  };

  const provider = new SwiftMetadataProvider({
    sections: [
      { name: '__swift5_types', section: '__swift5_types', size: 4, vmAddr: 0x1000n, addr: 0x1000n },
    ],
    readAt,
    binaryIdentity: 'sha256:swift-app',
  });

  const probe = await provider.probe();
  assert.equal(probe.authoritative, true);
  assert.equal(probe.completeness.present, true);
  assert.equal(probe.counts.types, 1);

  const types = provider.types();
  assert.equal(types.records.length, 1);
  assert.equal(types.records[0].name, 'AppState');
  assert.equal(types.records[0].descriptor.kind, 'struct');
}

// 3. Objective-C Metadata Provider: Stripped
{
  const provider = new ObjcMetadataProvider({
    sections: [{ name: '__text', size: 1024, vmAddr: 0x1000n }],
    readAt: async () => new Uint8Array(16),
    binaryIdentity: 'sha256:stripped-objc',
  });

  const probe = await provider.probe();
  assert.equal(probe.authoritative, false);
  assert.equal(probe.completeness.present, false);
  assert.equal(probe.identity.verdict, 'identity-unavailable');
}

// 4. Objective-C selector addresses: equivalent numeric forms share one key.
{
  const forms = [16, 16n, '16', '0x10'];
  for (const storedAddress of forms) {
    const index = buildSelectorIndex({ stubs: [{ addr: storedAddress, selector: 'doThing:' }] });
    for (const queryAddress of forms) {
      const resolved = resolveSelectorStub({ address: queryAddress, selectorIndex: index });
      assert.equal(
        resolved.selector,
        'doThing:',
        `equivalent address forms must share one selector key: stored=${String(storedAddress)} query=${String(queryAddress)}`,
      );
      assert.equal(resolved.ambiguous, false);
    }
  }

  for (const invalidAddress of [-1, -1n, '-1', '0x', 'xyz', [], {}, true]) {
    const index = buildSelectorIndex({ stubs: [{ addr: invalidAddress, selector: 'bad:' }] });
    const resolved = resolveSelectorStub({ address: 16, selectorIndex: index });
    assert.equal(resolved.selector, null, `invalid address ${String(invalidAddress)} must not enter the selector index`);
  }
}

console.log('Swift & Objective-C Metadata Provider tests passed.');
