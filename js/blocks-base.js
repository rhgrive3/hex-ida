/*
 * Semantic IR — 「命令」ではなく「処理」を組み立てるための中間表現。
 *
 * このファイルは日本語の文を一切作らない。作るのは「事実」と「根拠つきの推測」
 * だけで、それを人間の言葉にするのは narrate.js の仕事。こう分けておくと、
 *
 *   - 解析結果を言語に依存せずキャッシュできる（言語を切り替えても再解析しない）
 *   - あとから「日本語で質問する」機能を足すときに、モデルをそのまま材料にできる
 *
 * という 2 つが同時に成り立つ。
 *
 * 階層:
 *   ARM64 命令 → 命令の事実 (Insn) → データフロー (flows/値) →
 *   Basic Block → Semantic Block → 関数の意味 (facts)
 *
 * 大原則: 根拠のないことは書かない。
 *   どの推測にも evidence[] と confidence を必ず付ける。
 *   分からないものは kind:'unknown' のまま残す。無理に名前を付けない。
 */
import { parseOperands, categoryOf, arm64ReadsDestination } from './arm64.js';
import { analyzeGraph } from './controlflow.js';

/* ────────────────────────────────────────────────────────────
   確からしさ
   ──────────────────────────────────────────────────────────── */

/** 4 段階。UI はこの語で色や言い回しを変える。 */
export const LEVELS = ['confirmed', 'high', 'inferred', 'unknown'];

export const SCORE = {
  confirmed: 1,      // バイナリから直接読める（命令がそこにある、という類）
  high: 0.85,        // ほぼ確実（memcpy を呼んでいる → データをコピーしている）
  inferred: 0.6,     // 推測（この関数はログイン処理らしい）
  unknown: 0.25,     // 情報不足
};

export function levelOf(score) {
  if (!(score > 0)) return 'unknown';
  if (score >= 0.97) return 'confirmed';
  if (score >= 0.75) return 'high';
  if (score >= 0.45) return 'inferred';
  return 'unknown';
}

/** 根拠 1 件。code は narrate.js が日本語にするための鍵。 */
export function ev(code, row, detail) {
  return { code, row: row == null ? -1 : row, detail: detail || null };
}

/* ────────────────────────────────────────────────────────────
   Semantic Block の役割
   ──────────────────────────────────────────────────────────── */

export const ROLE = {
  FUNCTION_ENTRY: 'function_entry',
  REGISTER_SETUP: 'register_setup',
  ARGUMENT_PREPARATION: 'argument_preparation',
  MEMORY_READ: 'memory_read',
  MEMORY_WRITE: 'memory_write',
  ADDRESS_CALCULATION: 'address_calculation',
  VALUE_CALCULATION: 'value_calculation',
  CONDITION_CHECK: 'condition_check',
  BRANCH: 'branch',
  LOOP: 'loop',
  FUNCTION_CALL: 'function_call',
  RETURN_VALUE: 'return_value',
  ERROR_HANDLING: 'error_handling',
  CLEANUP: 'cleanup',
  FUNCTION_EXIT: 'function_exit',
  UNKNOWN: 'unknown',
};

/* ────────────────────────────────────────────────────────────
   外部 API の知識
   ──────────────────────────────────────────────────────────── */

/*
 * 「memcpy とは C の関数で…」を利用者に読ませないための表。
 * 名前は内部でだけ使い、外へ出すのは「何が起きるか」。
 *
 *   id     … 安定した識別子（narrate.js が文を作るときの鍵）
 *   cat    … アプリの機能へ集約するときの分類
 *   args   … 引数の意味（x0 から順）。分からない位置は null。
 *   ret    … 戻り値の意味。null なら戻り値に意味を与えない。
 *   effect … このブロックが持つ副作用
 */
const PRECISE_API_TABLE = [
  // Memory APIs whose ABI differs from the historical broad-family fallback.
  { id:'bcopy', re:/^_?bcopy$/i, cat:'memory', args:['src','dst','size'], ret:null, effect:'copy' },
  { id:'memcpy_chk', re:/^_?__(memcpy|memmove)_chk$/i, cat:'memory', args:['dst','src','size','object_size'], ret:'ptr', effect:'copy' },
  { id:'memset_chk', re:/^_?__memset_chk$/i, cat:'memory', args:['dst','fill','size','object_size'], ret:'ptr', effect:'fill' },
  { id:'bzero', re:/^_?bzero$/i, cat:'memory', args:['dst','size'], ret:null, effect:'fill' },
  { id:'calloc', re:/^_?calloc$/i, cat:'memory', args:['count','size'], ret:'heap', effect:'alloc' },

  // Bounded/string conversion APIs. Keep every ABI-significant operand.
  { id:'strnlen', re:/^_?strnlen$/i, cat:'string', args:['str','maxlen'], ret:'length', effect:'read' },
  { id:'strncmp', re:/^_?(strncmp|strncasecmp)$/i, cat:'string', args:['a','b','size'], ret:'diff', effect:'compare' },
  { id:'strncpy', re:/^_?strncpy$/i, cat:'string', args:['dst','src','size'], ret:'ptr', effect:'copy' },
  { id:'strlcpy', re:/^_?strlcpy$/i, cat:'string', args:['dst','src','dst_size'], ret:'length', effect:'copy' },
  { id:'strcpy_chk', re:/^_?__strcpy_chk$/i, cat:'string', args:['dst','src','object_size'], ret:'ptr', effect:'copy' },
  { id:'strncpy_chk', re:/^_?__strncpy_chk$/i, cat:'string', args:['dst','src','size','object_size'], ret:'ptr', effect:'copy' },
  { id:'strncat', re:/^_?strncat$/i, cat:'string', args:['dst','src','size'], ret:'ptr', effect:'copy' },
  { id:'strlcat', re:/^_?strlcat$/i, cat:'string', args:['dst','src','dst_size'], ret:'length', effect:'copy' },
  { id:'sprintf', re:/^_?sprintf$/i, cat:'string', args:['dst','format'], formatArg:1, variadic:true, ret:'length', effect:'format' },
  { id:'snprintf', re:/^_?snprintf$/i, cat:'string', args:['dst','size','format'], formatArg:2, variadic:true, ret:'length', effect:'format' },
  { id:'asprintf', re:/^_?asprintf$/i, cat:'string', args:['dst_ptr','format'], formatArg:1, variadic:true, ret:'length', effect:'format' },
  { id:'vsnprintf', re:/^_?vsnprintf$/i, cat:'string', args:['dst','size','format','va_list'], formatArg:2, ret:'length', effect:'format' },
  { id:'sprintf_chk', re:/^_?__sprintf_chk$/i, cat:'string', args:['dst','flags','object_size','format'], formatArg:3, variadic:true, ret:'length', effect:'format' },
  { id:'snprintf_chk', re:/^_?__snprintf_chk$/i, cat:'string', args:['dst','size','flags','object_size','format'], formatArg:4, variadic:true, ret:'length', effect:'format' },
  { id:'strtol', re:/^_?(strtol|strtoul)$/i, cat:'string', args:['str','endptr','base'], ret:'number', effect:'convert' },
  { id:'strtod', re:/^_?strtod$/i, cat:'string', args:['str','endptr'], ret:'number', effect:'convert' },

  // Logging format-string positions are ABI-specific.
  { id:'printf', re:/^_?printf$/i, cat:'log', args:['format'], formatArg:0, variadic:true, ret:'status', effect:'log' },
  { id:'fprintf', re:/^_?fprintf$/i, cat:'log', args:['stream','format'], formatArg:1, variadic:true, ret:'status', effect:'log' },
  { id:'puts', re:/^_?puts$/i, cat:'log', args:['str'], ret:'status', effect:'log' },
  { id:'putchar', re:/^_?putchar$/i, cat:'log', args:['char'], ret:'status', effect:'log' },
  { id:'NSLog', re:/^_?NSLog$/i, cat:'log', args:['format'], formatArg:0, variadic:true, ret:null, effect:'log' },
  { id:'os_log', re:/^_?os_log$/i, cat:'log', args:['log','format'], formatArg:1, variadic:true, ret:null, effect:'log' },
  { id:'os_log_impl', re:/^_?_os_log_impl$/i, cat:'log', args:['dso','log','type','format','buffer','size'], formatArg:3, ret:null, effect:'log' },
  { id:'syslog', re:/^_?syslog$/i, cat:'log', args:['priority','format'], formatArg:1, variadic:true, ret:null, effect:'log' },

  // Objective-C ARC helpers: retain-like and release/store operations do not share a return contract.
  { id:'objc_retain', re:/^_?objc_retain$/i, cat:'objc', args:['object'], ret:'object', effect:'refcount' },
  { id:'objc_release', re:/^_?objc_release$/i, cat:'objc', args:['object'], ret:null, effect:'refcount' },
  { id:'objc_autorelease', re:/^_?objc_autorelease$/i, cat:'objc', args:['object'], ret:'object', effect:'refcount' },
  { id:'objc_storeStrong', re:/^_?objc_storeStrong$/i, cat:'objc', args:['location','object'], ret:null, effect:'refcount' },
  { id:'objc_arc_return', re:/^_?objc_(retainAutorelease(?:ReturnValue)?|retainAutoreleasedReturnValue|autoreleaseReturnValue|claimAutoreleasedReturnValue|unsafeClaimAutoreleasedReturnValue)$/i, cat:'objc', args:['object'], ret:'object', effect:'refcount' },
  { id:'objc_alloc', re:/^_?(objc_alloc|objc_allocWithZone|objc_opt_new)$/i, cat:'objc', args:['class'], ret:'object', effect:'alloc' },

  // Swift ownership/allocation helpers also have distinct ABI effects.
  { id:'swift_retain', re:/^_?swift_(retain|bridgeObjectRetain)$/i, cat:'runtime', args:['object'], ret:'object', effect:'refcount' },
  { id:'swift_release', re:/^_?swift_(release|bridgeObjectRelease)$/i, cat:'runtime', args:['object'], ret:null, effect:'refcount' },
  { id:'swift_allocObject', re:/^_?swift_allocObject$/i, cat:'runtime', args:['metadata','size','align_mask'], ret:'object', effect:'alloc' },

  // POSIX/stdio file calls.
  { id:'open', re:/^_?open$/i, cat:'io', args:['path','flags'], variadic:true, ret:'handle', effect:'io' },
  { id:'openat', re:/^_?openat$/i, cat:'io', args:['dirfd','path','flags'], variadic:true, ret:'handle', effect:'io' },
  { id:'fopen', re:/^_?fopen$/i, cat:'io', args:['path','mode'], ret:'handle', effect:'io' },
  { id:'fread', re:/^_?fread$/i, cat:'io', args:['ptr','size','count','stream'], ret:'count', effect:'io' },
  { id:'fwrite', re:/^_?fwrite$/i, cat:'io', args:['ptr','size','count','stream'], ret:'count', effect:'io' },
  { id:'read', re:/^_?read$/i, cat:'io', args:['fd','buffer','count'], ret:'count', effect:'io' },
  { id:'write', re:/^_?write$/i, cat:'io', args:['fd','buffer','count'], ret:'count', effect:'io' },
  { id:'close', re:/^_?close$/i, cat:'io', args:['fd'], ret:'status', effect:'io' },
  { id:'fclose', re:/^_?fclose$/i, cat:'io', args:['stream'], ret:'status', effect:'io' },
  { id:'lseek', re:/^_?lseek$/i, cat:'io', args:['fd','offset','whence'], ret:'offset', effect:'io' },
  { id:'stat', re:/^_?stat$/i, cat:'io', args:['path','statbuf'], ret:'status', effect:'io' },
  { id:'unlink', re:/^_?unlink$/i, cat:'io', args:['path'], ret:'status', effect:'io' },
  { id:'mkdir', re:/^_?mkdir$/i, cat:'io', args:['path','mode'], ret:'status', effect:'io' },
  { id:'remove', re:/^_?remove$/i, cat:'io', args:['path'], ret:'status', effect:'io' },

  // Socket APIs. Preserve every address/length/flags operand.
  { id:'socket', re:/^_?socket$/i, cat:'network', args:['domain','type','protocol'], ret:'handle', effect:'network' },
  { id:'connect', re:/^_?connect$/i, cat:'network', args:['socket','address','address_len'], ret:'status', effect:'network' },
  { id:'bind', re:/^_?bind$/i, cat:'network', args:['socket','address','address_len'], ret:'status', effect:'network' },
  { id:'listen', re:/^_?listen$/i, cat:'network', args:['socket','backlog'], ret:'status', effect:'network' },
  { id:'accept', re:/^_?accept$/i, cat:'network', args:['socket','address','address_len_ptr'], ret:'handle', effect:'network' },
  { id:'send', re:/^_?send$/i, cat:'network', args:['socket','buffer','length','flags'], ret:'count', effect:'network' },
  { id:'sendto', re:/^_?sendto$/i, cat:'network', args:['socket','buffer','length','flags','address','address_len'], ret:'count', effect:'network' },
  { id:'recv', re:/^_?recv$/i, cat:'network', args:['socket','buffer','length','flags'], ret:'count', effect:'network' },
  { id:'recvfrom', re:/^_?recvfrom$/i, cat:'network', args:['socket','buffer','length','flags','address','address_len_ptr'], ret:'count', effect:'network' },
  { id:'getaddrinfo', re:/^_?getaddrinfo$/i, cat:'network', args:['node','service','hints','result_ptr'], ret:'status', effect:'network' },
];

