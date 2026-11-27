import test from 'node:test';
import assert from 'node:assert/strict';
import {
  learnVendors,
  vendorsOf,
  vendorOf,
  vendorInText,
  vendorConflicts,
  classFromSymbol,
  swiftModuleOf,
} from '../js/vendors.js';

test('C/C++ third-party libraries are detected accurately', () => {
  const cases = [
    ['boost::filesystem::path', 'Boost', 'library'],
    ['_ZN5boost4asio10io_context3runEv', 'Boost', 'library'],
    ['google::protobuf::MessageLite', 'Protocol Buffers', 'library'],
    ['_ZN6google8protobuf11MessageLite15ParseFromStringEv', 'Protocol Buffers', 'library'],
    ['upb_Message_New', 'Protocol Buffers', 'library'],
    ['_upb_Arena_New', 'Protocol Buffers', 'library'],
    ['libavcodec.59.dylib', 'FFmpeg', 'library'],
    ['avcodec_open2', 'FFmpeg', 'library'],
    ['_avformat_open_input', 'FFmpeg', 'library'],
    ['sws_scale', 'FFmpeg', 'library'],
    ['_swr_convert', 'FFmpeg', 'library'],
    ['swri_rematrix', 'FFmpeg', 'library'],
    ['QtCore', 'Qt', 'library'],
    ['QtGui', 'Qt', 'library'],
    ['QtWidgets', 'Qt', 'library'],
    ['QtNetwork', 'Qt', 'library'],
    ['QtPrivate::QSlotObjectBase', 'Qt', 'library'],
    ['QAbstractItemModel', 'Qt', 'library'],
    ['QCoreApplication', 'Qt', 'library'],
    ['QWidget', 'Qt', 'library'],
    ['QSaveFile', 'Qt', 'library'],
    ['QXmlStreamReader', 'Qt', 'library'],
    ['QIOSViewController', 'Qt', 'library'],
    ['QUIApplicationDelegate', 'Qt', 'library'],
    ['SDL_Init', 'SDL', 'library'],
    ['_SDL_CreateWindow', 'SDL', 'library'],
    ['HIDAPI_Init', 'SDL', 'library'],
    ['_HIDAPI_UpdateDevices', 'SDL', 'library'],
    ['FT_Init_FreeType', 'FreeType', 'library'],
    ['_FTC_Manager_New', 'FreeType', 'library'],
    ['sqlite3_open', 'SQLite', 'library'],
    ['_sqlite3_prepare_v2', 'SQLite', 'library'],
    ['SSL_connect', 'OpenSSL', 'library'],
    ['_EVP_DigestVerifyInit', 'OpenSSL', 'library'],
    ['CRYPTO_malloc', 'OpenSSL', 'library'],
    ['OPENSSL_init_ssl', 'OpenSSL', 'library'],
    ['X509_verify_cert', 'OpenSSL', 'library'],
    ['ASN1_STRING_get0_data', 'OpenSSL', 'library'],
    ['BIO_new_mem_buf', 'OpenSSL', 'library'],
    ['PEM_read_bio_X509', 'OpenSSL', 'library'],
    ['HMAC_Init_ex', 'OpenSSL', 'library'],
    ['OSSL_PROVIDER_load', 'OpenSSL', 'library'],
    ['BORINGSSL_self_test', 'OpenSSL', 'library'],
    ['bssl::SSL_CTX_new', 'OpenSSL', 'library'],
    ['png_create_read_struct', 'libpng', 'library'],
    ['_png_read_info', 'libpng', 'library'],
    ['SkCanvas', 'Skia', 'library'],
    ['SkPaint', 'Skia', 'library'],
    ['SkBitmap', 'Skia', 'library'],
    ['SkImage', 'Skia', 'library'],
    ['SkSurface', 'Skia', 'library'],
    ['SkShader', 'Skia', 'library'],
    ['SkPath', 'Skia', 'library'],
    ['icu::UnicodeString', 'ICU', 'library'],
    ['icu_74::Locale', 'ICU', 'library'],
    ['curl_easy_perform', 'libcurl', 'library'],
    ['_curl_multi_init', 'libcurl', 'library'],
    ['curl_global_init', 'libcurl', 'library'],
    ['grpc_init', 'gRPC', 'library'],
    ['_grpc_channel_create', 'gRPC', 'library'],
    ['grpc::CreateChannel', 'gRPC', 'library'],
    ['double_conversion::DoubleToStringConverter', 'double-conversion', 'library'],
    ['tbb::task_arena', 'TBB', 'library'],
  ];

  for (const [symbol, expectedVendor, expectedKind] of cases) {
    const hit = vendorOf(symbol);
    assert.ok(hit, `expected vendor match for ${symbol}`);
    assert.equal(hit.vendor, expectedVendor, `vendor mismatch for ${symbol}`);
    assert.equal(hit.kind, expectedKind, `kind mismatch for ${symbol}`);
    assert.equal(hit.confidence, 'high', `confidence mismatch for ${symbol}`);
    assert.equal(vendorInText(symbol)?.vendor, expectedVendor, `vendorInText mismatch for ${symbol}`);
  }
});

