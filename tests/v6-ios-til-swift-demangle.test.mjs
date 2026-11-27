/**
 * Track B Test Suite: iOS Core TIL Dictionary Expansion + Deterministic Swift 5 Symbol Demangler.
 */

import assert from 'node:assert/strict';

import {
  CORE_TIL_FUNCTIONS,
  CORE_TIL_SELECTORS,
  FMT_FAMILY,
  getCoreTilIr,
  formatHexTypeId,
} from '../js/analysis/types/core/til-lite-data.js';
import {
  TIL1_CORE_MAX_BYTES,
  compileTil1,
  validateTil1Buffer,
} from '../js/analysis/types/core/til-binary-compiler.js';
import { TilLiteResolver } from '../js/analysis/types/core/til-lite-resolver.js';
import {
  DEMANGLE_KIND,
  detectMangleKind,
  demangleSymbol,
  demangleSymbolJsFallback,
} from '../js/analysis/types/core/symbol-demangler.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(err);
  }
}

console.log('=== Track B: iOS Core TIL & Swift 5 Demangler Test Suite ===');

// ---------------------------------------------------------------------------
// 1. Core TIL1 size budget, uniqueness & validation
// ---------------------------------------------------------------------------
await test('Core TIL1 compiles within <= 160 KiB budget with zero duplicate functions or selectors', () => {
  const fnNames = CORE_TIL_FUNCTIONS.map((f) => f.name);
  const fnSet = new Set(fnNames);
  assert.equal(fnSet.size, fnNames.length, 'Duplicate function names detected in CORE_TIL_FUNCTIONS');

  const selNames = CORE_TIL_SELECTORS.map((s) => s.name);
  const selSet = new Set(selNames);
  assert.equal(selSet.size, selNames.length, 'Duplicate selector names detected in CORE_TIL_SELECTORS');

  const coreIr = getCoreTilIr();
  const coreBytes = compileTil1(coreIr);
  assert.ok(
    coreBytes.byteLength <= TIL1_CORE_MAX_BYTES,
    `Core TIL1 size ${coreBytes.byteLength} B exceeds limit ${TIL1_CORE_MAX_BYTES} B`
  );
  const val = validateTil1Buffer(coreBytes);
  assert.equal(val.ok, true, val.error);
});