const API_TABLE = [
  { id: 'memcpy', re: /^_?(memcpy|memmove|bcopy|__memcpy_chk|__memmove_chk)$/i, cat: 'memory',
    args: ['dst', 'src', 'size'], ret: null, effect: 'copy' },
  { id: 'memset', re: /^_?(memset|bzero|__memset_chk)$/i, cat: 'memory',
    args: ['dst', 'fill', 'size'], ret: null, effect: 'fill' },
  { id: 'malloc', re: /^(?:_?(?:malloc|calloc|valloc)|_{1,2}Z(?:nw|na)m.*|_?operator new(?:\[\])?(?:\s*\(.*\))?)$/i, cat: 'memory',
    args: ['size'], ret: 'heap', effect: 'alloc' },
  { id: 'realloc', re: /^_?realloc$/i, cat: 'memory', args: ['ptr', 'size'], ret: 'heap', effect: 'alloc' },
  { id: 'free', re: /^_?(free|_ZdlPv|_ZdaPv|operator delete)/i, cat: 'memory',
    args: ['ptr'], ret: null, effect: 'free' },
  { id: 'memcmp', re: /^_?(memcmp|bcmp|timingsafe_bcmp)$/i, cat: 'memory',
    args: ['a', 'b', 'size'], ret: 'diff', effect: 'compare' },
  { id: 'memchr', re: /^_?(memchr|memrchr)$/i, cat: 'memory',
    args: ['ptr', 'byte', 'size'], ret: 'ptr', effect: 'search' },

  { id: 'strlen', re: /^_?(strlen|strnlen)$/i, cat: 'string', args: ['str'], ret: 'length', effect: 'read' },
  { id: 'strcmp', re: /^_?(strcmp|strncmp|strcasecmp|strncasecmp)$/i, cat: 'string',
    args: ['a', 'b'], ret: 'diff', effect: 'compare' },
  { id: 'strcpy', re: /^_?(strcpy|strncpy|strlcpy|stpcpy|__strcpy_chk|__strncpy_chk)$/i, cat: 'string',
    args: ['dst', 'src'], ret: null, effect: 'copy' },
  { id: 'strcat', re: /^_?(strcat|strncat|strlcat)$/i, cat: 'string', args: ['dst', 'src'], ret: null, effect: 'copy' },
  { id: 'sprintf', re: /^_?(sprintf|snprintf|asprintf|vsnprintf|__sprintf_chk|__snprintf_chk)$/i, cat: 'string',
    args: ['dst', 'size', 'format'], ret: 'length', effect: 'format' },
  { id: 'strstr', re: /^_?(strstr|strchr|strrchr|strtok)$/i, cat: 'string', args: ['str', 'needle'], ret: 'ptr', effect: 'search' },
  { id: 'atoi', re: /^_?(atoi|atol|strtol|strtoul|strtod)$/i, cat: 'string', args: ['str'], ret: 'number', effect: 'convert' },

  { id: 'log', re: /^_?(?:printf|fprintf|puts|putchar|NSLog|os_log|_os_log_impl|syslog)$/i, cat: 'log',
    args: ['format'], ret: null, effect: 'log' },

  { id: 'objc_msgSend', re: /^_?objc_msgSend/i, cat: 'objc', args: ['receiver', 'selector'], ret: 'object', effect: 'call' },
  { id: 'objc_retain', re: /^_?(objc_retain|objc_release|objc_autorelease|objc_storeStrong|objc_retainAutorelease(?:ReturnValue)?|objc_retainAutoreleasedReturnValue|objc_autoreleaseReturnValue|objc_claimAutoreleasedReturnValue|objc_unsafeClaimAutoreleasedReturnValue)/i,
    cat: 'objc', args: ['object'], ret: 'object', effect: 'refcount' },
  { id: 'objc_alloc', re: /^_?(objc_alloc|objc_allocWithZone|objc_opt_new)/i, cat: 'objc', args: ['class'], ret: 'object', effect: 'alloc' },
  { id: 'swift_object', re: /^_?swift_(retain|release|allocObject|bridgeObjectRetain|bridgeObjectRelease)/i,
    cat: 'objc', args: ['object'], ret: 'object', effect: 'refcount' },
  /* ── 言語のしくみが勝手に入れている処理 ─────────────────────
   *
   * ここを「知らない呼び出し」のままにしておくと、実際のアプリでは
   * 全呼び出しの 1 割以上が説明できないまま残る。しかもこれらは
   * **読む人が無視してよい**ものなので、名指しできること自体に価値がある
   *  — 「ここは Swift のしくみです、あなたの探しものではありません」と言える。
   */
  { id: 'objc_weak', re: /^_?(objc_(initWeak|destroyWeak|copyWeak|moveWeak|storeWeak|loadWeak|loadWeakRetained)|swift_unknownObjectWeak\w*|swift_weak\w*)$/i,
    cat: 'objc', args: ['location'], ret: 'object', effect: 'refcount' },
  { id: 'objc_runtime', re: /^_?objc_(sync_enter|sync_exit|enumerationMutation|opt_class|opt_self|opt_isKindOfClass|opt_respondsToSelector|getClass|getMetaClass|lookUpClass|autoreleasePool(Push|Pop)|begin_catch|end_catch|exception_rethrow|setProperty\w*|getProperty|copyStruct|terminate)$/i,
    cat: 'runtime', args: null, ret: null, effect: 'runtime' },
  { id: 'swift_runtime', re: /^_?swift_((begin|end)Access|once|getWitnessTable|conformsToProtocol\w*|isUniquelyReferenced\w*|dynamicCast\w*|getObjectType|getInitializedObjCClass|getTypeByMangledName\w*|allocError|willThrow|errorRelease|errorRetain|unknownObject(Retain|Release)|initStackObject|slowAlloc|slowDealloc|deallocClassInstance|task_\w+|checkMetadataState|allocateGenericValueMetadata|getGenericMetadata|getForeignTypeMetadata|getSingletonMetadata|initClassMetadata\d*|initStructMetadata|getErrorValue|storeEnumTagSinglePayload|getEnumTagSinglePayload|storeEnumTagMultiPayload|getEnumCaseMultiPayload|arrayInitWithCopy|arrayDestroy|initStaticObject|setDeallocating|unexpectedError|bridgeObjectRetain|bridgeObjectRelease)/i,
    cat: 'runtime', args: null, ret: null, effect: 'runtime' },
  { id: 'cxx_runtime', re: /^_*(cxa_(atexit|guard_acquire|guard_release|guard_abort|throw|begin_catch|end_catch|rethrow|allocate_exception|free_exception|pure_virtual|demangle)|dynamic_cast|Unwind_\w+|Znw[mj]|Zna[mj]|ZdlPv|ZdaPv|Block_(copy|release)|Block_object_(assign|dispose))$/,
    cat: 'runtime', args: null, ret: null, effect: 'runtime' },
  /*
   * C++ の標準ライブラリ。Cocos2d-x / Unreal のゲームでは、ここが呼び出しの中心になる。
   * 綴りは Itanium ABI の飾りつき（__ZNSt3__1… は std:: の中）。
   */
  { id: 'cxx_string', re: /^__?ZN?K?St3__1\d*basic_string|^__?ZNSt3__112basic_string|basic_stringIcNS_11char_traits/,
    cat: 'string', args: null, ret: null, effect: 'read' },
  { id: 'cxx_container', re: /^__?ZNSt3__1(6vector|3map|13unordered_map|3set|13unordered_set|4list|5deque|19__shared_weak_count|10shared_ptr|__shared)/,
    cat: 'memory', args: null, ret: null, effect: 'alloc' },
  { id: 'cxx_std', re: /^__?ZN?K?St3__1/, cat: 'runtime', args: null, ret: null, effect: 'runtime' },
  /*
   * Swift の標準ライブラリ（`_$ss` で始まる飾り名）。文字列とハッシュがほとんど。
   * 自分のアプリのコード（`_$s` のあとにモジュール名）とは分けて扱う。
   */
  { id: 'swift_string', re: /^_\$s(SS|s\w*(String|_string|stringCompare))/, cat: 'string', args: null, ret: null, effect: 'read' },
  { id: 'swift_collection', re: /^_\$s(Sa|SD|Sh|Sl|Sk)\w/, cat: 'memory', args: null, ret: null, effect: 'alloc' },
  { id: 'swift_hash', re: /^_\$ss6HasherV|^_\$sS\w+4hash4into/, cat: 'runtime', args: null, ret: 'number', effect: 'runtime' },
  { id: 'swift_stdlib_report', re: /^_+swift_stdlib_report\w*/i, cat: 'runtime', args: null, ret: null, effect: 'runtime' },
  { id: 'swift_stdlib', re: /^_\$ss/, cat: 'runtime', args: null, ret: null, effect: 'runtime' },
  /* それ以外の Swift の飾り名（Foundation やライブラリの処理）。最後の受け皿。 */
  { id: 'swift_mangled', re: /^_\$s/, cat: 'runtime', args: null, ret: null, effect: 'runtime' },

  { id: 'file', re: /^_?(open|openat|fopen|fread|fwrite|read|write|close|fclose|lseek|stat|unlink|mkdir|remove)$/i,
    cat: 'io', args: ['path'], ret: 'handle', effect: 'io' },
  { id: 'filemanager', re: /NSFileManager|CFURL|NSBundle|contentsOfFile|writeToFile/i, cat: 'io',
    args: ['path'], ret: 'object', effect: 'io' },

  { id: 'network', re: /^_?(socket|connect|bind|listen|accept|send|sendto|recv|recvfrom|getaddrinfo)$/i,
    cat: 'network', args: ['handle'], ret: 'status', effect: 'network' },
  { id: 'httpapi', re: /NSURLSession|NSURLRequest|NSURLConnection|CFNetwork|CFHTTP|curl_|WKWebView|dataTaskWith/i,
    cat: 'network', args: ['request'], ret: 'object', effect: 'network' },

  { id: 'crypto', re: /^_?(CC(Crypt|SHA|HMAC|Digest)|SecKey|SecTrust|CryptoKit|AES_|SHA256|SHA1_|MD5_|EVP_)/i,
    cat: 'crypto', args: null, ret: 'status', effect: 'crypto' },
  // Security.framework data-retrieval/serialization APIs: no cryptographic
  // operation, they only copy DER representations out of opaque objects (#6182).
  { id: 'security_cert_data', re: /^_?SecCertificateCopyData$/, cat: 'crypto',
    args: ['certificate'], ret: 'object', effect: 'read' },
  { id: 'security_requirement_data', re: /^_?SecRequirementCopyData$/, cat: 'crypto',
    args: ['requirement'], ret: 'object', effect: 'read' },
  { id: 'keychain', re: /SecItem(Add|Copy|Update|Delete)|Keychain/i, cat: 'secret',
    args: ['query'], ret: 'status', effect: 'secret' },
  { id: 'random', re: /^_?(arc4random|arc4random_uniform|SecRandomCopyBytes|rand|random)$/i, cat: 'random',
    args: null, ret: 'number', effect: 'random' },

  { id: 'prefs', re: /NSUserDefaults|CFPreferences/i, cat: 'storage', args: ['key'], ret: 'object', effect: 'storage' },
  { id: 'database', re: /^_?sqlite3_|CoreData|NSManagedObject|NSPersistent/i, cat: 'storage',
    args: null, ret: 'status', effect: 'storage' },

  { id: 'reflect', re: /^_?(NSStringFromClass|NSClassFromString|NSStringFromSelector|NSSelectorFromString|NSStringFromProtocol|class_\w+|sel_\w+|method_\w+|ivar_\w+|object_(get|set)\w+|protocol_\w+)$/,
    cat: 'runtime', args: null, ret: null, effect: 'runtime' },
  { id: 'geometry', re: /^_?CGRectGet(Width|Height|MinX|MinY|MaxX|MaxY|MidX|MidY)$/i,
    cat: 'ui', args: ['rect'], ret: 'number', effect: 'read' },
  { id: 'ui', re: /UIAlert|UIView|UIViewController|presentViewController|UILabel|UIButton|NSAlert|SwiftUI/i,
    cat: 'ui', args: null, ret: 'object', effect: 'ui' },

  { id: 'concurrency', re: /^_?(pthread_|dispatch_(async|sync|once|after|semaphore|get_global_queue|get_main_queue|queue_create)|NSOperation|NSThread)/i,
    cat: 'concurrency', args: null, ret: null, effect: 'concurrency' },
  { id: 'time', re: /^_?(gettimeofday|mach_absolute_time|clock|time|mktime|strptime|localtime(_r)?|gmtime(_r)?|dispatch_time|NSDate|CFAbsoluteTime)$/i, cat: 'time',
    args: null, ret: 'number', effect: 'read' },
  { id: 'dylink', re: /^_?(dlopen|dlsym|dladdr|NSGetExecutablePath)$/i, cat: 'dylink', args: ['name'], ret: 'ptr', effect: 'dylink' },
  { id: 'antidebug', re: /^_?(ptrace|sysctl|task_get_exception_ports|AmIBeingDebugged|isDebuggerAttached)/i,
    cat: 'antidebug', args: null, ret: 'status', effect: 'antidebug' },

  /* Conservative namespace fallbacks. These do not pretend to know the exact
   * ABI of each routine; they identify the subsystem when the exported symbol
   * itself proves it. Precise entries above always win. */
  { id: 'swift_runtime', re: /^_?swift_/i, cat: 'runtime', args: null, ret: null, effect: 'runtime' },
  { id: 'swift_runtime', re: /^__swift_stdlib_/i, cat: 'runtime', args: null, ret: null, effect: 'runtime' },
  { id: 'cxx_runtime', re: /^__?Z/, cat: 'runtime', args: null, ret: null, effect: 'runtime' },
  { id: 'objc_runtime', re: /^_?objc_/i, cat: 'runtime', args: null, ret: null, effect: 'runtime' },
  { id: 'corefoundation', re: /^_?CF[A-Z]/, cat: 'runtime', args: null, ret: null, effect: 'runtime' },
  { id: 'graphics', re: /^_?(?:CG|CGRect|CGPoint|CGSize|CGAffineTransform|UIGraphics|UIImage|CATransform3D|CTFont|CV(?:Pixel|Buffer))/,
    cat: 'ui', args: null, ret: null, effect: 'ui' },
  { id: 'concurrency', re: /^_?(?:dispatch_|os_unfair_lock_|voucher_)/, cat: 'concurrency', args: null, ret: null, effect: 'concurrency' },
  { id: 'network', re: /^_?(?:SCNetwork|nw_|inet_|gethostbyname|getifaddrs)/, cat: 'network', args: null, ret: null, effect: 'network' },
  { id: 'crypto', re: /^_?CC_?(?:Crypt|SHA|HMAC|Digest|MD5|Random)/i, cat: 'crypto', args: null, ret: null, effect: 'crypto' },
  { id: 'compression', re: /^_?(?:deflate|inflate|crc32|get_crc_table|compression_)/, cat: 'memory', args: null, ret: null, effect: 'convert' },
  { id: 'audio', re: /^_?(?:al(?:c)?[A-Z]|AudioServices|ExtAudioFile)/, cat: 'runtime', args: null, ret: null, effect: 'runtime' },
  { id: 'media_time', re: /^_?(?:CMTime|CACurrentMediaTime)/, cat: 'time', args: null, ret: 'number', effect: 'read' },
  { id: 'dyld_runtime', re: /^_?__?dyld_|^_?getsectiondata$/, cat: 'dylink', args: null, ret: null, effect: 'dylink' },
  { id: 'mach_runtime', re: /^_?(?:mach_|task_|thread_|host_|vm_)/, cat: 'runtime', args: null, ret: null, effect: 'runtime' },
  { id: 'foundation_runtime', re: /^_?NS[A-Z]/, cat: 'runtime', args: null, ret: null, effect: 'runtime' },

  { id: 'math', re: /^_?(?:sin|cos|atan2|pow|fmod|exp|exp2|log|log2|log10|frexp|ldexp|nextafter)f?$|^_?__?(?:sincosf?_stret|exp10|invert_f4)$/,
    cat: 'runtime', args: null, ret: 'number', effect: 'read' },
  { id: 'string_runtime', re: /^_?(?:strdup|strtok_r|strtof|sscanf|isxdigit|digittoint|__?tolower)$/,
    cat: 'string', args: null, ret: null, effect: 'read' },
  { id: 'memory_runtime', re: /^_?(?:memset_pattern16|mmap|munmap)$/,
    cat: 'memory', args: null, ret: null, effect: 'runtime' },
  { id: 'unwind_runtime', re: /^_?(?:unw_|backtrace(?:_symbols)?$)/,
    cat: 'runtime', args: null, ret: null, effect: 'runtime' },
  { id: 'posix_runtime', re: /^_?(?:uname|signal|sigaction|getenv|sysconf|strerror(?:_r)?|srand|getpid|sched_yield|nanosleep|clock_gettime(?:_nsec_np)?|timegm|kill|usleep)$/,
    cat: 'runtime', args: null, ret: null, effect: 'runtime' },
  { id: 'file', re: /^_?(?:fseek|fseeko|ftell|rewind|feof|access|getxattr|setxattr|removexattr)$/,
    cat: 'io', args: null, ret: null, effect: 'io' },
  { id: 'regex', re: /^_?reg(?:exec|comp)$/, cat: 'string', args: null, ret: 'status', effect: 'read' },
  { id: 'search_runtime', re: /^_?bsearch$/, cat: 'runtime', args: null, ret: 'ptr', effect: 'read' },
  { id: 'objc_runtime', re: /^_?(?:imp_implementationWithBlock|object_isClass)$/, cat: 'runtime', args: null, ret: null, effect: 'runtime' },
  { id: 'random', re: /^_?arc4random_buf$/, cat: 'random', args: null, ret: null, effect: 'random' },
  { id: 'dylink', re: /^_?dlclose$/, cat: 'dylink', args: null, ret: 'status', effect: 'dylink' },
  { id: 'crypto', re: /^_?FBStringSHA1Hash$/, cat: 'crypto', args: null, ret: null, effect: 'crypto' },
  { id: 'apple_ui_runtime', re: /^_*(?:UnityGetGLViewController|UIAccessibilityIsGuidedAccessEnabled|MTLCreateSystemDefaultDevice|UTTypeCreatePreferredIdentifierForTag|NSDictionaryOfVariableBindings)$/,
    cat: 'ui', args: null, ret: null, effect: 'ui' },
  { id: 'compiler_runtime', re: /^_?(?:__?udivti3|__?invert_f4|__availability_version_check|__tlv_atexit|os_release)$/,
    cat: 'runtime', args: null, ret: null, effect: 'runtime' },

  { id: 'abort', re: /^_?(abort|exit|_exit|__assert_rtn|__stack_chk_fail|objc_exception_throw|_Unwind_Resume|longjmp)$/i,
    cat: 'error', args: null, ret: null, effect: 'abort' },
  { id: 'errno', re: /^_+error$/i, cat: 'runtime', args: null, ret: 'ptr', effect: 'read' },
  { id: 'errorobj', re: /NSError|NSException|error(WithDomain|Description)/i, cat: 'error',
    args: null, ret: 'object', effect: 'error' },
];