test('Apple system frameworks are detected via explicit APIs only', () => {
  const cases = [
    ['CFStringCreateWithCString', 'CoreFoundation', 'library'],
    ['_CFRelease', 'CoreFoundation', 'library'],
    ['CFDictionaryGetValue', 'CoreFoundation', 'library'],
    ['CFRunLoopRun', 'CoreFoundation', 'library'],
    ['CFPreferencesCopyAppValue', 'CoreFoundation', 'library'],
    ['CFUUIDCreate', 'CoreFoundation', 'library'],
    ['CFFileDescriptorCreate', 'CoreFoundation', 'library'],
    ['MTLCreateSystemDefaultDevice', null, null],
    ['MTLDevice', 'Metal', 'library'],
    ['_MTLCommandBuffer', 'Metal', 'library'],
    ['MTLRenderPipelineDescriptor', 'Metal', 'library'],
    ['CGContextDrawImage', 'CoreGraphics', 'library'],
    ['_CGBitmapContextCreate', 'CoreGraphics', 'library'],
    ['CGPathAddLineToPoint', 'CoreGraphics', 'library'],
    ['AVAudioEngine', 'AVFoundation', 'library'],
    ['_AVAudioPlayerNode', 'AVFoundation', 'library'],
    ['dispatch_async', 'Darwin Runtime', 'runtime'],
    ['_dispatch_once', 'Darwin Runtime', 'runtime'],
    ['objc_msgSend', 'Darwin Runtime', 'runtime'],
    ['_objc_retainAutoreleasedReturnValue', 'Darwin Runtime', 'runtime'],
    ['pthread_mutex_lock', 'Darwin Runtime', 'runtime'],
    ['_pthread_create', 'Darwin Runtime', 'runtime'],
  ];

  for (const [symbol, expectedVendor, expectedKind] of cases) {
    const hit = vendorOf(symbol);
    if (expectedVendor === null) {
      assert.equal(hit, null, `unexpected vendor match for ${symbol}`);
    } else {
      assert.ok(hit, `expected vendor match for ${symbol}`);
      assert.equal(hit.vendor, expectedVendor, `vendor mismatch for ${symbol}`);
      assert.equal(hit.kind, expectedKind, `kind mismatch for ${symbol}`);
    }
  }
});

test('C++ standard library symbols are never registered as third-party vendors', () => {
  const stdSymbols = [
    'std::vector<int>::push_back',
    'std::__1::basic_string<char>',
    '_ZNSt3__16vectorIiNS_9allocatorIiEEE9push_backERKi',
    '_ZSt9terminatev',
    '__cxa_throw',
    '__cxa_begin_catch',
  ];
  for (const sym of stdSymbols) {
    assert.equal(vendorOf(sym), null, `std/runtime symbol must not be vendor-classified: ${sym}`);
    assert.equal(vendorInText(sym), null, `std/runtime symbol must not match vendorInText: ${sym}`);
  }
});

test('Non-vendor game/app identifiers are never misclassified', () => {
  const nonVendors = [
    'CFaction',
    'CFlag',
    'CFilesystem',
    'CFactory',
    'CFrame',
    'QUIT_GAME',
    'QUICK_SAVE',
    'QUIET',
    'SDLoader',
    'SDLayout',
    'SDList',
    'SDLobby',
    'UIView',
    'UIButton',
    'UIManager',
    'UIHud',
  ];

  // Direct lookup without learned table
  for (const name of nonVendors) {
    assert.equal(vendorOf(name), null, `must not match directly: ${name}`);
  }

  // Lookup with learned table containing CoreFoundation / Qt / SDL symbols
  const learned = learnVendors([
    'CFStringCreate', 'CFArrayCreate', 'CFDictionaryCreate',
    'CFaction', 'CFlag', 'CFilesystem', 'CFactory', 'CFrame',
    'QUIApplicationDelegate', 'QUIWindow', 'QUIConnection',
    'QUIT_GAME', 'QUICK_SAVE', 'QUIET',
    'SDL_Init', 'SDL_CreateWindow', 'SDL_Quit', '_SDL_PollEvent',
    'UIView', 'UIButton', 'UIManager', 'UIHud',
  ]);

  for (const name of nonVendors) {
    assert.equal(vendorOf(name, learned), null, `must not be misclassified after learnVendors: ${name}`);
  }
});

