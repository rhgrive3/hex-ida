import test from 'node:test';
import assert from 'node:assert/strict';

import { fingerprintBinarySdk } from '../js/analysis/types/core/sdk-fingerprint.js';
import { TilLiteResolver, getDefaultCoreTilView } from '../js/analysis/types/core/til-lite-resolver.js';
import {
  HEX_EMU_PROT,
  HEX_EMU_STOP_REASON,
  runMiniArm64Emu,
  runMiniArm64EmuWasm,
} from '../js/targets/architecture/arm64/mini-arm64-emu.js';
import { extractHexSig, HEXSIG_ARCH_ARM64 } from '../js/analysis/signature/hex-sig-extractor.js';
import { arm64HexSigNormalizer } from '../js/targets/architecture/arm64/hexsig-norm.js';
import { createHexSigIndex, HEXSIG_VERDICT } from '../js/analysis/signature/hex-sig-index.js';
import { getHexEngineExports } from '../js/core/hex-engine-wasm.js';

function u32WordsToBytes(words) {
  const buf = new Uint8Array(words.length * 4);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < words.length; i++) {
    dv.setUint32(i * 4, words[i] >>> 0, true);
  }
  return buf;
}

test('1. fingerprintBinarySdk reads BinaryImage.libraries and metadata.buildVersion / loadCommands', () => {
  const fp = fingerprintBinarySdk({
    format: 'macho',
    arch: 'arm64',
    libraries: [
      { name: '/System/Library/Frameworks/UIKit.framework/UIKit', currentVersion: 0x00010000 },
      { path: '/usr/lib/libc++.1.dylib' },
      '/usr/lib/libobjc.A.dylib',
    ],
    metadata: {
      buildVersion: { platform: 2, sdk: 0x001a0200, minos: 0x000f0000 },
    },
  });

  assert.equal(fp.platform, 'ios');
  assert.equal(fp.dylibs.length, 3);
  assert.equal(fp.sdkVersion, '26.2');
  assert.equal(fp.minOsVersion, '15.0');
  assert.ok(fp.hints.includes('uikit'));
  assert.ok(fp.hints.includes('libcxx'));
  assert.ok(fp.hints.includes('objc'));
});

test('2. TilLiteResolver.resolveSelector resolves bare ObjC selectors while preserving exact-match precedence', () => {
  const resolver = new TilLiteResolver();
  resolver.mountCore(getDefaultCoreTilView());

  const exact = resolver.resolveSelector('+NSObject:alloc');
  assert.ok(exact);
  assert.equal(exact.matchedName, '+NSObject:alloc');

  const bareRelease = resolver.resolveSelector('release');
  assert.ok(bareRelease, 'bare selector "release" must resolve via fallback');
  assert.equal(bareRelease.matchedName, '-NSObject:release');

  const bareArray = resolver.resolveSelector('arrayWithObjects:count:');
  assert.ok(bareArray, 'multi-colon bare selector must resolve via fallback');
  assert.equal(bareArray.matchedName, '+NSArray:arrayWithObjects:count:');

  assert.equal(resolver.resolveSelector('nonExistentSelectorXYZ:'), null);
});