/** 名前 → API の知識。知らない名前なら null（知ったかぶりをしない）。 */
export function apiInfo(name) {
  if (typeof name !== 'string') return null;
  const clean = name.trim();
  for (const a of PRECISE_API_TABLE) {
    if (a.re.test(clean)) return a;
  }
  for (const a of API_TABLE) {
    if (a.re.test(clean)) return a;
  }
  return null;
}

/** API の分類 → アプリの機能。Phase 10 の入口。 */
export const FEATURE_OF_CATEGORY = {
  network: 'network', crypto: 'security', secret: 'security', antidebug: 'security',
  storage: 'storage', io: 'storage', database: 'storage',
  ui: 'ui', objc: 'objc', memory: 'data', string: 'data',
  log: 'diagnostics', error: 'diagnostics', concurrency: 'runtime',
  random: 'runtime', time: 'runtime', dylink: 'runtime', runtime: 'runtime',
};

/* ────────────────────────────────────────────────────────────
   命令の事実（Instruction Model）
   ──────────────────────────────────────────────────────────── */

/* The memory mnemonic surface is one authority. A mnemonic missing here loses
 * its memory fact, and for stores the source read is inverted into a
 * destination write. The AdvSIMD structure register-list family belongs here
 * too (#3601). */
const LOAD_MN = /^(ldr|ldrb|ldrh|ldrsb|ldrsh|ldrsw|ldur|ldurb|ldurh|ldursb|ldursh|ldp|ldpsw|ldnp|ldar|ldarb|ldarh|ldxr|ldaxr|ldtr|ldtrb|ldtrh|ldtrsb|ldtrsh|ldtrsw|ld1|ld2|ld3|ld4)$/;
const STORE_MN = /^(str|strb|strh|stur|sturb|sturh|stp|stnp|stlr|stlrb|stlrh|sttr|sttrb|sttrh|stxr|stlxr|st1|st2|st3|st4)$/;
const STRUCTURE_MN = /^(ld1|ld2|ld3|ld4|st1|st2|st3|st4)$/;
/* Exclusive stores are memory stores that still define a 32-bit status result
 * in operand 0; the data operand after it carries the access width (#3592). */
const EXCLUSIVE_STORE_MN = /^(stxr|stlxr)$/;

/* Authenticated indirect branches and calls. `arm64.js` already classifies
 * these as flow/call, so the local surface must agree or the target register is
 * published as a destination write and the CFG loses the terminator (#3592). */
const PAC_INDIRECT_BRANCH_MN = /^(braa|brab|braaz|brabz)$/;
const CALL_MN = /^(bl|blr|blraa|blrab|blraaz|blrabz)$/;
const RET_MN = /^(ret|retaa|retab)$/;
const COND_BRANCH = /^(b\.[a-z]{2}|cbz|cbnz|tbz|tbnz)$/;
const COMPARE_MN = /^(cmp|cmn|tst|ccmp|ccmn|fcmp|fcmpe)$/;

/* LSE atomics that publish the old memory value in a GPR: operand 0 is the
 * source value and operand 1 the result (Arm A64 `LD<op>` family, #3602). */
const ATOMIC_SOURCE_RESULT_RE = /^(?:swp|ld(?:add|set|clr|eor|smax|smin|umax|umin))(?:al|a|l)?(?:b|h)?$/;
/* Without-return aliases (`LD<op> <Ws>, WZR, [<Xn>]`) have no GPR destination:
 * the only register operand is a source read (#3602). */
const ATOMIC_STORE_ONLY_RE = /^st(?:add|clr|eor|set|smax|smin|umax|umin)l?(?:b|h)?$/;
/* CAS keeps the compare-and-result register read-write (#3602). */
const ATOMIC_READ_WRITE_DEST_RE = /^cas(?:al|a|l)?(?:b|h)?$/;
/* Every LSE RMW spelling, for the memory read-modify-write fact. */
const ATOMIC_RMW_MN = /^(?:cas|swp|ld(?:add|set|clr|eor|smax|smin|umax|umin)|st(?:add|clr|eor|set|smax|smin|umax|umin))(?:al|a|l)?(?:b|h)?$/;

/**
 * レジスタを 1 つの鍵にする。zr は値を持たないので追跡しない。
 * A lane operand (`v0.s[1]`) names the same physical vector register as the
 * whole-register spelling, so it must normalize to the same key (#3877).
 */
function regKey(op) {
  if (!op) return null;
  if (op.k === 'elem') return Number.isInteger(op.num) && op.num >= 0 && op.num <= 31 ? 'v' + op.num : null;
  if (op.k !== 'reg') return null;
  if (op.cls === 'zr') return null;
  if (op.cls === 'sp') return 'sp';
  if (op.cls === 'gp') return 'x' + op.num;
  if (op.cls === 'fp' || op.cls === 'vec') return 'v' + op.num;
  return null;
}

/** 汎用レジスタ番号（x0〜x30）。それ以外は -1。 */
function gpNum(key) {
  if (!key || key[0] !== 'x') return -1;
  const n = Number(key.slice(1));
  return Number.isInteger(n) && n >= 0 && n <= 30 ? n : -1;
}

/** 書き込み先になるオペランドの位置。読み書きなしなら空。 */
function writeIndexes(base, ops) {
  // Exclusive stores take the data register from operand 1 and define the
  // 32-bit status result in operand 0 (#3592).
  if (EXCLUSIVE_STORE_MN.test(base)) return ops.length > 1 ? [0] : [];
  // Without-return LSE aliases are read-modify-write stores with no GPR result.
  if (ATOMIC_STORE_ONLY_RE.test(base)) return [];
  // Returning LSE atomics write the old memory value into operand 1; operand 0
  // is the source value, so the generic [0] fallback would invert them (#3602).
  if (ATOMIC_SOURCE_RESULT_RE.test(base)) return ops.length > 1 ? [1] : [];
  if (STORE_MN.test(base)) return [];
  if (base === 'ldp' || base === 'ldpsw' || base === 'ldnp') return [0, 1];
  if (COMPARE_MN.test(base)) return [];
  if (CALL_MN.test(base) || RET_MN.test(base)) return [];
  if (COND_BRANCH.test(base) || base === 'b' || base === 'br' || PAC_INDIRECT_BRANCH_MN.test(base) || /^b\./.test(base)) return [];
  if (/^(nop|hint|bti|svc|brk|udf|dmb|dsb|isb|prfm|msr|sys|yield|wfe|wfi|sev|paciasp|pacibsp|autiasp|autibsp|xpaclri)$/.test(base)) return [];
  if (base.charCodeAt(0) === 46) return [];   // .byte
  return ops.length ? [0] : [];
}

/** そのオペランドが読んでいるレジスタを集める。 */
function collectReads(op, into) {
  if (!op) return;
  if (op.k === 'reg' || op.k === 'elem') { const k = regKey(op); if (k) into.add(k); }
  else if (op.k === 'mem') {
    const b = regKey(op.base); if (b) into.add(b);
    const i = regKey(op.index); if (i) into.add(i);
  } else if (op.k === 'list') {
    for (const r of op.regs || []) { const k = regKey(r); if (k) into.add(k); }
  }
}

