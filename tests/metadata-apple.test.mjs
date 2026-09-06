import assert from 'node:assert/strict';
import { SwiftMetadataProvider } from '../js/metadata/swift.js';
import { ObjcMetadataProvider } from '../js/metadata/objc.js';
import { parseUnifiedLanguageMetadata } from '../js/metadata/index.js';
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

// 5. Unified language metadata: non-array symbols and non-string section names fail-closed (#6219, #5370)
{
  for (const badSymbols of [{}, 'not-an-array', 123, true]) {
    const res = await parseUnifiedLanguageMetadata({ symbols: badSymbols });
    assert.ok(Array.isArray(res.results));
  }
  for (const badSection of [{ name: {} }, { section: [] }, { name: null }]) {
    const res = await parseUnifiedLanguageMetadata({ sections: [badSection] });
    assert.ok(Array.isArray(res.results));
  }
  const resBadSym = await parseUnifiedLanguageMetadata({ symbols: [{ name: ['_Rfoo'] }] });
  assert.ok(Array.isArray(resBadSym.results));
}

// 6. ObjcMetadataProvider probe completeness distinctions (#6213)
{
  // 6a: Truly absent ObjC sections
  const pNone = new ObjcMetadataProvider({
    sections: [{ name: '__text', size: 1024, vmAddr: 0x1000n }],
    readAt: async () => null,
  });
  const resNone = await pNone.probe();
  assert.equal(resNone.completeness.present, false);
  assert.equal(resNone.completeness.complete, true);
  assert.equal(resNone.identity.verdict, 'identity-unavailable');
  assert.equal(resNone.identity.detail, 'no objc metadata sections found');

  // 6b: ObjC section present + reader null
  const pNoReader = new ObjcMetadataProvider({
    sections: [{ name: '__objc_classlist', size: 16, vmAddr: 0x2000n }],
    readAt: null,
  });
  const resNoReader = await pNoReader.probe();
  assert.equal(resNoReader.completeness.present, true);
  assert.equal(resNoReader.completeness.complete, false);
  assert.ok(resNoReader.diagnostics.some((d) => /no reader/i.test(d)));

  // 6c: ObjC section present + classlist missing
  const pNoClasslist = new ObjcMetadataProvider({
    sections: [{ name: '__objc_catlist', size: 16, vmAddr: 0x2000n }],
    readAt: async () => null,
  });
  const resNoClasslist = await pNoClasslist.probe();
  assert.equal(resNoClasslist.completeness.present, true);
  assert.equal(resNoClasslist.completeness.complete, false);
  assert.ok(resNoClasslist.diagnostics.some((d) => /classlist/i.test(d)));
}

// 7. ObjcMetadataProvider methods: classMethods vs methods descriptor accuracy (#5884)
{
  const provider = new ObjcMetadataProvider();
  provider.cachedModel = {
    classes: [{
      name: 'TestClass',
      methods: [{ sel: 'instSel', addr: 0x1000n }],
      classMethods: [{ sel: 'clsSel', addr: 0x2000n }],
    }],
  };
  const page = provider.methods();
  assert.equal(page.records.length, 2);
  const instRecord = page.records.find((r) => r.descriptor.selector === 'instSel');
  const clsRecord = page.records.find((r) => r.descriptor.selector === 'clsSel');

  assert.equal(instRecord.descriptor.classMethod, false);
  assert.equal(instRecord.name, '-[TestClass instSel]');
  assert.equal(instRecord.entityId, 'method@TestClass:-:instSel');

  assert.equal(clsRecord.descriptor.classMethod, true);
  assert.equal(clsRecord.name, '+[TestClass clsSel]');
  assert.equal(clsRecord.entityId, 'method@TestClass:+:clsSel');
}

console.log('Swift & Objective-C Metadata Provider tests passed.');