// ---------------------------------------------------------------------------
// 2. iOS CoreFoundation / Dispatch / ObjC / Swift / UIKit / CG / Security / Darwin resolution
// ---------------------------------------------------------------------------
await test('TilLiteResolver resolves CoreFoundation, Dispatch (GCD), ObjC, Swift, UIKit, CG, Security, Darwin symbols', () => {
  const resolver = new TilLiteResolver();

  const expectedFunctions = [
    // CoreFoundation
    ['_CFArrayGetCount', 'CFArrayGetCount', 1],
    ['_CFArrayGetValueAtIndex', 'CFArrayGetValueAtIndex', 2],
    ['_CFArrayCreate', 'CFArrayCreate', 4],
    ['_CFDictionaryGetValue', 'CFDictionaryGetValue', 2],
    ['_CFDictionaryCreate', 'CFDictionaryCreate', 6],
    ['_CFDataGetBytePtr', 'CFDataGetBytePtr', 1],
    ['_CFDataGetLength', 'CFDataGetLength', 1],
    ['_CFDataCreate', 'CFDataCreate', 3],
    ['_CFStringGetLength', 'CFStringGetLength', 1],
    ['_CFStringGetCString', 'CFStringGetCString', 4],
    ['_CFStringCreateWithBytes', 'CFStringCreateWithBytes', 5],
    ['_CFNumberGetValue', 'CFNumberGetValue', 3],
    ['_CFNumberCreate', 'CFNumberCreate', 3],
    ['_CFURLCreateWithString', 'CFURLCreateWithString', 3],
    ['_CFBundleGetMainBundle', 'CFBundleGetMainBundle', 0],
    ['_CFBundleGetInfoDictionary', 'CFBundleGetInfoDictionary', 1],
    ['_CFPreferencesCopyAppValue', 'CFPreferencesCopyAppValue', 2],
    ['_CFRunLoopGetMain', 'CFRunLoopGetMain', 0],
    ['_CFRunLoopGetCurrent', 'CFRunLoopGetCurrent', 0],
    ['_CFUUIDCreate', 'CFUUIDCreate', 1],
    ['_CFUUIDCreateString', 'CFUUIDCreateString', 2],

    // Dispatch (GCD)
    ['_dispatch_async', 'dispatch_async', 2],
    ['_dispatch_sync', 'dispatch_sync', 2],
    ['_dispatch_after', 'dispatch_after', 3],
    ['_dispatch_once', 'dispatch_once', 2],
    ['_dispatch_queue_create', 'dispatch_queue_create', 2],
    ['_dispatch_get_global_queue', 'dispatch_get_global_queue', 2],
    ['_dispatch_semaphore_create', 'dispatch_semaphore_create', 1],
    ['_dispatch_semaphore_wait', 'dispatch_semaphore_wait', 2],
    ['_dispatch_semaphore_signal', 'dispatch_semaphore_signal', 1],
    ['_dispatch_group_create', 'dispatch_group_create', 0],
    ['_dispatch_group_enter', 'dispatch_group_enter', 1],
    ['_dispatch_group_leave', 'dispatch_group_leave', 1],
    ['_dispatch_group_notify', 'dispatch_group_notify', 3],
    ['_dispatch_time', 'dispatch_time', 2],

    // ObjC Runtime
    ['_objc_msgSendSuper2', 'objc_msgSendSuper2', 2],
    ['_objc_retain', 'objc_retain', 1],
    ['_objc_release', 'objc_release', 1],
    ['_objc_autorelease', 'objc_autorelease', 1],
    ['_objc_autoreleaseReturnValue', 'objc_autoreleaseReturnValue', 1],
    ['_objc_retainAutoreleasedReturnValue', 'objc_retainAutoreleasedReturnValue', 1],
    ['_objc_autoreleasePoolPush', 'objc_autoreleasePoolPush', 0],
    ['_objc_autoreleasePoolPop', 'objc_autoreleasePoolPop', 1],
    ['_objc_storeStrong', 'objc_storeStrong', 2],
    ['_objc_destroyWeak', 'objc_destroyWeak', 1],
    ['_objc_loadWeakRetained', 'objc_loadWeakRetained', 1],
    ['_objc_initWeak', 'objc_initWeak', 2],
    ['_objc_copyWeak', 'objc_copyWeak', 2],
    ['_objc_moveWeak', 'objc_moveWeak', 2],
    ['_objc_allocateClassPair', 'objc_allocateClassPair', 3],
    ['_objc_registerClassPair', 'objc_registerClassPair', 1],
    ['_objc_getClass', 'objc_getClass', 1],
    ['_objc_lookUpClass', 'objc_lookUpClass', 1],
    ['_objc_getProtocol', 'objc_getProtocol', 1],
    ['_objc_setAssociatedObject', 'objc_setAssociatedObject', 4],
    ['_objc_getAssociatedObject', 'objc_getAssociatedObject', 2],
    ['_class_getInstanceMethod', 'class_getInstanceMethod', 2],
    ['_class_getClassMethod', 'class_getClassMethod', 2],
    ['_class_addMethod', 'class_addMethod', 4],
    ['_class_replaceMethod', 'class_replaceMethod', 4],
    ['_method_exchangeImplementations', 'method_exchangeImplementations', 2],
    ['_sel_registerName', 'sel_registerName', 1],
    ['_sel_getName', 'sel_getName', 1],
    ['_object_getClass', 'object_getClass', 1],

    // Swift Runtime
    ['_swift_allocObject', 'swift_allocObject', 3],
    ['_swift_deallocObject', 'swift_deallocObject', 3],
    ['_swift_retain', 'swift_retain', 1],
    ['_swift_release', 'swift_release', 1],
    ['_swift_bridgeObjectRetain', 'swift_bridgeObjectRetain', 1],
    ['_swift_bridgeObjectRelease', 'swift_bridgeObjectRelease', 1],
    ['_swift_unknownObjectRetain', 'swift_unknownObjectRetain', 1],
    ['_swift_unknownObjectRelease', 'swift_unknownObjectRelease', 1],
    ['_swift_beginAccess', 'swift_beginAccess', 4],
    ['_swift_endAccess', 'swift_endAccess', 1],
    ['_swift_once', 'swift_once', 3],
    ['_swift_dynamicCast', 'swift_dynamicCast', 5],
    ['_swift_getWitnessTable', 'swift_getWitnessTable', 3],
    ['_swift_getGenericMetadata', 'swift_getGenericMetadata', 3],
    ['_swift_getTypeByMangledNameInContext', 'swift_getTypeByMangledNameInContext', 4],
    ['_swift_errorRetain', 'swift_errorRetain', 1],
    ['_swift_errorRelease', 'swift_errorRelease', 1],
    ['_swift_willThrow', 'swift_willThrow', 1],
    ['_swift_slowAlloc', 'swift_slowAlloc', 2],
    ['_swift_slowDealloc', 'swift_slowDealloc', 3],
    ['_swift_isUniquelyReferenced_nonNull_native', 'swift_isUniquelyReferenced_nonNull_native', 1],

    // UIKit / CoreGraphics / Security / Darwin
    ['_UIApplicationMain', 'UIApplicationMain', 4],
    ['_UIGraphicsBeginImageContextWithOptions', 'UIGraphicsBeginImageContextWithOptions', 3],
    ['_UIGraphicsEndImageContext', 'UIGraphicsEndImageContext', 0],
    ['_UIGraphicsGetCurrentContext', 'UIGraphicsGetCurrentContext', 0],
    ['_CGContextDrawImage', 'CGContextDrawImage', 3],
    ['_CGContextFillRect', 'CGContextFillRect', 2],
    ['_CGImageGetWidth', 'CGImageGetWidth', 1],
    ['_CGImageGetHeight', 'CGImageGetHeight', 1],
    ['_CGImageRelease', 'CGImageRelease', 1],
    ['_CGColorSpaceCreateDeviceRGB', 'CGColorSpaceCreateDeviceRGB', 0],
    ['_SecItemCopyMatching', 'SecItemCopyMatching', 2],
    ['_SecItemAdd', 'SecItemAdd', 2],
    ['_SecItemUpdate', 'SecItemUpdate', 2],
    ['_SecItemDelete', 'SecItemDelete', 1],
    ['_SecRandomCopyBytes', 'SecRandomCopyBytes', 3],
    ['_CC_SHA256', 'CC_SHA256', 3],
    ['_CC_SHA1', 'CC_SHA1', 3],
    ['_CC_MD5', 'CC_MD5', 3],
    ['_CCCrypt', 'CCCrypt', 11],
    ['_os_log_type_enabled', 'os_log_type_enabled', 2],
    ['__os_log_impl', '_os_log_impl', 6],
    ['_dlopen', 'dlopen', 2],
    ['_dlsym', 'dlsym', 2],
    ['_dlclose', 'dlclose', 1],
    ['_mach_absolute_time', 'mach_absolute_time', 0],
    ['_mach_timebase_info', 'mach_timebase_info', 1],
    ['_sysctlbyname', 'sysctlbyname', 5],
    ['_arc4random', 'arc4random', 0],
    ['_arc4random_uniform', 'arc4random_uniform', 1],
  ];

  for (const [rawSym, matchedName, arity] of expectedFunctions) {
    const hit = resolver.resolveSymbol(rawSym);
    assert.ok(hit, `Failed to resolve ${rawSym}`);
    assert.equal(hit.matchedName, matchedName, `Matched name mismatch for ${rawSym}`);
    assert.equal(hit.arity, arity, `Arity mismatch for ${rawSym}`);
  }

  // Verify rich Apple/Swift return type formatting
  const secHit = resolver.resolveSymbol('_SecItemCopyMatching');
  assert.equal(formatHexTypeId(secHit.retHexType), 'OSStatus');
  const cgCtxHit = resolver.resolveSymbol('_UIGraphicsGetCurrentContext');
  assert.equal(formatHexTypeId(cgCtxHit.retHexType), 'CGContextRef');
  const swiftAllocHit = resolver.resolveSymbol('_swift_allocObject');
  assert.equal(formatHexTypeId(swiftAllocHit.retHexType), 'SwiftHeapObject*');
});

