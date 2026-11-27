#!/usr/bin/env node
/**
 * CLI Build Script: compiles curated OSS C headers & Core TIL-lite into
 * dist/til-hub/ (manifest.json + .til + .til.gz binary packs) with
 * deterministic SHA-256 hashes, FNV-32 checksums, and size reporting.
 * Spec: hex_ida_beyond_ida_design.md §3.1, §10.1, §18.1
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fflate from '../js/vendor/fflate.js';
import { getCoreTilIr } from '../js/analysis/types/core/til-lite-data.js';
import {
  compileTil1,
  validateTil1Buffer,
  TIL1_CORE_MAX_BYTES,
} from '../js/analysis/types/core/til-binary-compiler.js';
import { compileSdkBatch } from '../js/analysis/types/core/sdk-batch-compiler.js';
import { sha256HexSync } from '../js/analysis/types/core/til-storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
export const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'dist', 'til-hub');

// ---------------------------------------------------------------------------
// Curated Clean OSS Pack Definitions
// ---------------------------------------------------------------------------
const CURATED_PACK_SPECS = [
  {
    id: 'ios-sdk-core',
    name: 'Apple iOS SDK Core',
    version: '18.0.0',
    sdkVersion: '18.0',
    category: 'os',
    source: 'official',
    matchRules: {
      platforms: ['ios', 'ios-simulator'],
      libc: 'libSystem',
      dylibs: ['UIKit', 'Foundation', 'CoreFoundation', 'libSystem.B.dylib'],
      hints: ['uikit', 'foundation', 'objc'],
    },
    conflicts: [],
    requires: [],
    files: [
      {
        path: 'uikit_core.h',
        content: `
          typedef double CGFloat;
          typedef struct CGPoint { CGFloat x; CGFloat y; } CGPoint;
          typedef struct CGSize { CGFloat width; CGFloat height; } CGSize;
          typedef struct CGRect { CGPoint origin; CGSize size; } CGRect;
          typedef struct UIEdgeInsets { CGFloat top; CGFloat left; CGFloat bottom; CGFloat right; } UIEdgeInsets;
          typedef enum UIControlState {
            UIControlStateNormal = 0,
            UIControlStateHighlighted = 1 << 0,
            UIControlStateDisabled = 1 << 1,
            UIControlStateSelected = 1 << 2
          } UIControlState;
          int UIApplicationMain(int argc, char **argv, id principalClassName, id delegateClassName);
          void UIGraphicsBeginImageContextWithOptions(CGSize size, bool opaque, CGFloat scale);
          id UIGraphicsGetImageFromCurrentImageContext(void);
          void UIGraphicsEndImageContext(void);
          id NSStringFromCGRect(CGRect rect);
          id NSStringFromCGSize(CGSize size);
          @interface UIView : NSObject
          - (void)addSubview:(id)view;
          - (void)removeFromSuperview;
          - (void)setNeedsLayout;
          - (void)layoutIfNeeded;
          @end
          @interface UIViewController : NSObject
          - (void)viewDidLoad;
          - (void)viewWillAppear:(bool)animated;
          - (void)presentViewController:(id)vc animated:(bool)flag completion:(id)completion;
          @end
        `,
      },
    ],
  },
  {
    id: 'macos-sdk-core',
    name: 'Apple macOS SDK Core',
    version: '15.0.0',
    sdkVersion: '15.0',
    category: 'os',
    source: 'official',
    matchRules: {
      platforms: ['macos'],
      libc: 'libSystem',
      dylibs: ['AppKit', 'Foundation', 'CoreFoundation', 'libSystem.B.dylib'],
      hints: ['appkit', 'foundation', 'objc'],
    },
    conflicts: [],
    requires: [],
    files: [
      {
        path: 'appkit_core.h',
        content: `
          typedef int32_t OSStatus;
          typedef uint32_t mach_port_t;
          typedef int32_t kern_return_t;
          int NSApplicationMain(int argc, const char **argv);
          OSStatus SecItemCopyMatching(const void *query, const void **result);
          OSStatus SecItemAdd(const void *attributes, const void **result);
          OSStatus SecItemDelete(const void *query);
          kern_return_t mach_vm_protect(mach_port_t target_task, uint64_t address, uint64_t size, int set_maximum, int new_protection);
          kern_return_t mach_vm_read(mach_port_t target_task, uint64_t address, uint64_t size, uint64_t *data, uint32_t *dataCnt);
        `,
      },
    ],
  },
  {
    id: 'android-ndk-core',
    name: 'Android NDK API 34 Core',
    version: '34.0.0',
    sdkVersion: '34',
    category: 'os',
    source: 'official',
    matchRules: {
      platforms: ['android'],
      libc: 'bionic',
      dylibs: ['liblog.so', 'libandroid.so', 'libc.so'],
      hints: ['android-ndk', 'bionic'],
    },
    conflicts: ['glibc-linux-core'],
    requires: [],
    files: [
      {
        path: 'android_ndk.h',
        content: `
          typedef enum android_LogPriority {
            ANDROID_LOG_UNKNOWN = 0,
            ANDROID_LOG_DEFAULT = 1,
            ANDROID_LOG_VERBOSE = 2,
            ANDROID_LOG_DEBUG = 3,
            ANDROID_LOG_INFO = 4,
            ANDROID_LOG_WARN = 5,
            ANDROID_LOG_ERROR = 6,
            ANDROID_LOG_FATAL = 7
          } android_LogPriority;
          typedef struct AAssetManager AAssetManager;
          typedef struct AAsset AAsset;
          typedef struct ANativeWindow ANativeWindow;
          typedef struct JNIEnv JNIEnv;
          typedef struct JavaVM JavaVM;
          int __android_log_print(int prio, const char *tag, const char *fmt, ...);
          int __android_log_write(int prio, const char *tag, const char *text);
          AAsset *AAssetManager_open(AAssetManager *mgr, const char *filename, int mode);
          int AAsset_read(AAsset *asset, void *buf, size_t count);
          int64_t AAsset_getLength64(AAsset *asset);
          void AAsset_close(AAsset *asset);
          int32_t ANativeWindow_getWidth(ANativeWindow *window);
          int32_t ANativeWindow_getHeight(ANativeWindow *window);
          void ANativeWindow_release(ANativeWindow *window);
          int __system_property_get(const char *name, char *value);
        `,
      },
    ],
  },
  {
    id: 'glibc-linux-core',
    name: 'GNU/Linux glibc 2.38 Core',
    version: '2.38.0',
    sdkVersion: '2.38',
    category: 'os',
    source: 'official',
    matchRules: {
      platforms: ['linux'],
      libc: 'glibc',
      dylibs: ['libc.so.6', 'libpthread.so.0', 'libdl.so.2'],
      hints: ['glibc'],
    },
    conflicts: ['android-ndk-core'],
    requires: [],
    files: [
      {
        path: 'glibc_linux.h',
        content: `
          typedef struct epoll_event {
            uint32_t events;
            uint64_t data;
          } epoll_event;
          int epoll_create1(int flags);
          int epoll_ctl(int epfd, int op, int fd, struct epoll_event *event);
          int epoll_wait(int epfd, struct epoll_event *events, int maxevents, int timeout);
          int prctl(int option, unsigned long arg2, unsigned long arg3, unsigned long arg4, unsigned long arg5);
          ssize_t sendfile(int out_fd, int in_fd, int64_t *offset, size_t count);
          int inotify_init1(int flags);
          int inotify_add_watch(int fd, const char *pathname, uint32_t mask);
          int eventfd(unsigned int initval, int flags);
          int timerfd_create(int clockid, int flags);
        `,
      },
    ],
  },
  {
    id: 'openssl-core',
    name: 'OpenSSL 3.x Crypto/TLS Core',
    version: '3.2.0',
    sdkVersion: '3.2',
    category: 'oss',
    source: 'official',
    matchRules: {
      platforms: ['any'],
      dylibs: ['libssl', 'libcrypto'],
      hints: ['openssl', 'boringssl'],
    },
    conflicts: [],
    requires: [],
    files: [
      {
        path: 'openssl_core.h',
        content: `
          typedef struct ssl_ctx_st SSL_CTX;
          typedef struct ssl_st SSL;
          typedef struct ssl_method_st SSL_METHOD;
          typedef struct evp_md_ctx_st EVP_MD_CTX;
          typedef struct evp_md_st EVP_MD;
          typedef struct evp_cipher_ctx_st EVP_CIPHER_CTX;
          typedef struct evp_cipher_st EVP_CIPHER;
          typedef struct bio_st BIO;
          typedef struct x509_st X509;
          SSL_CTX *SSL_CTX_new(const SSL_METHOD *meth);
          void SSL_CTX_free(SSL_CTX *ctx);
          SSL *SSL_new(SSL_CTX *ctx);
          void SSL_free(SSL *ssl);
          int SSL_connect(SSL *ssl);
          int SSL_read(SSL *ssl, void *buf, int num);
          int SSL_write(SSL *ssl, const void *buf, int num);
          int SSL_shutdown(SSL *ssl);
          EVP_MD_CTX *EVP_MD_CTX_new(void);
          void EVP_MD_CTX_free(EVP_MD_CTX *ctx);
          int EVP_DigestInit_ex(EVP_MD_CTX *ctx, const EVP_MD *type, void *impl);
          int EVP_DigestUpdate(EVP_MD_CTX *ctx, const void *d, size_t cnt);
          int EVP_DigestFinal_ex(EVP_MD_CTX *ctx, uint8_t *md, uint32_t *s);
          EVP_CIPHER_CTX *EVP_CIPHER_CTX_new(void);
          void EVP_CIPHER_CTX_free(EVP_CIPHER_CTX *ctx);
          int EVP_EncryptInit_ex(EVP_CIPHER_CTX *ctx, const EVP_CIPHER *cipher, void *impl, const uint8_t *key, const uint8_t *iv);
          int EVP_EncryptUpdate(EVP_CIPHER_CTX *ctx, uint8_t *out, int *outl, const uint8_t *in, int inl);
          int EVP_EncryptFinal_ex(EVP_CIPHER_CTX *ctx, uint8_t *out, int *outl);
          int RAND_bytes(uint8_t *buf, int num);
        `,
      },
    ],
  },
  {
    id: 'sqlite-core',
    name: 'SQLite 3 Core C API',
    version: '3.45.0',
    sdkVersion: '3.45',
    category: 'oss',
    source: 'official',
    matchRules: {
      platforms: ['any'],
      dylibs: ['libsqlite3'],
      hints: ['sqlite'],
    },
    conflicts: [],
    requires: [],
    files: [
      {
        path: 'sqlite3_core.h',
        content: `
          typedef struct sqlite3 sqlite3;
          typedef struct sqlite3_stmt sqlite3_stmt;
          typedef enum SqliteResultCode {
            SQLITE_OK = 0,
            SQLITE_ERROR = 1,
            SQLITE_BUSY = 5,
            SQLITE_ROW = 100,
            SQLITE_DONE = 101
          } SqliteResultCode;
          int sqlite3_open(const char *filename, sqlite3 **ppDb);
          int sqlite3_open_v2(const char *filename, sqlite3 **ppDb, int flags, const char *zVfs);
          int sqlite3_close(sqlite3 *db);
          int sqlite3_exec(sqlite3 *db, const char *sql, void *callback, void *arg, char **errmsg);
          int sqlite3_prepare_v2(sqlite3 *db, const char *zSql, int nByte, sqlite3_stmt **ppStmt, const char **pzTail);
          int sqlite3_step(sqlite3_stmt *pStmt);
          int sqlite3_finalize(sqlite3_stmt *pStmt);
          int sqlite3_reset(sqlite3_stmt *pStmt);
          int sqlite3_bind_int(sqlite3_stmt *pStmt, int idx, int val);
          int sqlite3_bind_int64(sqlite3_stmt *pStmt, int idx, int64_t val);
          int sqlite3_bind_text(sqlite3_stmt *pStmt, int idx, const char *val, int n, void *destructor);
          int sqlite3_column_int(sqlite3_stmt *pStmt, int iCol);
          int64_t sqlite3_column_int64(sqlite3_stmt *pStmt, int iCol);
          const uint8_t *sqlite3_column_text(sqlite3_stmt *pStmt, int iCol);
          const char *sqlite3_errmsg(sqlite3 *db);
        `,
      },
    ],
  },
  {
    id: 'unity-il2cpp-core',
    name: 'Unity IL2CPP Runtime Core',
    version: '29.0.0',
    sdkVersion: '29',
    category: 'engine',
    source: 'official',
    matchRules: {
      platforms: ['any'],
      dylibs: [],
      hints: ['unity-il2cpp'],
    },
    conflicts: [],
    requires: [],
    files: [
      {
        path: 'il2cpp_extended.h',
        content: `
          typedef struct Il2CppObject { void *klass; void *monitor; } Il2CppObject;
          typedef struct Il2CppClass Il2CppClass;
          typedef struct Il2CppString Il2CppString;
          typedef struct Il2CppArray Il2CppArray;
          typedef struct MethodInfo MethodInfo;
          typedef struct FieldInfo FieldInfo;
          Il2CppObject *il2cpp_object_new(const Il2CppClass *klass);
          Il2CppString *il2cpp_string_new(const char *str);
          Il2CppString *il2cpp_string_new_utf16(const uint16_t *text, int32_t len);
          Il2CppObject *il2cpp_runtime_invoke(const MethodInfo *method, void *obj, void **params, void **exc);
          void *il2cpp_resolve_icall(const char *name);
          const MethodInfo *il2cpp_class_get_method_from_name(Il2CppClass *klass, const char *name, int argsCount);
          FieldInfo *il2cpp_class_get_field_from_name(Il2CppClass *klass, const char *name);
          Il2CppArray *il2cpp_array_new(Il2CppClass *elementTypeInfo, uint64_t length);
        `,
      },
    ],
  },
];

/**
 * Compiles Core TIL-lite + all curated TIL-Hub packs into `outDir`.
 */