/** 分岐 / 参照先のアドレス。パース済みオペランドから求める（二度手間を避ける）。 */
function targetOf(base, ops) {
  const isBranchImm = base === 'b' || base === 'bl' || /^b\.[a-z]{2}$/.test(base) ||
    base === 'cbz' || base === 'cbnz' || base === 'tbz' || base === 'tbnz';
  if (isBranchImm || base === 'adr' || base === 'adrp') {
    const isBitTestBranch = base === 'tbz' || base === 'tbnz';
    // TBZ/TBNZ have a fixed three-operand shape: register, bit index, target.
    // If the architectural target is absent or malformed, do not reinterpret
    // the bit index as a branch destination.
    if (isBitTestBranch && (ops.length !== 3 || ops[2].k !== 'imm')) return null;
    // The last immediate is the architectural target (the preceding
    // immediate in TBZ/TBNZ is the bit index).  Zero is a valid address, but
    // negative values remain invalid target evidence and must not make us
    // fall back to that bit index.
    const target = isBitTestBranch ? ops[2] : [...ops].reverse().find((op) => op.k === 'imm');
    return target && target.value != null && target.value >= 0n ? target.value : null;
  }
  if (base === 'ldr' && ops.length === 2 && ops[1].k === 'imm' && ops[1].value != null && ops[1].value >= 0n) {
    return ops[1].value;
  }
  return null;
}

/** アクセスするバイト数（分かる範囲で）。 */
function accessSize(base, ops) {
  if (/^(ldrb|ldrsb|strb|sturb|ldurb|ldursb|ldarb|stlrb|ldtrb|ldtrsb|sttrb)$/.test(base)) return 1;
  if (/^(ldrh|ldrsh|strh|sturh|ldurh|ldursh|ldarh|stlrh|ldtrh|ldtrsh|sttrh)$/.test(base)) return 2;
  if (/^(ldrsw|ldursw|ldtrsw)$/.test(base)) return 4;
  // Exclusive stores move the data operand (operand 1), never the 32-bit
  // status result that comes first (#3592).
  if (EXCLUSIVE_STORE_MN.test(base)) {
    const data = ops.find((o, i) => i > 0 && o.k === 'reg');
    return data && data.bits ? data.bits / 8 : 4;
  }
  // LSE atomic size suffixes override the register width (byte/halfword forms
  // move 1 or 2 bytes even though the source/result registers are 32-bit).
  if (ATOMIC_RMW_MN.test(base)) {
    if (base.endsWith('b')) return 1;
    if (base.endsWith('h')) return 2;
  }
  if (STRUCTURE_MN.test(base)) {
    const list = ops.find((o) => o.k === 'list');
    const regs = list ? (list.regs || []) : [];
    if (!regs.length) return null;
    let total = 0;
    for (const r of regs) {
      const bytes = vectorRegisterBytes(r);
      // One unproven list member makes the whole structure transfer unproven.
      if (bytes === null) return null;
      total += bytes;
    }
    return total > 0 ? total : null;
  }
  const reg = ops.find((o) => o.k === 'reg');
  const w = reg && reg.bits ? reg.bits / 8 : 8;
  if (base === 'ldp' || base === 'stp' || base === 'ldnp' || base === 'stnp') return w * 2;
  return w;
}

/** Structure-register-list element width. `v0.8b` moves 8 bytes, not 16.
 * Only an explicit arrangement proves the transfer width: a bare vector
 * register (`{v0}`) publishes the physical 128-bit V width, not the memory
 * footprint, and a lane spelling the operand grammar did not structure
 * (`{v0.h}[3]`) proves nothing, so both fail closed to null (#8713, #8780). */
function vectorRegisterBytes(reg) {
  if (!reg || reg.k !== 'reg' || !reg.arr) return null;
  const m = /^(\d+)([bhsd])$/i.exec(reg.arr);
  if (!m) return null;
  const bytes = Number(m[1]) * ({ b: 1, h: 2, s: 4, d: 8 }[m[2].toLowerCase()] || 0);
  return bytes > 0 ? bytes : null;
}

/**
 * 1 命令を「事実」に変える。ここには推測を入れない。
 *
 * @param {{row:number,address:BigInt,mn:string,ops:string}} raw
 */
export function makeInstruction(raw) {
  const mn = raw.mn || '';
  const base = mn.toLowerCase();
  const opsStr = raw.ops || '';
  let parsed = [];
  let parseError = null;
  try { parsed = parseOperands(opsStr); }
  catch (error) {
    parsed = [];
    parseError = { stage:'operands', message:error?.message || String(error), text:opsStr };
  }

  const insn = {
    row: raw.row,
    address: raw.address,
    mnemonic: mn,
    operands: opsStr,
    ops: parsed,
    // Fixed-width A64 encoding, when the producer had the bytes. Effect lifters
    // read decoder-lossy fields from it; nothing here interprets it.
    word: typeof raw.word === 'number' && Number.isSafeInteger(raw.word) ? raw.word >>> 0 : null,
    parseError,
    category: categoryOf(base),
    reads: [],
    writes: [],
    role: 'other',            // 命令ひとつぶんの役割（Semantic Block の材料）
    source: null,             // 主な入力オペランド
    destination: null,        // 主な出力オペランド
    callTarget: null,
    branchTarget: null,
    isCall: CALL_MN.test(base),
    isReturn: RET_MN.test(base),
    isBranch: false,
    isConditional: false,
    memory: null,             // {kind:'load'|'store', base, disp, size, stack}
    data: base.charCodeAt(0) === 46,
    unknownMnemonic: false,
  };

  const wIdx = writeIndexes(base, parsed);
  const reads = new Set();
  const destIsRead = arm64ReadsDestination(base);
  for (let i = 0; i < parsed.length; i++) {
    const op = parsed[i];
    if (wIdx.includes(i) && (op.k === 'reg' || op.k === 'elem' || op.k === 'list')) {
      // A lane destination always merges into the physical register, CAS keeps
      // its compare/result register read-write (#3602), and a register-list
      // destination is write-only rather than also an input (#3601, #3877).
      if (op.k !== 'elem' && !(i === 0 && destIsRead) && !ATOMIC_READ_WRITE_DEST_RE.test(base)) continue;
    }
    collectReads(op, reads);
  }
  // 書き込みつきのメモリ参照は、ベースレジスタを読みかつ書く
  for (const op of parsed) {
    if (op.k !== 'mem') continue;
    collectReads(op, reads);
  }
  const writes = new Set();
  for (const i of wIdx) {
    const op = parsed[i];
    if (!op) continue;
    // `ld1 {v0.16b}, [x1]` writes every register in the list.
    if (op.k === 'list') {
      for (const r of op.regs || []) { const k = regKey(r); if (k) writes.add(k); }
      continue;
    }
    const k = regKey(op);
    if (k) writes.add(k);
  }
  for (const op of parsed) {
    if (op.k === 'mem' && (op.mode === 'pre' || op.mode === 'post')) {
      const k = regKey(op.base);
      if (k) writes.add(k);
    }
  }
  insn.reads = Array.from(reads);
  // BL/BLR (and authenticated link forms) architecturally write X30/LR with
  // the return address. Expose that implicit write to generic dataflow users.
  if (insn.isCall) writes.add('x30');
  insn.writes = Array.from(writes);
  insn.destination = wIdx.length ? parsed[wIdx[0]] || null : null;
  // When the destination is not operand 0 (LSE `LD<op> <Ws>, <Wt>, [<Xn>]`)
  // the source value is operand 0, not the operand after the destination.
  const srcIndex = wIdx.length && wIdx[0] === 0 ? 1 : 0;
  insn.source = parsed.length > 1 ? parsed[srcIndex] || null : (parsed[0] || null);

  const mem = parsed.find((o) => o.k === 'mem') || null;
  const atomicRmw = ATOMIC_RMW_MN.test(base);
  if (mem && (LOAD_MN.test(base) || STORE_MN.test(base) || atomicRmw)) {
    insn.memory = {
      kind: atomicRmw ? 'atomic' : (LOAD_MN.test(base) ? 'load' : 'store'),
      base: regKey(mem.base),
      disp: mem.addressDisp && mem.addressDisp.value != null ? mem.addressDisp.value : (mem.disp && mem.disp.value != null ? mem.disp.value : null),
      writebackDisp: mem.writebackDisp && mem.writebackDisp.value != null ? mem.writebackDisp.value : null,
      indexed: !!mem.index,
      // 添字レジスタ。フィールドの位置がここに載ってくる形（非固定 ABI）を解くのに要る
      index: mem.index ? regKey(mem.index) : null,
      indexAddr: null,          // その添字がどこから読まれたか（analyzeDataFlow が埋める）
      size: accessSize(base, parsed),
      stack: mem.base ? (mem.base.cls === 'sp' || (mem.base.cls === 'gp' && mem.base.num === 29)) : false,
      mode: mem.mode,
    };
    // Atomic read-modify-write touches memory in both directions (#3602).
    if (atomicRmw) { insn.memory.read = true; insn.memory.write = true; }
  }

  const t = targetOf(base, parsed);
  if (insn.isCall) {
    insn.callTarget = base === 'bl' ? t : null;
    insn.isBranch = true;
  } else if (base === 'b' || base === 'br' || PAC_INDIRECT_BRANCH_MN.test(base) || COND_BRANCH.test(base) || /^b\./.test(base)) {
    insn.branchTarget = (base === 'br' || PAC_INDIRECT_BRANCH_MN.test(base)) ? null : t;
    insn.isBranch = true;
    insn.isConditional = COND_BRANCH.test(base);
  } else if (base === 'adrp' || base === 'adr') {
    insn.branchTarget = null;
    insn.pcRelTarget = t;
  } else if (base === 'ldr' && t != null) {
    insn.pcRelTarget = t;
  }
  if (insn.isReturn) insn.isBranch = true;

  insn.role = instructionRole(insn, base);
  if (!insn.category && !insn.data && !insn.isBranch) insn.unknownMnemonic = true;
  return insn;
}

/** 命令ひとつぶんの役割。Semantic Block の下ごしらえ。 */
function instructionRole(insn, base) {
  if (insn.data) return 'data';
  if (insn.isReturn) return ROLE.FUNCTION_EXIT;
  if (insn.isCall) return ROLE.FUNCTION_CALL;
  if (COMPARE_MN.test(base)) return ROLE.CONDITION_CHECK;
  if (COND_BRANCH.test(base)) return ROLE.CONDITION_CHECK;
  if (base === 'b' || base === 'br') return ROLE.BRANCH;
  if (base === 'adrp' || base === 'adr') return ROLE.ADDRESS_CALCULATION;
  if (insn.memory) {
    if (insn.memory.kind === 'load') return ROLE.MEMORY_READ;
    // An atomic read-modify-write is memory-effect-bearing, not quiet: it keeps
    // the MEMORY_WRITE role and publishes both effect halves on its group (#8781).
    return ROLE.MEMORY_WRITE;
  }
  if (/^(paciasp|pacibsp|bti|nop|hint)$/.test(base)) return 'quiet';
  if (/^(autiasp|autibsp)$/.test(base)) return ROLE.CLEANUP;
  if (/^(mov|movz|movk|movn|mvn|fmov)$/.test(base)) return ROLE.REGISTER_SETUP;
  const c = insn.category;
  if (c === 'arith' || c === 'logic' || c === 'select' || c === 'float' || c === 'simd') return ROLE.VALUE_CALCULATION;
  if (c === 'system' || c === 'atomic') return 'quiet';
  return ROLE.UNKNOWN;
}

/* ────────────────────────────────────────────────────────────
   値（レジスタが今なにを持っていそうか）
   ──────────────────────────────────────────────────────────── */

/*
 * kind:
 *   'unknown'    分からない ← いちばん大事な値。無理に埋めない。
 *   'imm'        定数           value: BigInt
 *   'arg'        関数の引数     index
 *   'address'    アドレス       addr（adrp+add / adr で作られたもの）
 *   'loaded'     メモリから読んだ値   at: {base, disp} / addr
 *   'callResult' 呼び出しの戻り値     call: {row,name,api}
 *   'stack'      スタック上の場所     offset
 *   'copy'       別のレジスタの写し   （元の値をそのまま引き継ぐので通常は現れない）
 *   'computed'   計算結果       op, inputs
 */
export function unknownValue(reason) {
  return { kind: 'unknown', conf: SCORE.unknown, ev: reason ? [reason] : [], def: -1 };
}

function value(kind, extra, conf, evList, def) {
  return Object.assign({ kind, conf: conf == null ? SCORE.high : conf, ev: evList || [], def: def == null ? -1 : def },
    extra || {});
}

/* ────────────────────────────────────────────────────────────
   データフロー
   ──────────────────────────────────────────────────────────── */

/*
 * 完全な SSA は作らない。ARM64 の定型（adrp+add、引数レジスタ、呼び出し規約、
 * スタックへの退避）に強い、線形の簡易解析にとどめる。
 *
 * 合流点（分岐で飛んでこられる行）ではレジスタの状態を捨てる。
 * ここで欲張ると「根拠のない断定」が生まれるので、あえて忘れる。
 */

const CALLER_SAVED = 18;   // x0〜x17 は呼び出しで壊れる（x18 はプラットフォーム予約）

function toLinkReturnAddress(address) {
  try {
    if (address == null) return null;
    if (typeof address === 'number' && !Number.isSafeInteger(address)) return null;
    if (typeof address === 'string' && !/^(?:\d+|0[xX][0-9a-fA-F]+)$/.test(address.trim())) return null;
    if (!['bigint', 'number', 'string'].includes(typeof address)) return null;
    const pc = typeof address === 'bigint' ? address : BigInt(address);
    if (pc < 0n) return null;
    return pc + 4n;
  } catch { return null; }
}