await test('TilLiteResolver resolves expanded iOS ObjC selectors and msgSend stubs', () => {
  const resolver = new TilLiteResolver();

  const selCases = [
    ['-[UIView initWithFrame:]', '-UIView:initWithFrame:', 3],
    ['_objc_msgSend$initWithFrame:', '*:initWithFrame:', 3],
    ['-[UIViewController viewDidLoad]', '-UIViewController:viewDidLoad', 2],
    ['_objc_msgSend$viewDidLoad', '*:viewDidLoad', 2],
    ['_objc_msgSend$objectForKey:', '*:objectForKey:', 3],
    ['_objc_msgSend$setObject:forKey:', '*:setObject:forKey:', 4],
    ['_objc_msgSend$stringWithFormat:', '*:stringWithFormat:', 3],
    ['_objc_msgSend$dataWithBytes:length:', '*:dataWithBytes:length:', 4],
    ['_objc_msgSend$bytes', '*:bytes', 2],
    ['_objc_msgSend$length', '*:length', 2],
    ['_objc_msgSend$count', '*:count', 2],
    ['_objc_msgSend$objectAtIndex:', '*:objectAtIndex:', 3],
    ['-[NSMutableArray addObject:]', '-NSMutableArray:addObject:', 3],
    ['+[UIApplication sharedApplication]', '+UIApplication:sharedApplication', 2],
    ['+[NSNotificationCenter defaultCenter]', '+NSNotificationCenter:defaultCenter', 2],
    ['-[NSNotificationCenter addObserver:selector:name:object:]', '-NSNotificationCenter:addObserver:selector:name:object:', 6],
    ['-[NSNotificationCenter postNotificationName:object:]', '-NSNotificationCenter:postNotificationName:object:', 4],
    ['+[NSUserDefaults standardUserDefaults]', '+NSUserDefaults:standardUserDefaults', 2],
    ['+[NSURL URLWithString:]', '+NSURL:URLWithString:', 3],
    ['_objc_msgSend$UTF8String', '*:UTF8String', 2],
    ['_objc_msgSend$isEqualToString:', '*:isEqualToString:', 3],
    ['-[NSObject copy]', '-NSObject:copy', 2],
    ['-[NSObject mutableCopy]', '-NSObject:mutableCopy', 2],
    ['_objc_msgSend$description', '*:description', 2],
  ];

  for (const [sym, expectedMatched, expectedArity] of selCases) {
    const hit = resolver.resolveSymbol(sym);
    assert.ok(hit, `Failed to resolve ObjC selector ${sym}`);
    assert.equal(hit.matchedName, expectedMatched, `Selector mismatch for ${sym}`);
    assert.equal(hit.arity, expectedArity, `Selector arity mismatch for ${sym}`);
  }

  const fmtStub = resolver.resolveSymbol('_objc_msgSend$stringWithFormat:');
  assert.equal(fmtStub.formatFamily, FMT_FAMILY.NSLOG);
});