test('prefixesOf prevents SDL_Init from becoming SD -> SDWebImage', () => {
  const learned = learnVendors([
    'SDL_Init',
    'SDL_CreateWindow',
    'SDL_DestroyWindow',
    '_SDL_Quit',
    '_SDL_PollEvent',
  ]);

  assert.equal(learned.prefixes.has('SD'), false, 'SD must not be learned from SDL_* symbols');
  assert.equal(learned.prefixes.has('SDL'), false, 'non-underscore SDL must not be learned from SDL_* symbols');
  assert.equal(learned.prefixes.get('SDL_')?.vendor, 'SDL');
  assert.equal(vendorOf('SDL_Init', learned)?.vendor, 'SDL');
  assert.equal(vendorOf('SDLoader', learned), null);
  assert.equal(vendorOf('SDLayout', learned), null);
  assert.equal(vendorOf('SDLobby', learned), null);
});

test('vendorConflicts preserves GAME_VALUE_GOALS contract for SQLite and OpenSSL', () => {
  const sqlite = vendorOf('sqlite3_open');
  const openssl = vendorOf('SSL_connect');
  const evp = vendorOf('EVP_DigestVerifyInit');

  assert.ok(sqlite && openssl && evp);

  // Non-game-value goals must not be blocked
  assert.equal(vendorConflicts('save', sqlite), false);
  assert.equal(vendorConflicts('network', openssl), false);
  assert.equal(vendorConflicts('anticheat', openssl), false);
  assert.equal(vendorConflicts('anticheat', evp), false);

  // Game value goals still conflict with high-confidence third-party libraries
  assert.equal(vendorConflicts('hp', sqlite), true);
  assert.equal(vendorConflicts('money', openssl), true);
  assert.equal(vendorConflicts('attack', evp), true);
});

test('swiftModuleOf supports _TtC, $s, $S, and _T0 prefixes', () => {
  assert.equal(swiftModuleOf('_TtC12VungleAdsSDK14FirstPartyData'), 'VungleAdsSDK');
  assert.equal(swiftModuleOf('$s12VungleAdsSDK14FirstPartyDataC'), 'VungleAdsSDK');
  assert.equal(swiftModuleOf('_$s10IronSource21ISNHealthCheckFailureC'), 'IronSource');
  assert.equal(swiftModuleOf('$S10IronSource12AdControllerC'), 'IronSource');
  assert.equal(swiftModuleOf('_$S8Firebase3AppC'), 'Firebase');
  assert.equal(swiftModuleOf('_T012VungleAdsSDK14FirstPartyDataC'), 'VungleAdsSDK');
  assert.equal(swiftModuleOf('__T010IronSource4TestC'), 'IronSource');

  assert.equal(swiftModuleOf('$sSS'), null);
  assert.equal(swiftModuleOf('$s99TooShort'), null);
  assert.equal(swiftModuleOf('BattleManager'), null);
  assert.equal(swiftModuleOf(null), null);

  // End-to-end Swift module learning with $s symbols
  const learned = learnVendors([
    '$s10IronSource12AdControllerC',
    '$s10IronSource14BannerRendererC',
    '$s10IronSource15RewardedManagerC',
    '$s10IronSource16MetricsCollectorC',
  ]);
  assert.equal(vendorOf('$s10IronSource14BannerRendererC', learned)?.vendor, 'IronSource');
});

