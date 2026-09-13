// Regression for #8280: Objective-C runtime metadata hard-coded 8-byte native
// pointers. On arm64_32 (watchOS ILP32) every runtime pointer is 4 bytes, so a
// correct __objc_classlist entry was read as half of a 64-bit pointer and the
// section was reported as "declared 0 + 4 misaligned bytes" — every class,
// protocol, and category silently disappeared. A non-relative method entry is
// three native pointers, so the fixed 24-byte minimum also rejected valid
// 12-byte ILP32 entries. The native pointer width now comes from one authority
// (explicit width > declared architecture > documented LP64 default), shared by
// the legacy parser, the extended parser, and the runtime facade, and a
// declared-but-unknown ABI fails closed instead of being widened to LP64.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildObjcModel,
  resolveObjcPointerBytes,
} from '../../../js/objc-legacy.js';
import { parseObjcExtendedMetadata } from '../../../js/apple/objc-metadata.js';
import { buildObjcRuntimeModel } from '../../../js/objc.js';

function readerFor(mem) {
  return async (addr, len) => {
    const at = Number(addr);
    if (!Number.isSafeInteger(at) || at < 0 || at >= mem.length) return null;
    return mem.subarray(at, Math.min(mem.length, at + len));
  };
}

function fixture() {
  const mem = new Uint8Array(0x4000);
  const dv = new DataView(mem.buffer);
  const p32 = (at, v) => dv.setUint32(at, Number(v) >>> 0, true);
  const str = (at, s) => {
    const bytes = new TextEncoder().encode(s);
    mem.set(bytes, at);
    mem[at + bytes.length] = 0;
  };
  return { mem, p32, str, read: readerFor(mem) };
}

// A minimal arm64_32 Objective-C image: one class with one non-relative 12-byte
// method entry, and one protocol whose pointer fields are all 4 bytes.
function ilp32Image() {
  const f = fixture();
  const classList = 0x200;
  const cls = 0x1000;
  const ro = 0x1200;
  const methodList = 0x1400;
  const className = 0x1800;
  const selector = 0x1900;
  const imp = 0x2100;

  // __objc_classlist: one 4-byte class pointer.
  f.p32(classList, cls);
  // class_t: isa(0) = 0 (no metaclass), data at 4 * pointerBytes = 16.
  f.p32(cls + 16, ro);
  // class_ro_t: instanceSize@8, name@20, baseMethods@24, ivars@32.
  f.p32(ro + 8, 0x20);
  f.p32(ro + 20, className);
  f.p32(ro + 24, methodList);
  f.p32(ro + 32, 0);
  f.str(className, 'ILP32Victim');
  // method_list_t: entsize 12 (no REL flag), one entry of three 4-byte pointers.
  f.p32(methodList, 12);
  f.p32(methodList + 4, 1);
  f.p32(methodList + 8, selector);
  f.p32(methodList + 12, 0);
  f.p32(methodList + 16, imp);
  f.str(selector, 'doThing:');

  const protoList = 0x300;
  const proto = 0x2400;
  const protoName = 0x2800;
  // __objc_protolist: one 4-byte protocol_t pointer.
  f.p32(protoList, proto);
  // protocol_t: name@4, inherited list@8, methods@12..., size@32, flags@36.
  f.p32(proto + 4, protoName);
  f.p32(proto + 32, 36);
  f.p32(proto + 36, 0);
  f.str(protoName, 'ILP32Protocol');

  return {
    read: f.read,
    classList: { vmAddr: BigInt(classList), size: 4n },
    protocolList: { vmAddr: BigInt(protoList), size: 4n },
  };
}

test('#8280 the native pointer ABI authority is explicit, total, and ordered', () => {
  assert.deepEqual(resolveObjcPointerBytes({ pointerBytes: 4 }), { bytes: 4, provenance: 'explicit' });
  assert.deepEqual(resolveObjcPointerBytes({ pointerSize: 8 }), { bytes: 8, provenance: 'explicit' });
  assert.deepEqual(
    resolveObjcPointerBytes({ pointerBytes: 4 }, { architecture: 'arm64' }),
    { bytes: 4, provenance: 'explicit' },
    'an explicit width must outrank a declared architecture',
  );
  assert.deepEqual(resolveObjcPointerBytes({ architecture: 'arm64_32' }), { bytes: 4, provenance: 'architecture', architecture: 'arm64_32' });
  assert.deepEqual(resolveObjcPointerBytes({ architecture: 'armv7k' }), { bytes: 4, provenance: 'architecture', architecture: 'armv7k' });
  assert.deepEqual(resolveObjcPointerBytes({ architecture: 'arm64e' }), { bytes: 8, provenance: 'architecture', architecture: 'arm64e' });
  assert.deepEqual(resolveObjcPointerBytes({ architecture: 'x86_64' }), { bytes: 8, provenance: 'architecture', architecture: 'x86_64' });
  assert.deepEqual(resolveObjcPointerBytes(), { bytes: 8, provenance: 'default-lp64' });

  const unsupported = resolveObjcPointerBytes({ architecture: 'mips64' });
  assert.equal(unsupported.bytes, null);
  assert.equal(unsupported.reason, 'objc-pointer-abi-unsupported');
  const invalid = resolveObjcPointerBytes({ pointerBytes: 16 });
  assert.equal(invalid.bytes, null);
  assert.equal(invalid.reason, 'objc-pointer-abi-invalid');
});