// ---------------------------------------------------------------------------
// 3. Swift 5 Symbol Detection & Demangling (Normal Cases)
// ---------------------------------------------------------------------------
await test('detectMangleKind identifies Swift 5 prefixes (_$s, $s, _$S, $S) without breaking C++/Rust', () => {
  assert.equal(DEMANGLE_KIND.SWIFT, 4);

  assert.equal(detectMangleKind('_$s10Foundation4DataV'), DEMANGLE_KIND.SWIFT);
  assert.equal(detectMangleKind('$s10Foundation4DataV'), DEMANGLE_KIND.SWIFT);
  assert.equal(detectMangleKind('_$S5MyApp12PlayerStatusC'), DEMANGLE_KIND.SWIFT);
  assert.equal(detectMangleKind('$S5MyApp12PlayerStatusC'), DEMANGLE_KIND.SWIFT);

  // Non-regression for C++ Itanium, Rust v0, Rust legacy, plain C
  assert.equal(detectMangleKind('_ZN5Unity6Player4HealEf'), DEMANGLE_KIND.ITANIUM_CPP);
  assert.equal(detectMangleKind('__ZN5Unity6Player4HealEf'), DEMANGLE_KIND.ITANIUM_CPP);
  assert.equal(detectMangleKind('_RNvNtCs6kQ4x2a1_4core3fmt5write'), DEMANGLE_KIND.RUST_V0);
  assert.equal(
    detectMangleKind('_ZN4core3ptr42drop_in_place$LT$alloc..string..String$GT$17h0123456789abcdefE'),
    DEMANGLE_KIND.RUST_LEGACY
  );
  assert.equal(detectMangleKind('printf'), DEMANGLE_KIND.NONE);
  assert.equal(detectMangleKind('$s'), DEMANGLE_KIND.NONE);
});