const coordBig = (v) => typeof v === 'bigint' ? v : (typeof v === 'number' && Number.isSafeInteger(v) ? BigInt(v) : null);

const ARG_UNIVERSE = ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7'];

// 「その命令地点に到達するまでに entry 値が必ず死んでいる」レジスタ集合を、
// CFG を跨いで must-interpret で求める。join では全 predecessor で kill 済みの
// ものだけを保つので、片側 path だけの書き込みが entry 引数を消さない（#3921）。
// CFG 情報（blocks/preds）が無ければ null を返し、呼び出し側は従来の線形挙動。
function computeEntryKillSets(insns, o) {
  const blocks = o.blocks;
  const preds = o.preds;
  if (!Array.isArray(blocks) || !blocks.length || !Array.isArray(preds) || preds.length !== blocks.length) return null;
  if (!insns.length) return null;

  const byRow = new Map();
  for (const insn of insns) byRow.set(insn.row, insn);

  const genWrites = (block) => {
    const gen = new Set();
    for (const row of block.rows) {
      const insn = byRow.get(row);
      if (!insn || insn.data || insn.unknownMnemonic) continue;
      for (const w of insn.writes) if (ARG_UNIVERSE.includes(w)) gen.add(w);
    }
    return gen;
  };

  let entryIndex = -1;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.startRow <= insns[0].row && insns[0].row <= b.endRow) { entryIndex = i; break; }
  }
  if (entryIndex < 0) entryIndex = 0;

  const top = () => new Set(ARG_UNIVERSE);
  const killIn = blocks.map((b, i) => (i === entryIndex ? new Set() : top()));
  const gen = blocks.map((b) => genWrites(b));
  for (let iter = 0; iter <= blocks.length + 1; iter++) {
    let changed = false;
    for (let i = 0; i < blocks.length; i++) {
      if (i === entryIndex) continue;
      let next;
      const ps = preds[i];
      if (!Array.isArray(ps) || !ps.length) next = new Set();
      else {
        next = top();
        for (const p of ps) {
          const out = new Set(killIn[p]);
          for (const w of gen[p]) out.add(w);
          for (const r of next) if (!out.has(r)) next.delete(r);
        }
      }
      if (next.size !== killIn[i].size) changed = true;
      else for (const r of next) { if (!killIn[i].has(r)) { changed = true; break; } }
      killIn[i] = next;
    }
    if (!changed) break;
  }

  const rowKills = new Map();
  const blockStartRows = new Set();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    blockStartRows.add(b.startRow);
    for (const row of b.rows) rowKills.set(row, killIn[i]);
  }
  return { rowKills, blockStartRows };
}

export function analyzeDataFlow(insns, opts) {
  const o = opts || {};
  const joinRows = o.joinRows || new Set();
  const regs = new Map();            // regKey -> value
  const stack = new Map();           // 'sp+off' -> value
  // Concrete stack bytes proven by a same-frame constant store, keyed by
  // 'base#absOffset'. A present cell is a known 0..255 byte; clearing a cell
  // marks it uncertain (#8763).
  const stackBytes = new Map();
  const stackFrame = new Map();
  const stackFrameLost = new Set();
  const flows = [];                  // データの流れ（テストで検証する対象）
  const calls = [];
  const argsRead = new Set();        // 自分で書く前に読んだ x0〜x7 = 引数
  const written = new Set();
  const cfgKills = computeEntryKillSets(insns, o);
  const rowKills = cfgKills ? cfgKills.rowKills : null;
  const blockStartRows = cfgKills ? cfgKills.blockStartRows : null;
  const addressRefs = [];            // {row, addr, value} — 文字列を後から埋める用
  const byRow = new Map();

  const get = (key) => regs.get(key) || null;
  const set = (key, v) => { if (key) regs.set(key, v); };
  const flow = (kind, row, from, to, v) => {
    const f = { kind, row, from, to, value: v || null };
    flows.push(f);
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row).push(f);
    return f;
  };

  /*
   * #8763: a stack slot's value can only be forwarded when the *accessed byte
   * range* is proven. A narrower load, or a later overlapping partial store,
   * changes which bytes a reload must return, so the concrete bytes are tracked
   * per byte offset rather than per whole slot. Only an integer GP load/store
   * with a stable stack offset is modelled; anything else keeps the previous
   * behavior.
   */
  const byteCell = (baseKey, off) => baseKey + '#b#' + off;
  const SIGNED_NARROW_LOAD = /^(ldrsb|ldrsh|ldursb|ldursh|ldrsw|ldursw|ldtrsb|ldtrsh|ldtrsw)$/;
  const isGPWrite = (dst) => typeof dst === 'string' && dst.charCodeAt(0) === 120 /* 'x' */;
  function concreteStoreBytes(v, width) {
    if (!v || v.kind !== 'imm' || typeof v.value !== 'bigint') return null;
    if (!Number.isInteger(width) || width < 1 || width > 8) return null;
    const mod = 1n << BigInt(width * 8);
    let x = ((v.value % mod) + mod) % mod;
    const out = new Array(width);
    for (let i = 0; i < width; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
    return out;
  }
  function writeStackBytes(baseKey, absOff, width, v) {
    if (baseKey == null || width == null) return;
    const bytes = concreteStoreBytes(v, width);
    for (let i = 0; i < width; i++) {
      const cell = byteCell(baseKey, absOff + BigInt(i));
      if (bytes) stackBytes.set(cell, bytes[i]);
      else stackBytes.delete(cell);
    }
  }
  function readStackBytes(baseKey, absOff, width, signed) {
    if (baseKey == null || width == null || width < 1 || width > 8) return null;
    let acc = 0n;
    for (let i = 0; i < width; i++) {
      const b = stackBytes.get(byteCell(baseKey, absOff + BigInt(i)));
      if (b == null) return null;
      acc |= BigInt(b) << BigInt(8 * i);
    }
    if (signed) {
      const mod = 1n << BigInt(width * 8);
      if (acc >= mod / 2n) acc -= mod;
    }
    return acc;
  }

  for (let i = 0; i < insns.length; i++) {
    const insn = insns[i];
    const base = insn.mnemonic.toLowerCase();

    // 分岐で飛んでこられる場所 = 合流点。ここから先は前提を持ち越せない。
    if (joinRows.has(insn.row)) { regs.clear(); stack.clear(); stackBytes.clear(); stackFrame.clear(); stackFrameLost.clear(); }
    if (rowKills && blockStartRows.has(insn.row)) written.clear();

    // 引数レジスタの検出は「自分で書く前に読んだか」で判定する
    const pathKilled = rowKills ? rowKills.get(insn.row) : null;
    for (const r of insn.reads) {
      const n = gpNum(r);
      if (n >= 0 && n <= 7 && !written.has(r) && !(pathKilled && pathKilled.has(r))) {
        argsRead.add(n);
        if (!regs.has(r)) {
          set(r, value('arg', { index: n }, SCORE.high, [ev('argreg', insn.row, { index: n })], -1));
        }
      }
    }

    if (insn.data || insn.unknownMnemonic) {
      // 読めない命令のあとは、何が起きたか分からない。手前の推測は捨てる。
      for (const w of insn.writes) regs.delete(w);
      continue;
    }

    /* ── adrp / adr: アドレスの土台 ── */
    if (base === 'adrp' || base === 'adr') {
      const dst = insn.writes[0];
      const addr = insn.pcRelTarget != null ? insn.pcRelTarget : null;
      if (dst && addr != null) {
        const v = value('address', { addr, page: base === 'adrp', partial: base === 'adrp' },
          base === 'adr' ? SCORE.confirmed : SCORE.high,
          [ev('pcrel', insn.row, { addr, page: base === 'adrp' })], insn.row);
        set(dst, v);
        flow('addr-calc', insn.row, null, dst, v);
        if (base === 'adr') addressRefs.push({ row: insn.row, addr, value: v });
      } else if (dst) set(dst, unknownValue(ev('nodata', insn.row)));
      markWritten(insn, written);
      continue;
    }

    /* ── add xD, xN, #imm: adrp と組ならアドレスの完成 ── */
    if (base === 'add' && insn.ops.length >= 3 && insn.ops[1] && insn.ops[1].k === 'reg' &&
        insn.ops[2] && insn.ops[2].k === 'imm' && insn.ops[2].value != null) {
      const src = regKey(insn.ops[1]);
      const dst = insn.writes[0];
      const prev = src ? get(src) : null;
      const immediate = insn.ops[2];
      const shift = immediate.shift;
      const offset = !shift
        ? immediate.value
        : shift.op === 'lsl' && (shift.amount === 0 || shift.amount === 12)
          ? immediate.value << BigInt(shift.amount)
          : null;
      if (dst && prev && prev.kind === 'address' && prev.partial && offset != null) {
        let addr = prev.addr + offset;
        // #8747: `add wD, xN, #imm` writes only the low destination width, so the
        // completed address must be masked to that width; the upper bits were not
        // written and cannot be claimed as part of the effective address.
        const dreg = insn.ops[0];
        const dstBits = (dreg && dreg.k === 'reg' && Number.isFinite(dreg.bits)) ? dreg.bits : 64;
        if (dstBits < 64) addr = addr & ((1n << BigInt(dstBits)) - 1n);
        const v = value('address', { addr, page: false, partial: false }, SCORE.confirmed,
          prev.ev.concat([ev('adrp-add', insn.row, { addr })]), insn.row);
        set(dst, v);
        flow('addr-calc', insn.row, src, dst, v);
        addressRefs.push({ row: insn.row, addr, value: v });
        markWritten(insn, written);
        continue;
      }
    }

    /* ── mov / movz など: レジスタ間コピーと即値 ── */
    if (base === 'mov' || base === 'fmov') {
      const dst = insn.writes[0];
      const s = insn.ops[1];
      if (dst && s && s.k === 'imm' && s.value != null) {
        const v = value('imm', { value: s.value }, SCORE.confirmed, [ev('imm', insn.row, { value: s.value })], insn.row);
        set(dst, v);
        flow('imm->reg', insn.row, null, dst, v);
      } else if (dst && s && s.k === 'reg') {
        const src = regKey(s);
        const prev = src ? get(src) : null;
        // #8747: an integer MOV into a narrowed (sub-64-bit, e.g. W) destination
        // zero-extends/truncates, so a full-width source value must not keep its
        // complete constant or pointer authority. Publish only the low `dstBits`
        // and drop any inherited full-register alias for the truncated result.
        const dreg = insn.ops[0];
        const dstBits = (base === 'mov' && dreg && dreg.k === 'reg' && Number.isFinite(dreg.bits)) ? dreg.bits : 64;
        const concreteSrc = prev && (prev.kind === 'imm' ? prev.value : prev.kind === 'address' ? prev.addr : null);
        if (prev && dstBits < 64 && typeof concreteSrc === 'bigint') {
          const mask = (1n << BigInt(dstBits)) - 1n;
          const low = concreteSrc & mask;
          const v = value('imm', { value: low }, SCORE.confirmed,
            prev.ev.concat([ev('copy-trunc', insn.row, { from: src, to: dst, bits: dstBits })]), insn.row);
          set(dst, v);
          flow('reg->reg', insn.row, src, dst, v);
        } else {
          const v = prev
            ? Object.assign({}, prev, { def: insn.row, via: src, ev: prev.ev.concat([ev('copy', insn.row, { from: src, to: dst })]) })
            : unknownValue(ev('untracked', insn.row, { from: src }));
          set(dst, v);
          flow('reg->reg', insn.row, src, dst, v);
        }
      } else if (dst) {
        set(dst, unknownValue(ev('untracked', insn.row)));
      }
      markWritten(insn, written);
      continue;
    }
    if (base === 'movz') {
      const dst = insn.writes[0];
      const s = insn.ops[1];
      if (dst && s && s.k === 'imm' && s.value != null) {
        const shift = s.shift && s.shift.amount ? BigInt(s.shift.amount) : 0n;
        const v = value('imm', { value: s.value << shift }, SCORE.confirmed,
          [ev('imm', insn.row, { value: s.value << shift })], insn.row);
        set(dst, v);
        flow('imm->reg', insn.row, null, dst, v);
      } else if (dst) set(dst, unknownValue(ev('untracked', insn.row)));
      markWritten(insn, written);
      continue;
    }
    if (base === 'movk') {
      // 16 ビットずつ組み立てている途中。完成するまで値を確定させない。
      const dst = insn.writes[0];
      if (dst) set(dst, unknownValue(ev('building', insn.row)));
      markWritten(insn, written);
      continue;
    }

    /* ── メモリ ── */
    if (insn.memory) {
      const m = insn.memory;
      /*
       * 添字レジスタが「どこから読まれた値か」を残す。
       * `ldr x0, [x0, x8]` の x8 が _OBJC_IVAR_$_Class._field から来ていれば、
       * ずらし幅が命令に無くても、触っているフィールドを名指しできる（fields.js）。
       */
      if (m.index) {
        const iv = get(m.index);
        m.indexAddr = iv && iv.kind === 'loaded' && iv.addr != null ? iv.addr : null;
      }
      const frameLost = m.stack && m.base ? stackFrameLost.has(m.base) : false;
      const accessDisp = m.disp != null ? coordBig(m.disp) : (!m.indexed && m.base ? 0n : null);
      const frameDelta = m.stack && !frameLost && m.base ? stackFrame.get(m.base) || 0n : 0n;
      let slot = null;
      if (m.stack && m.base && !m.indexed && !frameLost && accessDisp != null) {
        slot = m.base + '+' + (frameDelta + accessDisp).toString();
      }
      const isPair = base === 'ldp' || base === 'ldpsw' || base === 'ldnp' ||
        base === 'stp' || base === 'stnp';
      const stride = isPair && accessDisp != null ? BigInt(Math.floor(m.size / 2)) : 0n;
      const elemWidth = Number.isInteger(m.size) ? (isPair ? Math.floor(m.size / 2) : m.size) : null;
      const elemSlot = (idx) => (slot && idx > 0
        ? m.base + '+' + (frameDelta + accessDisp + stride * BigInt(idx)).toString()
        : slot);
      const elemAbs = (idx) => (accessDisp == null ? null : frameDelta + accessDisp + stride * BigInt(idx));

      if (m.kind === 'load') {
        let di = 0;
        for (const dst of insn.writes) {
          if (dst === m.base && insn.ops.some((x) => x.k === 'mem' && (x.mode === 'pre' || x.mode === 'post'))) continue;
          const dSlot = isPair ? elemSlot(di) : slot;
          const dDisp = isPair && accessDisp != null
            ? accessDisp + stride * BigInt(di)
            : m.disp;
          di++;
          let v;
          const cached = !isPair || base === 'ldp' || base === 'ldnp'
            ? (dSlot ? stack.get(dSlot) : null)
            : null;
          const absOff = elemAbs(di - 1);
          // #8763: only forward a concrete stack value when the exact accessed
          // byte range is still proven by the per-byte cache. A narrower load,
          // a signed load, or an overlapping partial store must not reuse the
          // stale whole-slot value; fall back to an uncertain memory load.
          if (cached && cached.kind === 'imm' && slot && absOff != null && elemWidth != null && isGPWrite(dst)) {
            const assembled = readStackBytes(m.base, absOff, elemWidth, SIGNED_NARROW_LOAD.test(base));
            if (assembled == null) {
              v = value('loaded', { at: { base: m.base, disp: dDisp }, addr: null, size: elemWidth },
                SCORE.inferred, [ev('stack-bytes-unknown', insn.row, { slot: dSlot, width: elemWidth })], insn.row);
              flow('mem->reg', insn.row, m.base, dst, v);
            } else {
              v = value('imm', { value: assembled }, SCORE.confirmed,
                cached.ev.concat([ev('stack-bytes', insn.row, { slot: dSlot, width: elemWidth })]), insn.row);
              flow('stack->reg', insn.row, dSlot, dst, v);
            }
          } else if (cached) {
            v = Object.assign({}, cached, { def: insn.row, ev: cached.ev.concat([ev('stack-reload', insn.row, { slot: dSlot })]) });
            flow('stack->reg', insn.row, dSlot, dst, v);
          } else {
            const baseVal = m.base ? get(m.base) : null;
            // adrp（ページの先頭）＋ ldr の即値でも、指している場所は確定する。
            // __objc_selrefs からメソッド名を引くのがまさにこの形。
            const addr = baseVal && baseVal.kind === 'address' && dDisp != null
              ? baseVal.addr + dDisp : null;
            v = value('loaded', { at: { base: m.base, disp: dDisp }, addr, size: m.size },
              SCORE.high, [ev('load', insn.row, { base: m.base, disp: dDisp, addr })], insn.row);
            flow('mem->reg', insn.row, m.base, dst, v);
            if (addr != null) addressRefs.push({ row: insn.row, addr, value: v, load: true });
          }
          set(dst, v);
        }
      } else if (m.kind === 'atomic') {
        // Read-modify-write: the source operand is stored and the old memory
        // value flows into the result register, which is not the source and is
        // therefore not recoverable from the operands alone (#3602).
        const src = insn.ops[0] ? regKey(insn.ops[0]) : null;
        const srcVal = src ? get(src) : null;
        flow('reg->mem', insn.row, src, slot || (m.base || 'mem'), srcVal);
        for (const dst of insn.writes) {
          const v = value('loaded', { at: { base: m.base, disp: m.disp }, addr: null, size: m.size },
            SCORE.inferred, [ev('atomic-rmw', insn.row, { base: m.base, disp: m.disp })], insn.row);
          set(dst, v);
          flow('mem->reg', insn.row, m.base, dst, v);
        }
      } else {
        const srcCount = isPair ? 2 : 1;
        for (let idx = 0; idx < srcCount; idx++) {
          const src = insn.ops[idx] ? regKey(insn.ops[idx]) : null;
          const v = src ? get(src) : null;
          const sSlot = isPair ? elemSlot(idx) : slot;
          flow('reg->mem', insn.row, src, sSlot || (m.base || 'mem'), v);
          if (sSlot) {
            if (v) stack.set(sSlot, Object.assign({}, v, { ev: v.ev.concat([ev('stack-save', insn.row, { slot: sSlot })]) }));
            else stack.set(sSlot, unknownValue(ev('untracked', insn.row)));
            const absOff = elemAbs(idx);
            if (absOff != null) writeStackBytes(m.base, absOff, elemWidth, v);
          }
        }
      }
      if (m.stack && m.base && !m.indexed && (m.mode === 'pre' || m.mode === 'post')) {
        const wb = coordBig(m.writebackDisp);
        if (wb != null && !stackFrameLost.has(m.base)) {
          stackFrame.set(m.base, (stackFrame.get(m.base) || 0n) + wb);
        } else {
          stackFrameLost.add(m.base);
          stackFrame.delete(m.base);
          const slotPrefix = m.base + '+';
          const bytePrefix = m.base + '#b#';
          for (const k of Array.from(stack.keys())) {
            if (k.startsWith(slotPrefix)) stack.delete(k);
          }
          for (const k of Array.from(stackBytes.keys())) {
            if (k.startsWith(bytePrefix)) stackBytes.delete(k);
          }
        }
      }
      markWritten(insn, written);
      continue;
    }

    /* ── 呼び出し ── */
    if (insn.isCall) {
      const tailProof = indirectExternalTailTransferProof(insn);
      const name = tailProof?.targetName
        || (insn.callTarget != null && o.symbolFor ? o.symbolFor(insn.callTarget) : null);
      const api = apiInfo(name);
      const args = [];
      for (let a = 0; a <= 7; a++) {
        const v = get('x' + a);
        if (!v) continue;
        args.push({ index: a, value: v, role: api && api.args ? (api.args[a] || null) : null });
        flow('reg->arg', insn.row, 'x' + a, 'arg' + a, v);
      }
      /*
       * Xcode 14 以降のメソッド呼び出しは `_objc_msgSend$doSomething:` という
       * 名前の中継地点を呼ぶ形になる。セレクタは第 2 引数ではなく **名前の中** にある。
       * ここを拾わないと、いまのアプリでは「何というメソッドを呼んでいるか」が
       * 1 件も言えない（呼び出し側に selref が残っていないため）。
       */
      const sel = name ? /objc_msgSend(?:Super2?)?\$(.+)$/.exec(name) : null;
      const call = {
        row: insn.row, address: insn.address, target: insn.callTarget,
        name: name || null, api: api || null, args,
        selector: sel ? sel[1] : null,
        indirect: insn.callTarget == null && !tailProof,
        ...(tailProof ? { tailTransfer:true, pointerAddress:tailProof.pointerAddress } : {}),
      };
      calls.push(call);
      // 呼び出しで x0〜x17 は壊れる。x0 だけは戻り値として意味を持つ。
      for (let a = 0; a < CALLER_SAVED; a++) regs.delete('x' + a);
      // BL/BLR は分岐と同時に X30/LR を書く（Arm ISA: branch-with-link は
      // return address を X30 に格納する）。呼び出し前の X30 値は必ず死ぬ。
      // 末尾呼び出しとして昇格した plain B は link write を持たないため除外する。
      if (!insn.isTailCall) {
        regs.delete('x30');
        const linkAddr = toLinkReturnAddress(insn.address);
        if (linkAddr != null) {
          const link = value('imm', { value: linkAddr },
            SCORE.confirmed,
            [ev('call-link', insn.row, { value: linkAddr })], insn.row);
          set('x30', link);
          flow('call-link', insn.row, null, 'x30', link);
        }
      }
      const retKind = api && api.ret ? api.ret : null;
      const ret = value('callResult', { call, ret: retKind },
        name ? SCORE.high : SCORE.inferred,
        [ev(name ? 'call-named' : 'call-unknown', insn.row, { name, api: api ? api.id : null })], insn.row);
      set('x0', ret);
      flow('call->reg', insn.row, name || 'call', 'x0', ret);
      for (let a = 0; a <= 7; a++) written.add('x' + a);
      markWritten(insn, written);
      continue;
    }

    /* ── その他の計算 ── */
    if (insn.writes.length) {
      const inputs = insn.reads.map((r) => ({ reg: r, value: get(r) })).filter((x) => x.value);
      const allImm = inputs.length && inputs.every((x) => x.value.kind === 'imm');
      for (const dst of insn.writes) {
        const v = allImm
          ? value('computed', { op: base, inputs }, SCORE.high, [ev('compute', insn.row, { op: base })], insn.row)
          : (inputs.length
            ? value('computed', { op: base, inputs }, SCORE.inferred, [ev('compute', insn.row, { op: base })], insn.row)
            : unknownValue(ev('untracked', insn.row)));
        set(dst, v);
        flow('compute', insn.row, inputs.length ? inputs[0].reg : null, dst, v);
      }
    }
    markWritten(insn, written);
  }

  return {
    flows, calls, byRow, addressRefs,
    argRegs: Array.from(argsRead).sort((a, b) => a - b),
    finalRegs: regs,
  };
}