test('3. MiniArm64Emu JS and WASM match on STP/LDP, MADD, CSEL, UBFM, TBZ, logical-imm, and OOB fault mapping', () => {
  // Sequence exercising: MOVZ, STP/LDP, MADD(MUL), logical-imm AND, UBFM(LSR), CSEL, TBZ, RET
  const codeVa = 0x100004000n;
  const code = u32WordsToBytes([
    0xd28000c1, // movz x1, #6
    0xd28000e2, // movz x2, #7
    0xa9bf0be1, // stp x1, x2, [sp, #-16]!
    0xa8c113e3, // ldp x3, x4, [sp], #16  (x3=6, x4=7)
    0x9b047c60, // mul x0, x3, x4         (x0=42)
    0x92400c05, // and x5, x0, #0xf       (x5=10)
    0xd341fc06, // lsr x6, x0, #1         (x6=21)
    0xf10028bf, // cmp x5, #10            (Z=1)
    0x9a8600a0, // csel x0, x5, x6, eq    (x0=10)
    0x36080040, // tbz w0, #1, +8         (bit1 of 10 is 1 -> not taken)
    0x91000400, // add x0, x0, #1         (x0=11)
    0xd65f03c0, // ret
  ]);

  const jsRes = runMiniArm64Emu([{ va: codeVa, bytes: code, prot: HEX_EMU_PROT.RX }], [], { entryVa: codeVa, maxSteps: 64 });
  const wasmRes = runMiniArm64EmuWasm(code, { entryVa: codeVa, codeVa, maxSteps: 64 });

  assert.equal(jsRes.stopReason, HEX_EMU_STOP_REASON.RETURN_OK);
  assert.equal(wasmRes.stopReason, HEX_EMU_STOP_REASON.RETURN_OK);
  assert.equal(jsRes.x0, 11n);
  assert.equal(wasmRes.x0, 11n);
  assert.equal(jsRes.sp, wasmRes.sp);
  assert.equal(jsRes.stepsUsed, wasmRes.stepsUsed);

  // OOB memory store must map WASM faultCode=4 (MEM_OOB) to HEX_EMU_STOP_REASON.UNINIT_READ (5)
  const oobCode = u32WordsToBytes([
    0xd2820001, // movz x1, #0x1000
    0xf9400020, // ldr x0, [x1] -> unmapped
    0xd65f03c0, // ret
  ]);
  const jsOob = runMiniArm64Emu([{ va: codeVa, bytes: oobCode, prot: HEX_EMU_PROT.RX }], [], { entryVa: codeVa, maxSteps: 16 });
  const wasmOob = runMiniArm64EmuWasm(oobCode, { entryVa: codeVa, codeVa, maxSteps: 16 });
  assert.equal(jsOob.stopReason, HEX_EMU_STOP_REASON.UNINIT_READ);
  assert.equal(wasmOob.stopReason, HEX_EMU_STOP_REASON.UNINIT_READ);
});

test('4. HexSigIndex matchWasm aligns matched=false on ambiguous NEED_CG_TIEBREAK with JS match()', () => {
  const fnBytes = u32WordsToBytes([
    0xa9bf7bfd, // stp x29, x30, [sp, #-16]!
    0x910003fd, // mov x29, sp
    0x90000088, // adrp x8, #0x10000
    0x91044108, // add x8, x8, #0x110
    0xf9400900, // ldr x0, [x8, #16]
    0x94000020, // bl +0x80
    0xa8c17bfd, // ldp x29, x30, [sp], #16
    0xd65f03c0, // ret
  ]);
  const sig = extractHexSig(fnBytes, arm64HexSigNormalizer);
  const idx = createHexSigIndex();
  idx.addEntry({
    symbolName: 'dup_fn_a',
    libId: 0,
    arch: HEXSIG_ARCH_ARM64,
    pattern: sig.pattern,
    mask: sig.mask,
    prologueLen: sig.length,
    patternHash64: sig.patternHash64,
    baseConfidence: 900,
  });
  idx.addEntry({
    symbolName: 'dup_fn_b',
    libId: 0,
    arch: HEXSIG_ARCH_ARM64,
    pattern: sig.pattern,
    mask: sig.mask,
    prologueLen: sig.length,
    patternHash64: sig.patternHash64,
    baseConfidence: 900,
  });

  const ex = getHexEngineExports({ _engine: 'wasm' });
  const jsRes = idx.match(sig);
  const wasmRes = idx.matchWasm(fnBytes, HEXSIG_ARCH_ARM64, { wasmExports: ex });

  assert.equal(jsRes.verdict, HEXSIG_VERDICT.NEED_CG_TIEBREAK);
  assert.equal(wasmRes.verdict, HEXSIG_VERDICT.NEED_CG_TIEBREAK);
  assert.equal(jsRes.matched, false);
  assert.equal(wasmRes.matched, false);
  assert.equal(jsRes.entryIndex, wasmRes.entryIndex);
});
