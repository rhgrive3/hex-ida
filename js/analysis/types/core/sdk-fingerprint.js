/**
 * Binary SDK Fingerprinter for Mach-O, ELF, and PE images.
 * Extracts platform, arch, SDK/OS version, libc/runtime, linked dylibs/DT_NEEDED,
 * LC_BUILD_VERSION, and engine/OSS library hints (iOS, macOS, Android NDK, glibc, musl, Unity, Unreal, OpenSSL, SQLite).
 * Spec: hex_ida_beyond_ida_design.md §18.2
 * INV-005: ZERO imports from js/targets/architecture/.
 */

import { fnv1a32 } from './til-binary-compiler.js';

// Mach-O LC_BUILD_VERSION platform codes
export const MACHO_PLATFORM = Object.freeze({
  1: 'macos',
  2: 'ios',
  3: 'tvos',
  4: 'watchos',
  5: 'bridgeos',
  6: 'mac-catalyst',
  7: 'ios-simulator',
  8: 'tvos-simulator',
  9: 'watchos-simulator',
  10: 'driverkit',
  11: 'visionos',
  12: 'visionos-simulator',
});

function decodePackedMachoVersion(v) {
  if (typeof v === 'string') return v;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return '';
  const major = (v >>> 16) & 0xFFFF;
  const minor = (v >>> 8) & 0xFF;
  const patch = v & 0xFF;
  return patch ? `${major}.${minor}.${patch}` : `${major}.${minor}`;
}

function normalizePlatform(raw) {
  if (typeof raw === 'number' && MACHO_PLATFORM[raw]) {
    return MACHO_PLATFORM[raw];
  }
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return 'unknown';
  if (s.includes('iphone') || s.includes('ios')) return s.includes('sim') ? 'ios-simulator' : 'ios';
  if (s.includes('macos') || s.includes('macosx') || s.includes('darwin')) return 'macos';
  if (s.includes('android') || s.includes('bionic')) return 'android';
  if (s.includes('linux')) return 'linux';
  if (s.includes('win')) return 'windows';
  return s;
}