function markWritten(insn, written) {
  for (const w of insn.writes) written.add(w);
}

/* ────────────────────────────────────────────────────────────
   Basic Block
   ──────────────────────────────────────────────────────────── */

/**
 * 制御フローの切れ目でぶつ切りにする。ここは「人間向けのまとまり」ではなく、
 * あくまで CPU から見た素直な区切り。Semantic Block と混同しないこと。
 */
export function buildBasicBlocks(insns, opts) {
  const o = opts || {};
  const byRow = new Map();
  for (const i of insns) byRow.set(i.row, i);
  const first = insns.length ? insns[0].row : 0;
  const last = insns.length ? insns[insns.length - 1].row : 0;
  const inRange = (row) => row >= first && row <= last;

  const leaders = new Set([first]);
  const joinRows = new Set();
  for (const insn of insns) {
    if (!insn.isBranch) continue;
    if (insn.branchTarget != null && o.rowOfAddress) {
      const trow = o.rowOfAddress(insn.branchTarget);
      if (trow != null && inRange(trow)) {
        leaders.add(trow);
        joinRows.add(trow);
      }
    }
    if (!insn.isCall && inRange(insn.row + 1)) leaders.add(insn.row + 1);
  }
  if (o.extraLeaders) for (const r of o.extraLeaders) if (inRange(r)) leaders.add(r);

  const sorted = Array.from(leaders).sort((a, b) => a - b);
  const blocks = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    const end = i + 1 < sorted.length ? sorted[i + 1] - 1 : last;
    if (end < start) continue;
    const rows = [];
    for (let r = start; r <= end; r++) if (byRow.has(r)) rows.push(r);
    if (!rows.length) continue;
    blocks.push({ index: blocks.length, startRow: start, endRow: end, rows,
      isJoin: joinRows.has(start), isLoopHeader: false });
  }

  const blockOfRow = (row) => {
    for (let i = 0; i < blocks.length; i++) if (row >= blocks[i].startRow && row <= blocks[i].endRow) return i;
    return -1;
  };
  const lastInsn = (b) => {
    for (let r = b.endRow; r >= b.startRow; r--) {
      const x = byRow.get(r);
      if (x && !x.data) return x;
    }
    return null;
  };
  const succ = blocks.map(() => []);
  for (let i = 0; i < blocks.length; i++) {
    const term = lastInsn(blocks[i]);
    const next = i + 1 < blocks.length ? i + 1 : -1;
    if (!term) { if (next >= 0) succ[i].push(next); continue; }
    if (term.isReturn || term.isTailCall) continue;
    if (term.isBranch && !term.isCall) {
      if (term.branchTarget != null && o.rowOfAddress) {
        const row = o.rowOfAddress(term.branchTarget);
        const to = row == null ? -1 : blockOfRow(row);
        if (to >= 0) succ[i].push(to);
      }
      if (term.isConditional && next >= 0) succ[i].push(next);
      continue;
    }
    if (next >= 0) succ[i].push(next);
  }

  const graph = analyzeGraph(succ, blocks.length ? 0 : -1);
  const backEdges = graph.backEdges.map((e) => {
    const term = lastInsn(blocks[e.from]);
    return { from: term ? term.row : blocks[e.from].endRow, to: blocks[e.to].startRow };
  });
  const headers = new Set(graph.backEdges.map((e) => e.to));
  blocks.forEach((b, i) => { b.isLoopHeader = headers.has(i); });
  const preds = blocks.map(() => []);
  for (let i = 0; i < succ.length; i++) {
    for (const j of succ[i]) if (j >= 0 && j < preds.length && !preds[j].includes(i)) preds[j].push(i);
  }
  return { blocks, joinRows, backEdges, preds };
}

