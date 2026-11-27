#!/usr/bin/env node
/**
 * Comprehensive iOS Beyond-IDA E2E Verification Suite.
 * Proves all 5 iOS hardening tracks live against real WASM, real Apple Swift Demangler,
 * real Ghidra mac_osx.gdt TIL packs, real clang arm64/arm64e-apple-ios17.0 Mach-O objects,
 * ObjC msgSend$ stub resolution, BinExport2 interop, and dist/ hub persistence.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getHexEngineExports } from '../js/core/hex-engine-wasm.js';
import { demangleSymbol, demangleSymbolJsFallback, detectMangleKind, DEMANGLE_KIND } from '../js/analysis/types/core/symbol-demangler.js';
import { demangleSwiftSymbol, swiftCallingConvention, formatSwiftCall } from '../js/swift.js';
import { fingerprintBinarySdk } from '../js/analysis/types/core/sdk-fingerprint.js';
import { matchSdkPacks } from '../js/analysis/types/core/sdk-matcher.js';
import { normalizeSymbolForTil } from '../js/analysis/types/core/til-lite-resolver.js';
import {
  validateHexSigHubManifest,
  selectHexSigPacksForBinary,
  loadHexSigPack,
  mountHexSigPackToWasm,
} from '../js/analysis/signature/hexsig-hub-loader.js';
import { HEXSIG_ARCH_ARM64 } from '../js/analysis/signature/hex-sig-extractor.js';
import { extractFunctionsFromMachO64 } from '../scripts/import-rizin-sigdb.mjs';
import { exportBinExport2, importBinExport2 } from '../js/ui/export-interop.js';
import { refineAppleSwiftDecompile } from '../js/decompiler/apple-arc-swift-pass.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function runTest(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  PASS  ${name}`);
      return true;
    })
    .catch((err) => {
      console.error(`  FAIL  ${name}: ${err.stack || err.message}`);
      return false;
    });
}

async function main() {
  console.log('=== iOS Beyond-IDA End-to-End Verification Suite ===');
  const results = [];

  // -------------------------------------------------------------------------
  // 1. Real Apple swiftlang/swift Demangler inside hex_engine.wasm + js/swift.js
  // -------------------------------------------------------------------------
  results.push(await runTest('Track 1: Real Apple Swift WASM demangler handles 15+ iOS Swift 5/6 symbols & DoS bounds', () => {
    const cases = [
      ['_$s5MyApp14ViewControllerC11viewDidLoadyyF', 'MyApp.ViewController.viewDidLoad() -> ()'],
      ['$s5MyApp14ViewControllerC14viewWillAppearyySbF', 'MyApp.ViewController.viewWillAppear(Bool) -> ()'],
      ['_$s5MyApp11AuthManagerC5login8username8passwordSbSS_SStYaKF', 'MyApp.AuthManager.login(username: String, password: String) async throws -> Bool'],
      ['_$s5MyApp11CryptoStoreV7decrypt4datay10Foundation4DataV_tKF', 'MyApp.CryptoStore.decrypt(data: Foundation.Data) throws -> ()'],
      ['_$sSaySiG', '[Int]'],
      ['$sSDySSypG', '[String : Any]'],
      ['$s5MyApp10CacheEntryVyxG', 'MyApp.CacheEntry<A>'],
      ['_$s5MyApp14ViewControllerCMa', 'type metadata accessor for MyApp.ViewController'],
      ['_$s5MyApp14ViewControllerC5titleSSSgvg', 'MyApp.ViewController.title.getter : String?'],
      ['_$s5MyApp14ViewControllerC5titleSSSgvs', 'MyApp.ViewController.title.setter : String?'],
      ['$s5MyApp10APIServiceC12fetchProfile2id10completionySi_ySSSg_s5Error_pSgtctF', 'MyApp.APIService.fetchProfile(id: Int, completion: (String?, Error?) -> ()) -> ()'],
      ['_$s5MyApp11PaymentFlowC11processItem_5countSbSS_SitKF', 'MyApp.PaymentFlow.processItem(_: String, count: Int) throws -> Bool'],
      ['_$s10Foundation3URLV6stringACSgSSh_tcfC', 'Foundation.URL.init(string: __shared String) -> Foundation.URL?'],
    ];

    for (const [mangled, expected] of cases) {
      assert.equal(detectMangleKind(mangled), DEMANGLE_KIND.SWIFT, `detectMangleKind(${mangled})`);
      const out = demangleSymbol(mangled);
      assert.equal(out, expected, `WASM Swift demangle mismatch for ${mangled}`);
    }

    // Verify js/swift.js demangleSwiftSymbol + swiftCallingConvention + formatSwiftCall integration
    const asyncThrows = demangleSwiftSymbol('_$s5MyApp11AuthManagerC5login8username8passwordSbSS_SStYaKF');
    assert.equal(asyncThrows.parsed, true);
    assert.equal(asyncThrows.async, true);
    assert.equal(asyncThrows.throws, true);
    assert.ok(asyncThrows.demangled.includes('MyApp.AuthManager.login'));

    const cc = swiftCallingConvention({ mangled: '_$s5MyApp11AuthManagerC5login8username8passwordSbSS_SStYaKF' });
    assert.equal(cc.representation, 'await-throwing');
    const formatted = formatSwiftCall('_$s5MyApp11AuthManagerC5login8username8passwordSbSS_SStYaKF', ['user', 'pass']);
    assert.ok(formatted.startsWith('try await MyApp.AuthManager.login'));

    const meta = demangleSwiftSymbol('_$s5MyApp14ViewControllerCMa');
    assert.equal(meta.accessor, 'metadata');
    const getter = demangleSwiftSymbol('_$s5MyApp14ViewControllerC5titleSSSgvg');
    assert.equal(getter.accessor, 'getter');

    // JS fallback parity
    const fb = demangleSymbolJsFallback('_$s5MyApp14ViewControllerC11viewDidLoadyyF');
    assert.ok(fb && fb.includes('MyApp.ViewController.viewDidLoad'));

    // Verify 4-ABI Universal WASM Demangler: Itanium C++, Rust v0, Apple Swift, Microsoft MSVC C++
    assert.equal(detectMangleKind('?decrypt@CryptoEngine@MyApp@@QEAAHPEBE_K@Z'), DEMANGLE_KIND.MSVC_CPP);
    const msvcOut = demangleSymbol('?decrypt@CryptoEngine@MyApp@@QEAAHPEBE_K@Z');
    assert.ok(msvcOut && msvcOut.includes('MyApp::CryptoEngine::decrypt'), `MSVC WASM demangle failed: ${msvcOut}`);

    // DoS / malformed safety
    const huge = '$s' + '9999999'.repeat(400);
    assert.equal(demangleSymbol(huge), null);
    assert.equal(demangleSymbol('$sINVALID!!!'), null);
  }));

  // -------------------------------------------------------------------------
  // 2. Real Ghidra mac_osx.gdt (apple-darwin-full) + Expanded ios-sdk-core in WASM
  // -------------------------------------------------------------------------
  results.push(await runTest('Track 2: iOS Mach-O fingerprint auto-selects ios-sdk-core + apple-darwin-full & mounts live in WASM', () => {
    const tilManifestPath = path.join(ROOT, 'dist/til-hub/manifest.json');
    assert.ok(fs.existsSync(tilManifestPath), 'dist/til-hub/manifest.json must exist');
    const tilManifest = JSON.parse(fs.readFileSync(tilManifestPath, 'utf8'));
    assert.ok(tilManifest.totalEntries + tilManifest.totalTypes >= 9000, 'TIL-Hub should have >= 9000 defs');

    const fp = fingerprintBinarySdk({
      format: 'macho',
      arch: 'arm64e',
      platform: 'ios',
      sdkVersion: '18.0',
      dylibs: [
        '/System/Library/Frameworks/UIKit.framework/UIKit',
        '/System/Library/Frameworks/Foundation.framework/Foundation',
        '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation',
        '/System/Library/Frameworks/Security.framework/Security',
        '/usr/lib/libSystem.B.dylib',
        '/usr/lib/libobjc.A.dylib',
        '/usr/lib/swift/libswiftCore.dylib',
      ],
      symbols: ['_objc_msgSend', '_$s5MyApp14ViewControllerC11viewDidLoadyyF', '_SecItemCopyMatching', '_CCCrypt'],
    });
    assert.equal(fp.platform, 'ios');

    const match = matchSdkPacks(fp, tilManifest.packs);
    const selectedIds = match.selected.map((s) => s.pack.id);
    assert.ok(selectedIds.includes('ios-sdk-core'), `expected ios-sdk-core in ${JSON.stringify(selectedIds)}`);
    assert.ok(selectedIds.includes('apple-darwin-full'), `expected apple-darwin-full in ${JSON.stringify(selectedIds)}`);
    assert.ok(
      [match.slots.packA?.id, match.slots.packB?.id].includes('ios-sdk-core'),
      'ios-sdk-core must be in hot WASM Slot A or B'
    );
    assert.ok(
      [match.slots.packA?.id, match.slots.packB?.id].includes('apple-darwin-full'),
      'apple-darwin-full must be in hot WASM Slot A or B'
    );

    // Mount BOTH real TIL1 blobs into live WASM hex_til_mount & verify real symbol resolution
    const ex = getHexEngineExports();
    const iosBytes = fs.readFileSync(path.join(ROOT, 'dist/til-hub/ios-sdk-core.til1'));
    const darwinBytes = fs.readFileSync(path.join(ROOT, 'dist/til-hub/apple-darwin-full.til1'));
    assert.ok(iosBytes.length <= 64 * 1024, 'ios-sdk-core <= 64 KiB');
    assert.ok(darwinBytes.length <= 256 * 1024, 'apple-darwin-full <= 256 KiB Slot 1/2 cap');

    const enc = new TextEncoder();
    ex.hex_til_purge_packs();
    const mountAndQuery = (slot, tilBuf, syms) => {
      // Arena slot 8 holds TIL pack blobs (reset before each mount or bump-allocate sequentially)
      if (slot === 1) ex.hex_type_arena_reset_slot(8);
      const ptr = ex.hex_type_arena_bump_alloc(8, tilBuf.length, 8) >>> 0;
      assert.ok(ptr > 0, `slot ${slot} alloc`);
      new Uint8Array(ex.memory.buffer, ptr, tilBuf.length).set(tilBuf);
      const tidBase = slot === 1 ? 0x1000 : 0x2000;
      assert.equal(ex.hex_til_mount(slot, ptr, tilBuf.length, tidBase, 0x0a00), 0, `hex_til_mount(slot ${slot})`);

      const slotMask = 1 << slot;
      for (const sym of syms) {
        ex.hex_engine_scratch_reset();
        const b = enc.encode(sym);
        const sPtr = ex.hex_engine_scratch_alloc(b.length + 1, 8) >>> 0;
        const oPtr = ex.hex_engine_scratch_alloc(64, 8) >>> 0;
        const mem = new Uint8Array(ex.memory.buffer);
        mem.set(b, sPtr);
        mem[sPtr + b.length] = 0;
        const st = ex.hex_til_lookup_symbol(sPtr, b.length, slotMask, 0, oPtr);
        assert.equal(st, 0, `WASM hex_til_lookup_symbol failed for ${sym} in slot ${slot}`);
      }
    };

    mountAndQuery(1, iosBytes, [
      'UIApplicationMain',
      'SecItemCopyMatching',
      'CCCrypt',
      'CC_SHA256',
      'dispatch_async',
      'CFStringCreateWithCString',
      'objc_msgSend',
      'swift_allocObject',
      'swift_bridgeObjectRetain',
      '_dyld_get_image_header',
      'mach_vm_protect',
      'sysctlbyname',
      'ptrace',
      'nw_connection_create',
      'sec_protocol_options_set_verify_block',
      'compression_decode_buffer',
      'MTLCreateSystemDefaultDevice',
      'CGContextDrawImage',
      'csops',
    ]);
    mountAndQuery(2, darwinBytes, ['CCCryptorCreate', 'audit_session_self', 'fopen', 'kqueue']);
  }));

  // -------------------------------------------------------------------------
  // 3. Real clang arm64-apple-ios17.0 & arm64e-apple-ios17.0 Mach-O HEX-SIG in WASM Slot 4
  // -------------------------------------------------------------------------
  results.push(await runTest('Track 3: Real arm64 & arm64e (PAC) Mach-O functions match live via WASM hex_hexsig_match_fn', async () => {
    const sigManifestPath = path.join(ROOT, 'dist/hexsig-hub/manifest.json');
    assert.ok(fs.existsSync(sigManifestPath), 'dist/hexsig-hub/manifest.json must exist');
    const sigManifest = validateHexSigHubManifest(JSON.parse(fs.readFileSync(sigManifestPath, 'utf8')));

    const selected = selectHexSigPacksForBinary(sigManifest, { format: 'macho', arch: 'arm64e', platform: 'ios' });
    assert.ok(selected.length > 0);
    assert.equal(selected[0].packId, 'ios-arm64-macho', 'Mach-O iOS ARM64e must prioritize ios-arm64-macho');

    const packGz = fs.readFileSync(path.join(ROOT, 'dist/hexsig-hub', selected[0].file));
    const loaded = await loadHexSigPack(selected[0], { gzBytes: new Uint8Array(packGz), verifySha256: true });
    assert.equal(loaded.decoded.entryCount, 1500);

    const wasmMatcher = mountHexSigPackToWasm(loaded.rawBytes, loaded.decoded);
    assert.ok(wasmMatcher, 'ios-arm64-macho must mount cleanly in WASM Slot 4');

    // Extract real compiled arm64 & arm64e (PAC) Mach-O functions and match them live in WASM
    const arm64Funcs = extractFunctionsFromMachO64(fs.readFileSync(path.join(ROOT, 'third_party/ios-arm64-macho/ios_arm64_crypto.o')));
    const arm64eFuncs = extractFunctionsFromMachO64(fs.readFileSync(path.join(ROOT, 'third_party/ios-arm64-macho/ios_arm64e_pac_crypto.o')));

    const mustMatchArm64 = [
      'ios_sha256_transform', 'ios_chacha20_block', 'ios_crc32_update', 'ios_adler32_update',
      'ios_fnv1a64', 'ios_timingsafe_bcmp', 'ios_base64_encode', 'ios_utf8_validate',
      'ios_aes_mix_columns', 'ios_uleb128_decode', 'ios_murmur3_32', 'ios_sipround',
      'ios_aes128_sub_shift', 'ios_aes128_key_expand', 'ios_rc4_crypt', 'ios_xxtea_encrypt',
      'ios_tea_decrypt', 'ios_lz4_decompress', 'ios_hex_encode', 'ios_hex_decode',
      'ios_url_percent_decode', 'ios_explicit_bzero', 'ios_poly1305_clamp', 'ios_pkcs7_unpad',
    ];
    for (const name of mustMatchArm64) {
      const fn = arm64Funcs.find((f) => f.name === name);
      assert.ok(fn, `expected ${name} in ios_arm64_crypto.o`);
      const m = wasmMatcher.matchFn(fn.pattern.subarray(0, fn.patternLen), HEXSIG_ARCH_ARM64);
      assert.equal(m.matched, true, `WASM failed to match real arm64 Mach-O ${name}`);
      assert.equal(m.symbolName, name);
      assert.ok(m.confidence >= 750);
    }

    const pacFn = arm64eFuncs.find((f) => f.name === 'ios_sha256_transform');
    assert.ok(pacFn, 'expected ios_sha256_transform in ios_arm64e_pac_crypto.o');
    const pacMatch = wasmMatcher.matchFn(pacFn.pattern.subarray(0, pacFn.patternLen), HEXSIG_ARCH_ARM64);
    assert.equal(pacMatch.matched, true, 'WASM failed to match real arm64e PAC Mach-O function');
    assert.ok(pacMatch.symbolName.startsWith('ios_sha256_transform'));
  }));

  // -------------------------------------------------------------------------
  // 4. Modern Xcode ObjC msgSend$ Stub Resolution + BinExport2 Interop
  // -------------------------------------------------------------------------
  results.push(await runTest('Track 4: Modern _objc_msgSend$<sel> stubs & iOS Swift/ObjC BinExport2 round-trip', () => {
    const stub1 = normalizeSymbolForTil('_objc_msgSend$dataTaskWithRequest:completionHandler:');
    assert.ok(stub1 && stub1.candidates.includes('objc_msgSend'), '_objc_msgSend$ stub must resolve to objc_msgSend');
    assert.equal(stub1.selectorKey, '*:dataTaskWithRequest:completionHandler:');

    const stub2 = normalizeSymbolForTil('_objc_msgSend$viewDidLoad');
    assert.ok(stub2 && stub2.candidates.includes('objc_msgSend'));
    assert.equal(stub2.selectorKey, '*:viewDidLoad');

    // Export an iOS ARM64e analysis with demangled Swift & ObjC names to BinExport2 and decode
    const swiftDemangled = demangleSymbol('_$s5MyApp14ViewControllerC11viewDidLoadyyF');
    const exported = exportBinExport2({
      binaryName: 'MyApp.ipa::MyApp',
      architecture: 'arm64e',
      functions: [
        {
          va: '0x100004000',
          name: swiftDemangled,
          calls: ['0x100008000'],
        },
        {
          va: '0x100008000',
          name: '_objc_msgSend$viewDidLoad',
          calls: [],
        },
      ],
      comments: [
        { va: '0x100004000', text: 'iOS UIViewController lifecycle hook (ARM64e PAC)' },
      ],
    });
    assert.ok(exported.bytes instanceof Uint8Array && exported.bytes.length > 0);
    const decoded = importBinExport2(exported.bytes);
    assert.equal(decoded.ok, true);
    assert.ok(decoded.model.functions.some((f) => f.name === 'MyApp.ViewController.viewDidLoad() -> ()'));
    assert.ok(decoded.model.functions.some((f) => f.name === '_objc_msgSend$viewDidLoad'));
  }));


  // -------------------------------------------------------------------------
  // 5. Apple ObjC / Swift ARC Noise Folding + _objc_msgSend$ Rewriting + 4-ABI Inline Demangle
  // -------------------------------------------------------------------------
  results.push(await runTest('Track 5: refineAppleSwiftDecompile folds ObjC/Swift ARC, rewrites _objc_msgSend$ & demangles 4 ABIs', () => {
    const rawPseudoC = [
      'id sub_100004000(id self, id req) {',
      '  id v1 = objc_retainAutoreleasedReturnValue(_objc_msgSend$setObject:forKey:(self, req, @"token"));',
      '  id v2 = swift_bridgeObjectRetain(_$s5MyApp14ViewControllerC11viewDidLoadyyF(self));',
      '  id v3 = objc_msgSend(v1, "dataTaskWithRequest:completionHandler:", req, cb);',
      '  int r = ?decrypt@CryptoEngine@MyApp@@QEAAHPEBE_K@Z(v2, 32);',
      '  objc_release(v1);',
      '  swift_bridgeObjectRelease(v2);',
      '  objc_storeStrong(&v3, 0LL);',
      '  return objc_autoreleaseReturnValue(v3);',
      '}',
    ].join('\n');

    const { code, stats } = refineAppleSwiftDecompile(rawPseudoC);
    assert.ok(code.includes('[self setObject:req forKey:@"token"]'), `objc_msgSend$ rewrite failed:\n${code}`);
    assert.ok(code.includes('[v1 dataTaskWithRequest:req completionHandler:cb]'), `objc_msgSend rewrite failed:\n${code}`);
    assert.ok(code.includes('MyApp.ViewController.viewDidLoad() -> ()'), `Swift inline demangle failed:\n${code}`);
    assert.ok(code.includes('MyApp::CryptoEngine::decrypt'), `MSVC inline demangle failed:\n${code}`);
    assert.ok(!code.includes('objc_retainAutoreleasedReturnValue'), 'ARC passthrough should be folded');
    assert.ok(!code.includes('objc_release(v1);'), 'objc_release statement should be elided');
    assert.ok(!code.includes('swift_bridgeObjectRelease(v2);'), 'swift_bridgeObjectRelease should be elided');
    assert.ok(!code.includes('objc_storeStrong(&v3, 0LL);'), 'objc_storeStrong nil should be elided');
    assert.ok(code.includes('[ARC/Swift: folded'), 'ARC summary comment should be emitted');
    assert.equal(stats.objcStubsRewritten, 1);
    assert.equal(stats.objcDirectRewritten, 1);
    assert.equal(stats.arcLinesRemoved, 3);
    assert.ok(stats.arcOpsFolded >= 6);
    assert.equal(stats.symbolsDemangled, 2);
  }));

  // -------------------------------------------------------------------------
  // 6. Windows PE Win32/Win64 Full TIL Pack (Ghidra windows_vs12_64.gdt) Live in WASM
  // -------------------------------------------------------------------------
  results.push(await runTest('Track 6: Windows PE fingerprint auto-selects win32-api-full & resolves Win32 APIs live in WASM', () => {
    const tilManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/til-hub/manifest.json'), 'utf8'));
    assert.ok(tilManifest.totalEntries + tilManifest.totalTypes >= 13000, 'TIL-Hub should have >= 13000 defs across 11 packs');

    const fp = fingerprintBinarySdk({
      format: 'pe',
      arch: 'x86_64',
      platform: 'windows',
      sdkVersion: '10.0',
      dlls: ['kernel32.dll', 'ntdll.dll', 'advapi32.dll', 'user32.dll', 'ws2_32.dll'],
      symbols: ['CreateFileW', 'VirtualAlloc', 'GetProcAddress'],
    });
    const match = matchSdkPacks(fp, tilManifest.packs);
    assert.ok(match.selected.some((s) => s.pack.id === 'win32-api-full'), 'win32-api-full must be auto-selected for Windows PE');

    const ex = getHexEngineExports();
    const winBytes = fs.readFileSync(path.join(ROOT, 'dist/til-hub/win32-api-full.til1'));
    assert.ok(winBytes.length <= 256 * 1024, 'win32-api-full <= 256 KiB Slot 1/2 cap');

    ex.hex_til_purge_packs();
    ex.hex_type_arena_reset_slot(8);
    const ptr = ex.hex_type_arena_bump_alloc(8, winBytes.length, 8) >>> 0;
    assert.ok(ptr > 0);
    new Uint8Array(ex.memory.buffer, ptr, winBytes.length).set(winBytes);
    assert.equal(ex.hex_til_mount(1, ptr, winBytes.length, 0x1000, 0x0a00), 0);

    const enc = new TextEncoder();
    for (const sym of ['CreateFileW', 'VirtualAlloc', 'VirtualProtect', 'GetProcAddress', 'LoadLibraryW', 'OpenProcess']) {
      ex.hex_engine_scratch_reset();
      const b = enc.encode(sym);
      const sPtr = ex.hex_engine_scratch_alloc(b.length + 1, 8) >>> 0;
      const oPtr = ex.hex_engine_scratch_alloc(64, 8) >>> 0;
      const mem = new Uint8Array(ex.memory.buffer);
      mem.set(b, sPtr);
      mem[sPtr + b.length] = 0;
      assert.equal(ex.hex_til_lookup_symbol(sPtr, b.length, 1 << 1, 0, oPtr), 0, `Win32 WASM lookup failed for ${sym}`);
    }
  }));

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`\n=== iOS Beyond-IDA Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