function extractDylibBasename(pathStr) {
  const s = String(pathStr || '').trim();
  if (!s) return '';
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

function detectHintsFromCorpus(dylibs, symbols, strings, notes) {
  const hints = new Set();
  const joinedLibs = dylibs.join('\n').toLowerCase();
  const joinedSyms = symbols.join('\n');
  const joinedStrs = strings.join('\n');
  const joinedNotes = notes.join('\n').toLowerCase();

  // Apple Frameworks & Runtime
  if (joinedLibs.includes('uikit') || joinedLibs.includes('/system/library/frameworks/uikit')) hints.add('uikit');
  if (joinedLibs.includes('appkit') || joinedLibs.includes('/system/library/frameworks/appkit')) hints.add('appkit');
  if (joinedLibs.includes('foundation')) hints.add('foundation');
  if (joinedLibs.includes('corefoundation')) hints.add('corefoundation');
  if (joinedLibs.includes('libobjc') || joinedSyms.includes('objc_msgSend')) hints.add('objc');
  if (joinedLibs.includes('libswiftcore') || joinedSyms.includes('$s') || joinedSyms.includes('_$s')) hints.add('swift');
  if (joinedLibs.includes('libsystem')) hints.add('libsystem');

  // C/C++ Runtimes
  if (joinedLibs.includes('libc.so') || joinedLibs.includes('glibc') || joinedNotes.includes('gnu')) {
    if (!joinedLibs.includes('musl') && !joinedNotes.includes('android')) hints.add('glibc');
  }
  if (joinedLibs.includes('ld-musl') || joinedLibs.includes('musl')) hints.add('musl');
  if (joinedLibs.includes('liblog.so') || joinedLibs.includes('libandroid.so') || joinedNotes.includes('android')) {
    hints.add('android-ndk');
    hints.add('bionic');
  }
  if (joinedLibs.includes('libc++.1.dylib') || joinedLibs.includes('libc++_shared.so') || joinedSyms.includes('_ZNSt3__1')) {
    hints.add('libcxx');
  }
  if (joinedLibs.includes('libstdc++.so') || joinedSyms.includes('_ZNSt7__cxx11')) {
    hints.add('libstdcxx');
  }

  // Game Engines
  if (
    joinedSyms.includes('il2cpp_init') ||
    joinedSyms.includes('il2cpp_domain_get') ||
    joinedStrs.includes('global-metadata.dat') ||
    joinedStrs.includes('UnityEngine')
  ) {
    hints.add('unity-il2cpp');
  }
  if (
    joinedSyms.includes('FName::') ||
    joinedSyms.includes('UObject::') ||
    joinedStrs.includes('UnrealEngine') ||
    joinedStrs.includes('UE4') ||
    joinedStrs.includes('UE5')
  ) {
    hints.add('unreal');
  }
  if (joinedStrs.includes('cocos2d') || joinedSyms.includes('cocos2d')) {
    hints.add('cocos2d');
  }

  // Major OSS Libraries
  if (joinedLibs.includes('libssl') || joinedLibs.includes('libcrypto') || joinedSyms.includes('SSL_CTX_new') || joinedSyms.includes('EVP_DigestInit')) {
    hints.add('openssl');
  }
  if (joinedStrs.includes('BoringSSL') || joinedSyms.includes('BORINGSSL_')) {
    hints.add('boringssl');
  }
  if (joinedLibs.includes('libsqlite3') || joinedSyms.includes('sqlite3_open') || joinedSyms.includes('sqlite3_prepare_v2')) {
    hints.add('sqlite');
  }
  if (joinedLibs.includes('libcurl') || joinedSyms.includes('curl_easy_init')) {
    hints.add('curl');
  }
  if (joinedLibs.includes('libavcodec') || joinedLibs.includes('libavformat') || joinedSyms.includes('avcodec_open2')) {
    hints.add('ffmpeg');
  }
  if (joinedSyms.includes('google::protobuf') || joinedStrs.includes('protobuf')) {
    hints.add('protobuf');
  }
  if (joinedLibs.includes('libz.') || joinedLibs.includes('libz.so') || joinedSyms.includes('inflateInit2_')) {
    hints.add('zlib');
  }

  return Array.from(hints).sort();
}

/**
 * Fingerprints a binary image's metadata (Mach-O, ELF, or PE) into a deterministic
 * BinarySdkFingerprint object for sdk-matcher.js.
 */
export function fingerprintBinarySdk(input = {}) {
  const format = String(input.format || '').toLowerCase() ||
    (input.loadCommands || input.buildVersion || input.dylibs || input.libraries || input.metadata?.loadCommands ? 'macho'
      : input.dtNeeded || input.ptInterp || input.elfNotes ? 'elf'
        : input.dlls ? 'pe' : 'unknown');

  const arch = String(input.arch || 'arm64').toLowerCase();
  const dylibs = [];
  const dylibVersions = {};
  const notes = [];
  let platform = normalizePlatform(input.platform || '');
  let sdkVersion = '';
  let minOsVersion = '';
  let libc = '';
  let glibcMaxVersion = '';
  let androidApiLevel = null;

  // --- Mach-O extraction ---
  const machoLibs = Array.isArray(input.dylibs)
    ? input.dylibs
    : (Array.isArray(input.libraries) ? input.libraries : []);
  if (machoLibs.length > 0) {
    for (const d of machoLibs) {
      if (typeof d === 'string') {
        dylibs.push(d);
      } else if (d && typeof d === 'object') {
        const libName = d.name || d.path || '';
        if (!libName) continue;
        dylibs.push(libName);
        if (d.currentVersion || d.compatibilityVersion) {
          dylibVersions[libName] = {
            currentVersion: decodePackedMachoVersion(d.currentVersion),
            compatibilityVersion: decodePackedMachoVersion(d.compatibilityVersion),
          };
        }
      }
    }
  }
  if (input.dylibVersions && typeof input.dylibVersions === 'object') {
    for (const [k, v] of Object.entries(input.dylibVersions)) {
      dylibVersions[k] = {
        currentVersion: decodePackedMachoVersion(v.currentVersion),
        compatibilityVersion: decodePackedMachoVersion(v.compatibilityVersion),
      };
    }
  }

  // Parse LC_BUILD_VERSION / LC_VERSION_MIN_* from loadCommands or direct buildVersion
  const loadCommands = Array.isArray(input.loadCommands)
    ? input.loadCommands
    : (Array.isArray(input.metadata?.loadCommands) ? input.metadata.loadCommands : []);
  const rawBuildVer = input.buildVersion ?? input.metadata?.buildVersion;
  const buildVersions = rawBuildVer ? [rawBuildVer] : [];
  for (const lc of loadCommands) {
    if (!lc || typeof lc !== 'object') continue;
    const cmd = String(lc.cmd || lc.type || '').toUpperCase();
    if (cmd === 'LC_BUILD_VERSION') {
      buildVersions.push(lc);
    } else if (cmd === 'LC_VERSION_MIN_IPHONEOS') {
      if (platform === 'unknown') platform = 'ios';
      if (!minOsVersion && lc.version) minOsVersion = decodePackedMachoVersion(lc.version);
      if (!sdkVersion && lc.sdk) sdkVersion = decodePackedMachoVersion(lc.sdk);
    } else if (cmd === 'LC_VERSION_MIN_MACOSX') {
      if (platform === 'unknown') platform = 'macos';
      if (!minOsVersion && lc.version) minOsVersion = decodePackedMachoVersion(lc.version);
      if (!sdkVersion && lc.sdk) sdkVersion = decodePackedMachoVersion(lc.sdk);
    } else if (cmd === 'LC_LOAD_DYLIB' || cmd === 'LC_LOAD_WEAK_DYLIB' || cmd === 'LC_REEXPORT_DYLIB') {
      if (lc.name) {
        dylibs.push(lc.name);
        if (lc.currentVersion || lc.compatibilityVersion) {
          dylibVersions[lc.name] = {
            currentVersion: decodePackedMachoVersion(lc.currentVersion),
            compatibilityVersion: decodePackedMachoVersion(lc.compatibilityVersion),
          };
        }
      }
    }
  }

  for (const bv of buildVersions) {
    if (bv.platform !== undefined && platform === 'unknown') {
      platform = normalizePlatform(bv.platform);
    }
    if (bv.sdk && !sdkVersion) sdkVersion = decodePackedMachoVersion(bv.sdk);
    if (bv.minos && !minOsVersion) minOsVersion = decodePackedMachoVersion(bv.minos);
  }

  // --- ELF extraction (DT_NEEDED, PT_INTERP, DT_VERNEED, PT_NOTE) ---
  if (Array.isArray(input.dtNeeded)) {
    for (const dep of input.dtNeeded) {
      if (dep) dylibs.push(String(dep));
    }
  }
  if (input.ptInterp) {
    const interp = String(input.ptInterp);
    notes.push(`interp:${interp}`);
    if (interp.includes('musl')) {
      libc = 'musl';
      if (platform === 'unknown') platform = 'linux';
    } else if (interp.includes('/system/bin/linker')) {
      libc = 'bionic';
      platform = 'android';
    } else if (interp.includes('ld-linux')) {
      libc = 'glibc';
      if (platform === 'unknown') platform = 'linux';
    }
  }
  if (Array.isArray(input.verneed)) {
    for (const v of input.verneed) {
      const s = String(v);
      notes.push(s);
      const gm = /GLIBC_(\d+\.\d+(?:\.\d+)?)/.exec(s);
      if (gm) {
        libc = 'glibc';
        if (!glibcMaxVersion || compareVersionStr(gm[1], glibcMaxVersion) > 0) {
          glibcMaxVersion = gm[1];
        }
      }
    }
  }
  if (Array.isArray(input.elfNotes)) {
    for (const n of input.elfNotes) {
      if (typeof n === 'string') {
        notes.push(n);
      } else if (n && typeof n === 'object') {
        const name = String(n.name || '').toLowerCase();
        notes.push(`${name}:${n.desc || n.apiLevel || ''}`);
        if (name === 'android' || n.apiLevel) {
          platform = 'android';
          libc = 'bionic';
          if (n.apiLevel) androidApiLevel = Number(n.apiLevel);
        }
      }
    }
  }
  if (input.androidApiLevel) {
    platform = 'android';
    libc = 'bionic';
    androidApiLevel = Number(input.androidApiLevel);
  }

  // --- PE extraction ---
  if (Array.isArray(input.dlls)) {
    for (const dll of input.dlls) dylibs.push(String(dll));
    if (platform === 'unknown') platform = 'windows';
  }

  // Infer platform & libc from dylibs if still unknown
  const uniqueDylibs = Array.from(new Set(dylibs)).sort();
  const dylibBasenames = Array.from(new Set(uniqueDylibs.map(extractDylibBasename))).sort();

  if (platform === 'unknown') {
    if (uniqueDylibs.some((d) => d.includes('UIKit') || d.includes('/System/Library/Frameworks/UIKit'))) {
      platform = 'ios';
    } else if (uniqueDylibs.some((d) => d.includes('AppKit') || d.includes('/usr/lib/libSystem'))) {
      platform = 'macos';
    } else if (uniqueDylibs.some((d) => d.includes('libandroid.so') || d.includes('liblog.so'))) {
      platform = 'android';
    } else if (format === 'elf') {
      platform = 'linux';
    }
  }

  if (!libc) {
    if (platform === 'ios' || platform === 'macos' || platform === 'ios-simulator') libc = 'libSystem';
    else if (platform === 'android') libc = 'bionic';
    else if (uniqueDylibs.some((d) => d.includes('musl'))) libc = 'musl';
    else if (uniqueDylibs.some((d) => d.includes('libc.so.6'))) libc = 'glibc';
  }

  if (!sdkVersion && androidApiLevel) {
    sdkVersion = String(androidApiLevel);
  } else if (!sdkVersion && glibcMaxVersion) {
    sdkVersion = glibcMaxVersion;
  }

  const symbols = Array.isArray(input.symbols) ? input.symbols.map(String) : [];
  const strings = Array.isArray(input.strings) ? input.strings.map(String) : [];
  const hints = detectHintsFromCorpus(uniqueDylibs, symbols, strings, notes);

  const canonical = JSON.stringify({
    format,
    arch,
    platform,
    sdkVersion,
    minOsVersion,
    libc,
    androidApiLevel,
    dylibBasenames,
    hints,
  });
  const fingerprintHash = fnv1a32(new TextEncoder().encode(canonical)).toString(16).padStart(8, '0');

  return {
    format,
    arch,
    platform,
    sdkVersion,
    minOsVersion,
    libc,
    glibcMaxVersion,
    androidApiLevel,
    dylibs: uniqueDylibs,
    dylibBasenames,
    dylibVersions,
    hints,
    fingerprintHash,
  };
}

export function compareVersionStr(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}