/* ────────────────────────────────────────────────────────────
   Semantic Block
   ──────────────────────────────────────────────────────────── */

/** 「静か」な命令（nop や pac）は、前のまとまりに吸収させる。 */
function isQuiet(role) { return role === 'quiet'; }

const PROLOGUE_LIMIT = 12;   // 関数の頭から何行までを「開始」とみなすか

function looksPrologue(insn, base) {
  if (/^(paciasp|pacibsp|bti|nop)$/.test(base)) return true;
  if (insn.memory && insn.memory.kind === 'store' && insn.memory.stack) return true;
  if (base === 'sub' && insn.ops[0] && insn.ops[0].cls === 'sp') return true;
  if (base === 'mov' && insn.ops[0] && insn.ops[0].cls === 'gp' && insn.ops[0].num === 29 &&
      insn.ops[1] && insn.ops[1].cls === 'sp') return true;
  if (base === 'add' && insn.ops[0] && insn.ops[0].cls === 'gp' && insn.ops[0].num === 29 &&
      insn.ops[1] && insn.ops[1].cls === 'sp') return true;
  return false;
}

function looksEpilogue(insn, base) {
  if (/^(autiasp|autibsp)$/.test(base)) return true;
  if (insn.memory && insn.memory.kind === 'load' && insn.memory.stack) {
    // x29/x30を戻しているならほぼ確実に後片付け。それ以外のstack loadは
    // 戻り値や局所値の再読み出しでもあり得るため、cleanupと断定しない (#5445)。
    return insn.writes.some((w) => w === 'x29' || w === 'x30');
  }
  if (base === 'add' && insn.ops[0] && insn.ops[0].cls === 'sp' &&
      insn.ops[1] && insn.ops[1].cls === 'sp') return true;
  return false;
}

/**
 * Basic Block を材料に、人間が 1 つの「処理」として読めるまとまりを作る。
 */
export function buildSemanticBlocks(insns, bbInfo, flow, opts) {
  const o = opts || {};
  const byRow = new Map();
  for (const i of insns) byRow.set(i.row, i);
  const backTo = new Set(bbInfo.backEdges.map((b) => b.to));
  const callByRow = new Map();
  for (const c of flow.calls) callByRow.set(c.row, c);

  const out = [];
  for (const bb of bbInfo.blocks) {
    const list = bb.rows.map((r) => byRow.get(r)).filter(Boolean);
    if (!list.length) continue;
    const groups = groupInside(list, bb, { insns, flow, backTo, callByRow, opts: o });
    for (const g of groups) out.push(g);
  }

  // 位置と索引を確定させる
  out.sort((a, b) => a.startRow - b.startRow);
  out.forEach((b, i) => { b.index = i; });
  return out;
}

function groupInside(list, bb, ctx) {
  const groups = [];
  const funcStart = ctx.opts.startRow != null ? ctx.opts.startRow : list[0].row;

  let cur = null;
  const push = (insn, role) => {
    if (cur && cur.role === role) { cur.instructions.push(insn); cur.endRow = insn.row; return; }
    cur = {
      startRow: insn.row, endRow: insn.row, role,
      basicBlock: bb.index,
      instructions: [insn],
      inputs: [], outputs: [], effects: [],
      calls: [], refs: [], branch: null, loop: null,
      evidence: [], confidence: SCORE.confirmed,
      facts: {},
    };
    groups.push(cur);
  };

  for (const insn of list) {
    const base = insn.mnemonic.toLowerCase();
    let role = insn.role;

    // adrp と組でアドレスを完成させる add は、計算ではなく「場所を求める」処理
    const rowFlows = ctx.flow.byRow.get(insn.row) || [];
    if (rowFlows.some((f) => f.kind === 'addr-calc')) role = ROLE.ADDRESS_CALCULATION;

    if (insn.row - funcStart < PROLOGUE_LIMIT && looksPrologue(insn, base) && groups.length <= 1 &&
        (!cur || cur.role === ROLE.FUNCTION_ENTRY)) {
      role = ROLE.FUNCTION_ENTRY;
    } else if (isQuiet(role)) {
      role = cur ? cur.role : ROLE.REGISTER_SETUP;
    } else if (insn.isReturn) {
      role = ROLE.FUNCTION_EXIT;
    } else if (looksEpilogue(insn, base) && nearReturn(list, insn)) {
      role = ROLE.CLEANUP;
    }
    push(insn, role);
  }

  /* まとまりを人間向けに畳む */
  const folded = [];
  for (const g of groups) {
    const prev = folded[folded.length - 1];
    // 準備 → 呼び出し は 1 つの処理として読む（仕様の memcpy の例）。
    // 準備は何段にもなる（adrp+add で場所を作り、mov で値を並べ…）ので、
    // 手前へ向かって、引数を作っている限りまとめて取り込む。
    if (g.role === ROLE.FUNCTION_CALL) {
      const absorbed = [];
      let taken = 0;
      while (folded.length) {
        const p = folded[folded.length - 1];
        if (!PREP_ROLES.has(p.role)) break;
        if (p.instructions.length > 10 || taken + p.instructions.length > 12) break;
        if (!feedsCall(p, g)) break;
        taken += p.instructions.length;
        absorbed.unshift(folded.pop());
      }
      if (absorbed.length) {
        const head = [];
        for (const a of absorbed) head.push(...a.instructions);
        g.instructions = head.concat(g.instructions);
        g.startRow = absorbed[0].startRow;
      }
      folded.push(g);
      continue;
    }
    // 比較 → 条件分岐 も 1 つ
    if (g.role === ROLE.CONDITION_CHECK && prev && prev.role === ROLE.CONDITION_CHECK) {
      prev.instructions = prev.instructions.concat(g.instructions);
      prev.endRow = g.endRow;
      continue;
    }
    folded.push(g);
  }

  for (const g of folded) finishBlock(g, ctx);
  return folded;
}

/** 呼び出しの手前で「準備」とみなせる役割。 */
const PREP_ROLES = new Set([
  ROLE.ARGUMENT_PREPARATION, ROLE.REGISTER_SETUP, ROLE.ADDRESS_CALCULATION,
  ROLE.MEMORY_READ, ROLE.VALUE_CALCULATION,
]);

/** 直前のまとまりが、その呼び出しの引数を作っているか。 */
function feedsCall(prep, call) {
  const argRegs = new Set(['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8']);
  for (const insn of prep.instructions) {
    for (const w of insn.writes) if (argRegs.has(w)) return true;
  }
  // 引数を作っていなくても、直前 1 行だけならまとめて読んだほうが分かりやすい
  return prep.instructions.length <= 2 && prep.role !== ROLE.MEMORY_READ;
}

function nearReturn(list, insn) {
  const i = list.indexOf(insn);
  for (let k = i + 1; k < Math.min(list.length, i + 6); k++) {
    if (list[k].isReturn) return true;
  }
  return false;
}

/** まとまりに、入出力・効果・根拠・確からしさを詰める。 */
function finishBlock(g, ctx) {
  const { flow, backTo, callByRow } = ctx;
  const writes = new Set();
  const reads = new Set();
  let score = SCORE.confirmed;

  for (const insn of g.instructions) {
    for (const w of insn.writes) writes.add(w);
    for (const r of insn.reads) if (!writes.has(r)) reads.add(r);

    if (insn.isCall) {
      const call = callByRow.get(insn.row);
      if (call) {
        g.calls.push(call);
        g.effects.push('call');
        if (call.api) {
          g.evidence.push(ev('api', insn.row, { name: call.name, api: call.api.id, cat: call.api.cat }));
          score = Math.min(score, SCORE.high);
        } else if (call.name) {
          g.evidence.push(ev('call-named', insn.row, { name: call.name }));
          score = Math.min(score, SCORE.high);
        } else {
          g.evidence.push(ev(call.indirect ? 'call-indirect' : 'call-unknown', insn.row, { target: call.target }));
          score = Math.min(score, SCORE.inferred);
        }
        if (call.api && call.api.effect === 'abort') g.role = ROLE.ERROR_HANDLING;
      }
    }
    if (insn.memory) {
      // Project the instruction's own read/write truth. Only atomics carry both
      // halves; a plain load or store keeps its single effect (#8781).
      const mem = insn.memory;
      if (mem.read || mem.write) {
        if (mem.read) g.effects.push('read');
        if (mem.write) g.effects.push('write');
      } else {
        g.effects.push(mem.kind === 'load' ? 'read' : 'write');
      }
      if (insn.memory.stack) g.facts.stack = true;
    }
    if (insn.branchTarget != null) {
      g.branch = { row: insn.row, target: insn.branchTarget, conditional: insn.isConditional };
      g.effects.push('branch');
      g.evidence.push(ev('branch', insn.row, { target: insn.branchTarget, conditional: insn.isConditional }));
    }
    if (insn.isReturn) g.effects.push('return');
    if (insn.unknownMnemonic || insn.data) {
      g.evidence.push(ev('undecodable', insn.row, null));
      score = Math.min(score, SCORE.unknown);
    }

    // 行に紐づくデータフローから、参照しているアドレスを拾う
    const fl = flow.byRow.get(insn.row) || [];
    for (const f of fl) {
      if (f.value && f.value.kind === 'address' && !f.value.partial) {
        g.refs.push({ row: insn.row, addr: f.value.addr, value: f.value });
        g.evidence.push(ev('address', insn.row, { addr: f.value.addr }));
      }
      if (f.kind === 'imm->reg' && f.value && f.value.value != null) {
        g.facts.immediates = g.facts.immediates || [];
        g.facts.immediates.push({ row: insn.row, reg: f.to, value: f.value.value });
      }
    }
  }

  /* 役割の後付け調整 */
  if (g.branch && g.branch.target != null && ctx.opts.rowOfAddress) {
    const trow = ctx.opts.rowOfAddress(g.branch.target);
    if (trow != null && trow <= g.startRow) {
      g.role = ROLE.LOOP;
      g.evidence.push(ev('backedge', g.branch.row, { target: g.branch.target }));
    }
  }
  if (backTo.has(g.startRow) && g.role !== ROLE.LOOP) g.facts.loopHeader = true;

  // 呼び出しの戻り値をすぐ調べているなら「結果を確認」
  if (g.role === ROLE.CONDITION_CHECK) {
    const usesX0 = g.instructions.some((i) => i.reads.includes('x0'));
    const prevCall = lastCallBefore(flow.calls, g.startRow);
    if (usesX0 && prevCall && g.startRow - prevCall.row <= 4) {
      g.role = ROLE.RETURN_VALUE;
      g.facts.checkedCall = prevCall;
      g.evidence.push(ev('retval', g.startRow, { name: prevCall.name }));
    }
  }

  // 呼び出しブロックの主役 API
  const withApi = g.calls.find((c) => c.api);
  if (withApi) {
    g.facts.api = withApi.api;
    g.facts.apiCall = withApi;
    if (withApi.api.effect === 'abort') g.role = ROLE.ERROR_HANDLING;
  }

  g.inputs = Array.from(reads).map((r) => ({ reg: r, value: valueAt(flow, g.startRow, r) }));
  g.outputs = Array.from(writes).map((r) => ({ reg: r }));
  g.effects = Array.from(new Set(g.effects));
  g.confidence = score;
  g.level = levelOf(score);
  if (!g.evidence.length) {
    g.evidence.push(ev('instructions', g.startRow, { n: g.instructions.length }));
  }
}

function lastCallBefore(calls, row) {
  let best = null;
  for (const c of calls) if (c.row < row && (!best || c.row > best.row)) best = c;
  return best;
}

/** そのブロックに入る時点でレジスタが持っていた値（分かる範囲で）。 */
function valueAt(flow, row, reg) {
  let best = null;
  for (const f of flow.flows) {
    if (f.row >= row) break;
    if (f.to === reg && f.value) best = f.value;
  }
  return best;
}

/* ────────────────────────────────────────────────────────────
   まとめ: 関数 1 つぶんの Semantic Model
   ──────────────────────────────────────────────────────────── */

const indirectExternalTailTransferProofs = new WeakMap();
const EXTERNAL_SYMBOL_NAME = /^[A-Za-z_.$][A-Za-z0-9_.$@]{0,255}$/;

/**
 * Private proof issued only by the legacy dataflow builder after it traces an
 * indirect BR target to a loader-published external pointer symbol. Plain model
 * objects cannot mint this authority by copying fields onto an instruction.
 */
export function indirectExternalTailTransferProof(instruction) {
  return instruction && typeof instruction === 'object'
    ? (indirectExternalTailTransferProofs.get(instruction) || null)
    : null;
}