test('#8280 legacy model decodes the 4-byte class list and 12-byte method entry only under ILP32', async () => {
  const ilp32 = ilp32Image();
  const model = await buildObjcModel(ilp32.read, ilp32.classList, null, 0n, null, { architecture: 'arm64_32' });
  assert.equal(model.pointerBytes, 4);
  assert.equal(model.classes.length, 1, 'a 4-byte class pointer must yield one class');
  assert.equal(model.classes[0].name, 'ILP32Victim');
  assert.equal(model.classes[0].methods.length, 1, 'a 12-byte non-relative entry is a valid ILP32 method');
  assert.equal(model.classes[0].methods[0].sel, 'doThing:');
  assert.equal(model.completeness.classes.declared, 1);
  assert.equal(model.completeness.classes.misalignedBytes, 0);
  assert.equal(model.completeness.complete, true);

  // Explicit width behaves identically to the declared architecture.
  const byWidth = await buildObjcModel(ilp32.read, ilp32.classList, null, 0n, null, { pointerSize: 4 });
  assert.equal(byWidth.classes[0]?.name, 'ILP32Victim');

  // Control: with no ABI claim the documented LP64 default genuinely cannot read
  // this fixture, so the 4 bytes are a misaligned remainder — never half a pointer.
  const lp64 = await buildObjcModel(ilp32.read, ilp32.classList, null, 0n);
  assert.equal(lp64.classes.length, 0);
  assert.equal(lp64.completeness.classes.misalignedBytes, 4);
  assert.ok(lp64.completeness.classes.reasons.includes('class-list-size-misaligned'));
  assert.equal(lp64.completeness.complete, false);
});

test('#8280 an unknown declared ABI fails closed instead of widening to LP64', async () => {
  const ilp32 = ilp32Image();
  const model = await buildObjcModel(ilp32.read, ilp32.classList, null, 0n, null, { architecture: 'unknown' });
  assert.equal(model.classes.length, 0, 'no class may be fabricated from an undecodable ABI');
  assert.equal(model.pointerBytes, null);
  assert.equal(model.pointerAbiReason, 'objc-pointer-abi-unsupported');
  assert.ok(model.completeness.classes.reasons.includes('objc-pointer-abi-unsupported'));
  assert.equal(model.completeness.classes.sizeValid, false);
  assert.equal(model.completeness.complete, false);
});

test('#8280 extended protocol parser reads 4-byte pointers on ILP32', async () => {
  const ilp32 = ilp32Image();
  const sections = { protocolList: ilp32.protocolList, categoryList: null };

  const ilp32Result = await parseObjcExtendedMetadata(ilp32.read, sections, { architecture: 'arm64_32' });
  assert.equal(ilp32Result.pointerBytes, 4);
  assert.equal(ilp32Result.protocols.length, 1);
  assert.equal(ilp32Result.protocols[0].name, 'ILP32Protocol');
  assert.equal(ilp32Result.completeness.protocols.declared, 1);
  assert.equal(ilp32Result.completeness.protocols.misalignedBytes, 0);
  assert.equal(ilp32Result.completeness.complete, true);

  const byWidth = await parseObjcExtendedMetadata(ilp32.read, sections, { pointerBytes: 4 });
  assert.equal(byWidth.protocols[0]?.name, 'ILP32Protocol');

  // LP64 control: the same 4-byte section is a misaligned remainder.
  const lp64 = await parseObjcExtendedMetadata(ilp32.read, sections, {});
  assert.equal(lp64.protocols.length, 0);
  assert.equal(lp64.completeness.protocols.misalignedBytes, 4);
  assert.equal(lp64.completeness.complete, false);

  // Declared but unsupported / invalid ABI must publish an explicit reason and
  // no partially-decoded protocols.
  for (const [opts, reason] of [
    [{ architecture: 'mips64' }, 'objc-pointer-abi-unsupported'],
    [{ pointerBytes: 16 }, 'objc-pointer-abi-invalid'],
  ]) {
    const failed = await parseObjcExtendedMetadata(ilp32.read, sections, opts);
    assert.equal(failed.protocols.length, 0);
    assert.equal(failed.pointerBytes, null);
    assert.equal(failed.pointerAbiReason, reason);
    assert.equal(failed.completeness.complete, false);
  }
});

test('#8280 runtime facade passes the declared architecture to both parsers', async () => {
  const ilp32 = ilp32Image();
  const model = await buildObjcRuntimeModel(
    ilp32.read,
    ilp32.classList,
    {
      protocolList: ilp32.protocolList,
      architecture: 'arm64_32',
      executableRanges: [{ vmAddr: 0x2000n, size: 0x1000n }],
    },
    null,
    0n,
  );
  assert.equal(model.pointerBytes, 4, 'the facade must surface the shared ILP32 width');
  assert.equal(model.classes.length, 1);
  assert.equal(model.classes[0].name, 'ILP32Victim');
  assert.equal(model.protocols.length, 1);
  assert.equal(model.protocols[0].name, 'ILP32Protocol');
  assert.equal(model.runtimeCompleteness.complete, true);
});