export async function buildTilHub({ outDir = DEFAULT_OUT_DIR, quiet = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true });

  const manifestPacks = [];

  // 1. Build Tier-0 Core TIL-lite
  const coreTilBytes = compileTil1(getCoreTilIr());
  const coreVal = validateTil1Buffer(coreTilBytes);
  if (!coreVal.ok) {
    throw new Error(`Core TIL1 validation failed: ${coreVal.error}`);
  }
  if (coreTilBytes.byteLength > TIL1_CORE_MAX_BYTES) {
    throw new Error(`Core TIL1 exceeds 160 KiB budget (${coreTilBytes.byteLength} bytes)`);
  }
  const coreGzBytes = fflate.gzipSync(coreTilBytes, { level: 6, mtime: 0 });
  const coreSha256 = sha256HexSync(coreTilBytes);
  const coreGzSha256 = sha256HexSync(coreGzBytes);

  fs.writeFileSync(path.join(outDir, 'core-til-lite.til'), coreTilBytes);
  fs.writeFileSync(path.join(outDir, 'core-til-lite.til.gz'), coreGzBytes);

  const coreEntry = {
    id: 'core-til-lite',
    name: 'Core TIL-lite (Tier-0)',
    version: '1.0.0',
    sdkVersion: '1.0',
    category: 'core',
    source: 'official',
    isCore: true,
    file: 'core-til-lite.til',
    gzFile: 'core-til-lite.til.gz',
    rawBytes: coreTilBytes.byteLength,
    gzBytes: coreGzBytes.byteLength,
    sha256: coreSha256,
    gzSha256: coreGzSha256,
    checksumFnv32: coreVal.header.checksumFnv32,
    entryCount: coreVal.header.entryCount,
    selCount: coreVal.header.selCount,
    typeCount: coreVal.header.typeCount,
    matchRules: { platforms: ['any'], dylibs: [], hints: [] },
    conflicts: [],
    requires: [],
  };
  manifestPacks.push(coreEntry);

  // 2. Build Tier-1 SDK & OSS packs deterministically
  for (const spec of CURATED_PACK_SPECS) {
    const batch = await compileSdkBatch(spec.files, {
      packId: spec.id,
      version: spec.version,
      compress: true,
      fflate,
      matchRules: spec.matchRules,
    });
    const compiled = batch.packs[0];
    const tilFile = `${spec.id}.til`;
    const gzFile = `${spec.id}.til.gz`;
    fs.writeFileSync(path.join(outDir, tilFile), compiled.tilBytes);
    fs.writeFileSync(path.join(outDir, gzFile), compiled.gzBytes);

    manifestPacks.push({
      id: spec.id,
      name: spec.name,
      version: spec.version,
      sdkVersion: spec.sdkVersion,
      category: spec.category,
      source: spec.source,
      isCore: false,
      file: tilFile,
      gzFile,
      rawBytes: compiled.rawBytes,
      gzBytes: compiled.gzBytesLen,
      sha256: compiled.sha256,
      gzSha256: compiled.gzSha256,
      checksumFnv32: compiled.checksumFnv32,
      entryCount: compiled.entryCount,
      selCount: compiled.selCount,
      typeCount: compiled.typeCount,
      matchRules: spec.matchRules,
      conflicts: spec.conflicts,
      requires: spec.requires,
    });
  }

  const manifest = {
    schema: 'til-hub-manifest/v1',
    formatVersion: 1,
    totalPacks: manifestPacks.length,
    totalRawBytes: manifestPacks.reduce((s, p) => s + p.rawBytes, 0),
    totalGzBytes: manifestPacks.reduce((s, p) => s + p.gzBytes, 0),
    packs: manifestPacks,
  };

  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(path.join(outDir, 'manifest.json'), manifestJson, 'utf8');

  if (!quiet) {
    console.log(`[build-til-hub] Built ${manifest.totalPacks} TIL1 packs into ${outDir}`);
    for (const p of manifestPacks) {
      console.log(
        `  - ${p.id.padEnd(20)} raw=${String(p.rawBytes).padStart(6)}B  gz=${String(p.gzBytes).padStart(5)}B  ` +
        `entries=${String(p.entryCount).padStart(3)}  types=${String(p.typeCount).padStart(3)}  sha256=${p.sha256.slice(0, 12)}`
      );
    }
    console.log(
      `[build-til-hub] Total: raw=${manifest.totalRawBytes}B, gz=${manifest.totalGzBytes}B ` +
      `(Core TIL budget: ${coreEntry.rawBytes}/${TIL1_CORE_MAX_BYTES}B)`
    );
  }

  return manifest;
}

// Run directly if invoked from CLI
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  const outArgIdx = process.argv.indexOf('--out');
  const outDir = outArgIdx !== -1 && process.argv[outArgIdx + 1]
    ? path.resolve(process.argv[outArgIdx + 1])
    : DEFAULT_OUT_DIR;
  buildTilHub({ outDir }).catch((err) => {
    console.error('[build-til-hub] Failed:', err);
    process.exit(1);
  });
}