function markIndirectExternalTailTransfers(insns, bbInfo, flow, options) {
  const resolveExternalPointer = typeof options?.externalPointerSymbolFor === 'function'
    ? options.externalPointerSymbolFor : null;
  if (!resolveExternalPointer || !Array.isArray(insns) || !insns.length || !flow?.byRow) return false;
  let changed = false;
  const instructionByRow = new Map(insns.map((instruction) => [instruction.row, instruction]));
  for (const block of bbInfo?.blocks || []) {
    const blockInsns = block.rows.map((row) => instructionByRow.get(row)).filter(Boolean);
    const term = blockInsns.length ? blockInsns[blockInsns.length - 1] : null;
    if (!term || String(term.mnemonic || '').toLowerCase() !== 'br' || term.ops?.length !== 1) continue;
    const targetReg = regKey(term.ops[0]);
    if (!targetReg) continue;

    let reaching = null;
    for (let i = blockInsns.length - 2; i >= 0; i--) {
      const candidate = blockInsns[i];
      if (candidate.writes?.includes(targetReg)) {
        const events = flow.byRow.get(candidate.row) || [];
        reaching = [...events].reverse().find((event) => event?.to === targetReg)?.value || null;
        break;
      }
    }
    if (!reaching || reaching.kind !== 'loaded' || typeof reaching.addr !== 'bigint' || reaching.conf < SCORE.high) continue;
    let name = null;
    try { name = resolveExternalPointer(reaching.addr); } catch { name = null; }
    if (typeof name !== 'string' || !EXTERNAL_SYMBOL_NAME.test(name)) continue;

    const proof = Object.freeze({
      kind:'external-symbol-pointer-tail-transfer',
      targetName:name,
      pointerAddress:reaching.addr,
      targetRegister:targetReg,
      sourceRow:reaching.def,
      branchRow:term.row,
    });
    indirectExternalTailTransferProofs.set(term, proof);
    term.isCall = true;
    term.isTailCall = true;
    term.role = ROLE.FUNCTION_CALL;
    changed = true;
  }
  return changed;
}

const MAX_MODEL_INSTRUCTIONS = 6000;   // これ以上は意味解析をあきらめる（表示は続く）

/**
 * @param {Array} raw  [{row, address, mn, ops}] — 逆アセンブル済みの生データ
 * @param {object} opts
 *   startRow, endRow, symbolFor(addr), rowOfAddress(addr), name
 * @returns Semantic Model（言語に依存しない。narrate.js が日本語にする）
 */
export function buildSemanticModel(raw, opts) {
  const o = opts || {};
  const truncated = raw.length > MAX_MODEL_INSTRUCTIONS;
  const source = truncated ? raw.slice(0, MAX_MODEL_INSTRUCTIONS) : raw;

  const insns = [];
  const diagnostics = [];
  for (const r of source) {
    try {
      const inst = makeInstruction(r);
      insns.push(inst);
      if (inst.parseError) diagnostics.push({ severity:'warning', row:r.row, address:r.address ?? null, ...inst.parseError });
    } catch (error) {
      let row = -1, address = null, mnemonic = '', operands = '';
      try { row = r?.row ?? -1; } catch { /* hostile input getter */ }
      try { address = r?.address ?? null; } catch { /* hostile input getter */ }
      try { mnemonic = r?.mn || ''; } catch { /* hostile input getter */ }
      try { operands = r?.ops || ''; } catch { /* hostile input getter */ }
      const message = error?.message || String(error);
      diagnostics.push({ severity:'error', stage:'instruction', row, address, message, text:`${mnemonic} ${operands}`.trim() });
      insns.push({
        row, address, mnemonic, operands, ops:[], data:false,
        category:'unknown', reads:[], writes:[], role:'other', unknown:true,
        analysisError:{ stage:'instruction', message },
      });
    }
  }

  markTailCalls(insns, o, truncated);
  let bbInfo = buildBasicBlocks(insns, o);
  let flow = analyzeDataFlow(insns, Object.assign({ joinRows: bbInfo.joinRows, blocks: bbInfo.blocks, preds: bbInfo.preds }, o));
  if (markIndirectExternalTailTransfers(insns, bbInfo, flow, o)) {
    // Tail-transfer classification changes CFG termination and call dataflow.
    // Rebuild both from the now-proven instruction facts; do not patch either
    // graph after the fact.
    bbInfo = buildBasicBlocks(insns, o);
    flow = analyzeDataFlow(insns, Object.assign({ joinRows: bbInfo.joinRows, blocks: bbInfo.blocks, preds: bbInfo.preds }, o));
  }
  const semantic = buildSemanticBlocks(insns, bbInfo, flow, o);

  const model = {
    name: o.name || null,
    startRow: insns.length ? insns[0].row : (o.startRow || 0),
    endRow: insns.length ? insns[insns.length - 1].row : (o.endRow || 0),
    startAddress: insns.length ? insns[0].address : null,
    truncated,
    diagnostics,
    instructions: insns,
    basicBlocks: bbInfo.blocks,
    backEdges: bbInfo.backEdges,
    flows: flow.flows,
    flowByRow: flow.byRow,
    calls: flow.calls,
    argRegs: flow.argRegs,
    addressRefs: flow.addressRefs,
    semantic,
    facts: functionFacts(insns, flow, semantic, bbInfo, o),
  };
  model.blockOfRow = (row) => semantic.find((b) => row >= b.startRow && row <= b.endRow) || null;
  return model;
}

/**
 * 関数の外へ跳ぶ `b` を、呼び出しとして扱う（末尾呼び出し）。
 *
 *     -[ADJConfig setSdkPrefix:]:
 *         mov w3, #0x38
 *         b   _objc_setProperty_nonatomic_copy
 *
 * これで関数はおしまい。`bl` ではないので、呼び出しとして数えていなかったころは
 * 「この関数は何も呼んでいない」ことになり、要約も役割も空になっていた。
 * Objective-C の property は大半がこの形なので、影響はきわめて大きい。
 *
 * 行き先が自分の中（ループや if の合流）なら、もちろん呼び出しではない。
 */
function markTailCalls(insns, o, truncated = false) {
  if (!insns.length) return;
  const lo = insns[0].address;
  const hi = insns[insns.length - 1].address;
  if (lo == null || hi == null) return;
  const rowOfAddress = typeof o?.rowOfAddress === 'function' ? o.rowOfAddress : null;
  const startRow = insns[0].row;
  const endRow = Number.isInteger(o?.endRow) ? o.endRow : null;
  for (const insn of insns) {
    if (insn.isCall || insn.isConditional) continue;
    if (insn.mnemonic.toLowerCase() !== 'b' || insn.branchTarget == null) continue;
    if (insn.branchTarget >= lo && insn.branchTarget <= hi) continue;   // 自分の中へ跳んでいる
    if (truncated && insn.branchTarget > hi) {
      // 切り詰め境界の外は「観測範囲の外」であって関数の外ではない。同じ関数
      // の後半への正当な内部 `b` がここで外部tail callへ化けていた（#5450）。
      // 元の関数境界（o.endRow + rowOfAddress）で行き先が確定できるときだけ
      // 内部/外部を判定し、確定できないときはtail callを断定せずunknownの
      // まま残す。
      let targetRow = null;
      if (rowOfAddress) { try { targetRow = rowOfAddress(insn.branchTarget); } catch { /* hostile getter */ } }
      const provenInternal = Number.isInteger(targetRow) && Number.isInteger(endRow)
        && targetRow >= startRow && targetRow <= endRow;
      const provenExternal = Number.isInteger(targetRow) && Number.isInteger(endRow)
        && targetRow > endRow;
      if (!provenExternal) continue;
    }
    insn.isCall = true;
    insn.isTailCall = true;
    insn.callTarget = insn.branchTarget;
  }
}

/** 関数 1 つぶんの事実と、根拠つきの推測。 */
function functionFacts(insns, flow, semantic, bbInfo, o) {
  const facts = {
    instructionCount: insns.length,
    dataRows: insns.filter((i) => i.data).length,
    calls: flow.calls.length,
    namedCalls: flow.calls.filter((c) => c.name).length,
    indirectCalls: flow.calls.filter((c) => c.indirect).length,
    loops: bbInfo.backEdges.length,
    conditionals: insns.filter((i) => i.isConditional).length,
    returns: insns.filter((i) => i.isReturn).length,
    loads: insns.filter((i) => i.memory && i.memory.kind === 'load').length,
    stores: insns.filter((i) => i.memory && i.memory.kind === 'store').length,
    argRegs: flow.argRegs,
    setsReturnValue: false,
    apis: [],
    categories: [],
    features: [],
    stringRefs: [],
    evidence: [],
    leaf: flow.calls.length === 0,
  };
  // 戻り値: 最後の ret より前に x0 を作っているか
  const lastRet = [...insns].reverse().find((i) => i.isReturn);
  if (lastRet) {
    for (const i of insns) {
      if (i.row < lastRet.row && i.writes.includes('x0')) { facts.setsReturnValue = true; break; }
    }
  } else {
    facts.setsReturnValue = insns.some((i) => i.writes.includes('x0'));
  }

  const seenApi = new Set();
  const seenName = new Set();
  facts.calledNames = [];
  for (const c of flow.calls) {
    if (c.name && !seenName.has(c.name)) {
      seenName.add(c.name);
      facts.calledNames.push({ name: c.name, row: c.row, target: c.target });
    }
    if (!c.api || seenApi.has(c.api.id)) continue;
    seenApi.add(c.api.id);
    facts.apis.push({ id: c.api.id, cat: c.api.cat, name: c.name, row: c.row });
    facts.evidence.push(ev('api', c.row, { name: c.name, api: c.api.id, cat: c.api.cat }));
  }
  // 意味の分からない名前でも「その名前を呼んでいる」ことは事実。根拠として残す。
  for (const n of facts.calledNames.slice(0, 4)) {
    if (seenApi.size && facts.apis.some((a) => a.name === n.name)) continue;
    facts.evidence.push(ev('call-named', n.row, { name: n.name }));
  }
  if (facts.calls > facts.namedCalls) {
    facts.evidence.push(ev('call-unknown', -1, { n: facts.calls - facts.namedCalls }));
  }
  facts.categories = Array.from(new Set(facts.apis.map((a) => a.cat)));
  facts.features = Array.from(new Set(facts.categories
    .map((c) => FEATURE_OF_CATEGORY[c]).filter(Boolean)));

  for (const r of flow.addressRefs) {
    facts.stringRefs.push({ row: r.row, addr: r.addr, value: r.value });
  }
  if (facts.loops) facts.evidence.push(ev('backedge', bbInfo.backEdges[0].from, { n: facts.loops }));
  if (facts.indirectCalls) facts.evidence.push(ev('call-indirect', -1, { n: facts.indirectCalls }));
  if (!flow.calls.length) facts.evidence.push(ev('leaf', -1, null));

  // 確からしさ: 名前が取れているほど、外部 API が分かっているほど高い
  let score = SCORE.inferred;
  if (facts.apis.length >= 2) score = SCORE.high;
  else if (facts.apis.length === 1) score = 0.7;
  else if (facts.namedCalls) score = 0.5;
  if (!facts.namedCalls && !facts.apis.length) score = SCORE.unknown;
  if (o.name) score = Math.min(1, score + 0.1);
  facts.confidence = Math.min(1, score);
  facts.level = levelOf(facts.confidence);

  // 主役の役割（この関数の見出しに使う）
  facts.mainRole = pickMainRole(semantic, facts);
  return facts;
}

function pickMainRole(semantic, facts) {
  if (facts.apis.length) {
    // いちばん「アプリらしい」分類を優先する
    const order = ['network', 'secret', 'crypto', 'storage', 'io', 'database', 'ui',
      'antidebug', 'string', 'memory', 'objc', 'concurrency', 'log', 'error'];
    for (const cat of order) {
      const hit = facts.apis.find((a) => a.cat === cat);
      if (hit) return { kind: 'api', cat, api: hit.id };
    }
  }
  if (facts.loops) return { kind: 'loop' };
  if (facts.conditionals) return { kind: 'branchy' };
  if (facts.namedCalls) return { kind: 'calls', n: facts.namedCalls };
  if (facts.leaf && facts.instructionCount <= 8) return { kind: 'tiny' };
  void semantic;
  return { kind: 'plain' };
}

/**
 * アドレス参照の中身（文字列）を後から流し込む。
 * 読み取りは worker 側で行うので、ここは受け取るだけ。
 *
 * @param {object} model
 * @param {Map<string,string>} texts  addr.toString() -> 文字列
 */
export function attachTexts(model, texts, indirect) {
  if (!model || !texts) return model;
  const via = indirect || new Set();
  for (const r of model.addressRefs) {
    const key = r.addr.toString();
    const text = texts.get(key);
    if (!text) continue;
    r.text = text;
    r.viaPointer = via.has(key);
    if (r.value) {
      r.value.kind = 'string';
      r.value.text = text;
      r.value.viaPointer = via.has(key);
      r.value.conf = SCORE.confirmed;
      r.value.ev = r.value.ev.concat([ev('string', r.row, { addr: r.addr, text })]);
    }
  }
  for (const b of model.semantic) {
    for (const ref of b.refs) {
      const text = texts.get(ref.addr.toString());
      if (text) {
        ref.text = text;
        b.evidence.push(ev('string', ref.row, { addr: ref.addr, text }));
      }
    }
  }
  for (const s of model.facts.stringRefs) {
    const text = texts.get(s.addr.toString());
    if (text) s.text = text;
  }
  model.facts.strings = model.facts.stringRefs.filter((s) => s.text).map((s) => s.text);

  // objc_msgSend の第 2 引数＝呼ぼうとしているメソッドの名前。
  // ここが埋まると「何というメソッドを呼んでいるか」まで言えるようになる。
  for (const c of model.calls) {
    if (!c.api || c.api.id !== 'objc_msgSend') continue;
    const sel = c.args.find((a) => a.index === 1);
    if (sel && sel.value && sel.value.text) c.selector = sel.value.text;
  }
  for (const b of model.semantic) {
    const c = b.facts.apiCall;
    if (c && c.selector) b.facts.selector = c.selector;
  }
  return model;
}