test('classFromSymbol extracts Objective-C, demangled C++, and Itanium _ZN owners', () => {
  assert.equal(classFromSymbol('-[BattleManager hp]'), 'BattleManager');
  assert.equal(classFromSymbol('+[NSObject alloc]'), 'NSObject');

  assert.equal(classFromSymbol('ns::Cls::fn'), 'ns::Cls');
  assert.equal(classFromSymbol('ns::Cls::fn(int, char const*)'), 'ns::Cls');
  assert.equal(classFromSymbol('void ns::Cls::fn() const'), 'ns::Cls');
  assert.equal(classFromSymbol('std::string ns::Cls::name() const'), 'ns::Cls');
  assert.equal(classFromSymbol('ns::Cls::operator()(int)'), 'ns::Cls');
  assert.equal(classFromSymbol('ns::Cls<int, Foo::Bar>::fn()'), 'ns::Cls<int, Foo::Bar>');
  assert.equal(classFromSymbol('BattleManager::takeDamage(int)'), 'BattleManager');

  assert.equal(classFromSymbol('_ZN2ns3Cls2fnEv'), 'ns::Cls');
  assert.equal(classFromSymbol('__ZN2ns3Cls2fnEv'), 'ns::Cls');
  assert.equal(classFromSymbol('_ZNK2ns3Cls2fnEv'), 'ns::Cls');
  assert.equal(classFromSymbol('_ZN5boost4asio10io_context3runEv'), 'boost::asio::io_context');
  assert.equal(classFromSymbol('_ZN6google8protobuf11MessageLite15ParseFromStringEv'), 'google::protobuf::MessageLite');
  assert.equal(classFromSymbol('_ZN7QWidget4showEv'), 'QWidget');
  assert.equal(classFromSymbol('_ZN7QWidgetC1EP7QWidget'), 'QWidget');
  assert.equal(classFromSymbol('_ZN2ns3ClsD1Ev'), 'ns::Cls');
  assert.equal(classFromSymbol('_ZN2ns3ClsIiE2fnEv'), 'ns::Cls');
  assert.equal(classFromSymbol('_ZN2ns3ClsB5cxx112fnEv'), 'ns::Cls');
  assert.equal(classFromSymbol('_ZNSt3__16vectorIiNS_9allocatorIiEEE9push_backERKi'), 'std::__1::vector');

  assert.equal(classFromSymbol('_Z3foov'), null);
  assert.equal(classFromSymbol('plainFunction'), null);
  assert.equal(classFromSymbol(null), null);
});

test('vendorsOf extracts Symbol-keyed C++ classes via v.name', () => {
  const sym1 = Symbol('cxx:QWidget');
  const sym2 = Symbol('cxx:QIOSViewController');
  const sym3 = Symbol('cxx:QIOSAppDelegate');
  const sym4 = Symbol('cxx:QIOSWindow');
  const sym5 = Symbol('cxx:PlayerData');

  const fields = {
    classes: new Map([
      [sym1, { name: 'QWidget' }],
      [sym2, { name: 'QIOSViewController' }],
      [sym3, { name: 'QIOSAppDelegate' }],
      [sym4, { name: 'QIOSWindow' }],
      [sym5, { name: 'PlayerData' }],
      ['GADBannerView', { name: 'GADBannerView' }],
      ['GADRequest', {}],
      ['GADAdLoader', null],
    ]),
  };

  const learned = vendorsOf(fields);
  assert.ok(learned);
  assert.equal(learned.prefixes.get('QIOS')?.vendor, 'Qt');
  assert.equal(learned.prefixes.get('GAD')?.vendor, 'Google Mobile Ads');
  assert.equal(vendorOf('QIOSOtherClass', learned)?.vendor, 'Qt');
  assert.equal(vendorOf('PlayerData', learned), null);
});

test('learnVendors suppresses auto-promotion of unregistered 2-char prefixes during matchPattern seeding', () => {
  const learned = learnVendors([
    'CFStringCreate',
    'CFArrayCreate',
    'CFDictionaryCreate',
    'CFaction',
    'CFlag',
    'FT_Init_FreeType',
    'FT_Load_Glyph',
    'FT_Done_Face',
    'FTHelper',
    'QUIWindow',
    'QUIConnection',
    'QUIApplicationDelegate',
    'QUHelper',
  ]);

  assert.equal(learned.prefixes.has('CF'), false, 'unregistered 2-char CF must not be auto-promoted');
  assert.equal(learned.prefixes.has('FT'), false, 'unregistered 2-char FT must not be auto-promoted');
  assert.equal(learned.prefixes.has('FT_'), false, 'unregistered 2-char FT_ must not be auto-promoted');
  assert.equal(learned.prefixes.has('QU'), false, 'unregistered 2-char QU must not be auto-promoted');
  assert.equal(learned.prefixes.get('QUI')?.vendor, 'Qt', '3-char QUI is allowed to seed');
  assert.equal(vendorOf('CFaction', learned), null);
  assert.equal(vendorOf('FTHelper', learned), null);
  assert.equal(vendorOf('QUHelper', learned), null);

  // Registered 2-char prefixes from VENDOR_PREFIXES still work normally
  const registered = learnVendors(['ISBannerAdapter', 'ISBaseAdUnit', 'ISConfig']);
  assert.equal(registered.prefixes.get('IS')?.vendor, 'IronSource');
});