await test('Swift 5 demangler restores structs, classes, enums, protocols, methods, properties, inits, deinits & metadata', () => {
  const cases = [
    // Nominal types (V/C/O/P) & stdlib 's'
    ['_$s10Foundation4DataV', 'Foundation.Data'],
    ['$s10Foundation4DataV', 'Foundation.Data'],
    ['_$S5MyApp12PlayerStatusC', 'MyApp.PlayerStatus'],
    ['$S5MyApp10GameEngineC5StateO', 'MyApp.GameEngine.State'],
    ['_$s5MyApp10DamageableP', 'MyApp.Damageable'],
    ['_$ss5ArrayV', 'Swift.Array'],

    // Methods & functions (F / FZ / throws K / labels / stdlib shortcuts)
    ['_$s5MyApp12PlayerStatusC6takeHpyySiF', 'MyApp.PlayerStatus.takeHp(Swift.Int) -> ()'],
    ['_$s5MyApp12PlayerStatusC5getHpSiyF', 'MyApp.PlayerStatus.getHp() -> Swift.Int'],
    ['_$s5MyApp12PlayerStatusC5resetyyF', 'MyApp.PlayerStatus.reset() -> ()'],
    ['_$s5MyApp12PlayerStatusC6attack6amount_ySiF', 'MyApp.PlayerStatus.attack(amount: Swift.Int) -> ()'],
    ['_$s5MyApp3add1a1b_S2i_SitF', 'MyApp.add(a: Swift.Int, b: Swift.Int) -> Swift.Int'],
    ['_$s5MyApp6LoaderC4loadySSSiKF', 'MyApp.Loader.load(Swift.Int) throws -> Swift.String'],
    ['_$s5MyApp4MathV3absySdSdFZ', 'static MyApp.Math.abs(Swift.Double) -> Swift.Double'],
    ['_$s5MyApp4UtilV6formatySSSf_Sb_SutF', 'MyApp.Util.format(Swift.Float, Swift.Bool, Swift.UInt) -> Swift.String'],

    // Generics & Optional stdlib codes (Sa, SD, Sq, Sg)
    ['_$s5MyApp3BagC5itemsSaySiGvg', 'MyApp.Bag.items.getter : Swift.Array<Swift.Int>'],
    ['_$s5MyApp3BagC6scoresSDySSSiGvg', 'MyApp.Bag.scores.getter : Swift.Dictionary<Swift.String, Swift.Int>'],
    ['_$s5MyApp3BagC5labelSSSgvg', 'MyApp.Bag.label.getter : Swift.Optional<Swift.String>'],
    ['_$s5MyApp3BagC5maybeSqvg', 'MyApp.Bag.maybe.getter : Swift.Optional'],

    // Property / getter / setter / modify
    ['_$s5MyApp12PlayerStatusC2hpSivg', 'MyApp.PlayerStatus.hp.getter : Swift.Int'],
    ['_$s5MyApp12PlayerStatusC2hpSivs', 'MyApp.PlayerStatus.hp.setter : Swift.Int'],
    ['_$s5MyApp12PlayerStatusC2hpSivM', 'MyApp.PlayerStatus.hp.modify : Swift.Int'],
    ['_$s5MyApp12PlayerStatusC2hpSivp', 'MyApp.PlayerStatus.hp : Swift.Int'],

    // Initializers & Deinitializers (fC / fc / fd / fD)
    ['_$s5MyApp12PlayerStatusCACycfC', 'MyApp.PlayerStatus.__allocating_init()'],
    ['_$s5MyApp12PlayerStatusCACycfc', 'MyApp.PlayerStatus.init()'],
    ['_$s5MyApp12PlayerStatusC2hp_ACSi_tcfC', 'MyApp.PlayerStatus.__allocating_init(hp: Swift.Int)'],
    ['_$s5MyApp12PlayerStatusCfd', 'MyApp.PlayerStatus.deinit'],
    ['_$s5MyApp12PlayerStatusCfD', 'MyApp.PlayerStatus.__deallocating_deinit'],

    // Metadata accessors, nominal descriptors & witness tables (Ma / Mn / Ml / WP)
    ['_$s10Foundation4DataVMa', 'type metadata accessor for Foundation.Data'],
    ['_$s5MyApp12PlayerStatusCMn', 'nominal type descriptor for MyApp.PlayerStatus'],
    ['_$s5MyApp12PlayerStatusCMl', 'lazy protocol witness table accessor for MyApp.PlayerStatus'],
    ['_$s5MyApp12PlayerStatusCWP', 'protocol witness table for MyApp.PlayerStatus'],
    ['_$s5MyApp12PlayerStatusCAA10DamageablePWP', 'protocol witness table for MyApp.PlayerStatus : MyApp.Damageable'],
    ['_$s10Foundation4DataV5MyApp10DamageablePWP', 'protocol witness table for Foundation.Data : MyApp.Damageable'],
  ];

  for (const [mangled, expected] of cases) {
    assert.equal(demangleSymbol(mangled), expected, `demangleSymbol mismatch for ${mangled}`);
    assert.equal(demangleSymbolJsFallback(mangled), expected, `JS fallback mismatch for ${mangled}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Swift 5 Malformed / DoS-Hardening & C++/Rust Non-Regression Tests
// ---------------------------------------------------------------------------
await test('Swift 5 demangler safely rejects malformed, zero-length, oversized & deeply nested DoS inputs', () => {
  // Empty / prefix-only / invalid characters
  assert.equal(demangleSymbol('_$s'), null);
  assert.equal(demangleSymbol('_$S'), null);
  assert.equal(demangleSymbol('_$s!!!!'), null);
  assert.equal(demangleSymbol('_$s5MyApp'), null); // incomplete: no nominal tag or member

  // Zero-length & out-of-bounds length prefixes
  assert.equal(demangleSymbol('_$s0'), null);
  assert.equal(demangleSymbol('_$s0V'), null);
  assert.equal(demangleSymbol('_$s5MyApp0V'), null);
  assert.equal(demangleSymbol('_$s999999fooV'), null);
  assert.equal(demangleSymbol('_$s10Foundation999DataV'), null);

  // Oversized input (> 2048 bytes)
  const huge = '_$s' + '1a'.repeat(1200) + 'V';
  assert.ok(huge.length > 2048);
  assert.equal(demangleSymbol(huge), null);

  // Deeply nested generic DoS (> MAX_SWIFT_DEPTH)
  const deepGeneric = '_$s5MyApp1XV1x' + 'Say'.repeat(80) + 'Si' + 'G'.repeat(80) + 'vg';
  const t0 = Date.now();
  assert.equal(demangleSymbol(deepGeneric), null);
  assert.ok(Date.now() - t0 < 200, 'Deep generic input took too long');

  // Repeated postfix Optional DoS (> MAX_SWIFT_STEPS)
  const manyOpt = '_$s5MyApp1XV1xSi' + 'Sg'.repeat(600) + 'vg';
  assert.equal(demangleSymbol(manyOpt), null);

  // C++ Itanium / Rust v0 / Rust Legacy JS fallback non-regression
  assert.equal(demangleSymbol('__ZN5Unity6Player4HealEf', { _engine: 'js' }), 'Unity::Player::Heal(float)');
  assert.equal(demangleSymbol('_RNvNtCs6kQ4x2a1_4core3fmt5write', { _engine: 'js' }), 'core::fmt::write');
  assert.equal(
    demangleSymbol('_ZN4core3ptr42drop_in_place$LT$alloc..string..String$GT$17h0123456789abcdefE', { _engine: 'js' }),
    'core::ptr::drop_in_place<alloc::string::String>'
  );
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
