/**
 * Tier-0 Core TIL-lite dictionary & unified TilTypeId / HexTypeId model.
 * Spec: hex_ida_beyond_ida_design.md §1.1, §1.2, §3.1, §3.2
 * INV-005: ZERO imports from js/targets/architecture/.
 */

// ---------------------------------------------------------------------------
// §1.1 16-bit TilTypeId fixed namespaces
// ---------------------------------------------------------------------------
export const TIL_TYPE_UNKNOWN = 0x0000;
export const TIL_TYPE_INVALID = 0xFFFF;

export const TIL_NS = Object.freeze({
  PRIM_MIN: 0x0001,
  PRIM_MAX: 0x0012,
  CORE_MIN: 0x0040,
  CORE_MAX: 0x0FFF,
  PACK_MIN: 0x1000,
  PACK_MAX: 0x5FFF,
  LOCAL_MIN: 0x6000,
  LOCAL_MAX: 0x7FFF,
  RECOVERED_MIN: 0x8000,
  RECOVERED_MAX: 0xFFFE,
});

export const TIL_PRIM = Object.freeze({
  UNKNOWN: 0x0000,
  VOID: 0x0001,
  BOOL: 0x0002,
  I8: 0x0003,
  U8: 0x0004,
  I16: 0x0005,
  U16: 0x0006,
  I32: 0x0007,
  U32: 0x0008,
  I64: 0x0009,
  U64: 0x000A,
  I128: 0x000B,
  U128: 0x000C,
  F16: 0x000D,
  F32: 0x000E,
  F64: 0x000F,
  V128: 0x0010,
  OBJC_ID: 0x0011,
  OBJC_SEL: 0x0012,
});

export const TIL_PRIM_NAMES = Object.freeze({
  [TIL_PRIM.UNKNOWN]: 'unknown',
  [TIL_PRIM.VOID]: 'void',
  [TIL_PRIM.BOOL]: 'bool',
  [TIL_PRIM.I8]: 'int8_t',
  [TIL_PRIM.U8]: 'uint8_t',
  [TIL_PRIM.I16]: 'int16_t',
  [TIL_PRIM.U16]: 'uint16_t',
  [TIL_PRIM.I32]: 'int32_t',
  [TIL_PRIM.U32]: 'uint32_t',
  [TIL_PRIM.I64]: 'int64_t',
  [TIL_PRIM.U64]: 'uint64_t',
  [TIL_PRIM.I128]: '__int128',
  [TIL_PRIM.U128]: 'unsigned __int128',
  [TIL_PRIM.F16]: '_Float16',
  [TIL_PRIM.F32]: 'float',
  [TIL_PRIM.F64]: 'double',
  [TIL_PRIM.V128]: 'v128_t',
  [TIL_PRIM.OBJC_ID]: 'id',
  [TIL_PRIM.OBJC_SEL]: 'SEL',
});

export const TIL_PRIM_BITS = Object.freeze({
  [TIL_PRIM.VOID]: 0,
  [TIL_PRIM.BOOL]: 8,
  [TIL_PRIM.I8]: 8,
  [TIL_PRIM.U8]: 8,
  [TIL_PRIM.I16]: 16,
  [TIL_PRIM.U16]: 16,
  [TIL_PRIM.I32]: 32,
  [TIL_PRIM.U32]: 32,
  [TIL_PRIM.I64]: 64,
  [TIL_PRIM.U64]: 64,
  [TIL_PRIM.I128]: 128,
  [TIL_PRIM.U128]: 128,
  [TIL_PRIM.F16]: 16,
  [TIL_PRIM.F32]: 32,
  [TIL_PRIM.F64]: 64,
  [TIL_PRIM.V128]: 128,
  [TIL_PRIM.OBJC_ID]: 64,
  [TIL_PRIM.OBJC_SEL]: 64,
});

// ---------------------------------------------------------------------------
// §1.2 32-bit HexTypeId bit layout
// ---------------------------------------------------------------------------
export const HEX_KIND = Object.freeze({
  SCALAR: 0,
  STRUCT: 1,
  ARRAY: 2,
  FUNC_PTR: 3,
  BITFIELD: 4,
  UNION: 5,
  OBJC_OR_SWIFT_OBJ: 6,
  INVALID: 7,
});

export const HEX_SCALAR_AUX = Object.freeze({
  NORMAL: 0,
  ENUM: 1,
  BITMASK: 2,
  INVALID: 0xFF,
});

export const HEX_TYPE_INVALID = 0xFFFFFFFF;

export function makeHexTypeId({
  baseTilId = TIL_TYPE_UNKNOWN,
  ptrDepth = 0,
  isConst = false,
  isPacSigned = false,
  kindTag = HEX_KIND.SCALAR,
  auxMeta = 0,
} = {}) {
  const base = baseTilId & 0xFFFF;
  const depth = Math.min(7, Math.max(0, ptrDepth | 0));
  const c = isConst ? 1 : 0;
  const pac = isPacSigned && depth >= 1 ? 1 : 0;
  const kind = kindTag & 0x07;
  const aux = auxMeta & 0xFF;
  return (
    ((aux << 24) |
      (kind << 21) |
      (pac << 20) |
      (c << 19) |
      (depth << 16) |
      base) >>>
    0
  );
}

export function unpackHexTypeId(hexTypeId) {
  const v = hexTypeId >>> 0;
  return {
    baseTilId: v & 0xFFFF,
    ptrDepth: (v >>> 16) & 0x07,
    isConst: ((v >>> 19) & 1) === 1,
    isPacSigned: ((v >>> 20) & 1) === 1,
    kindTag: (v >>> 21) & 0x07,
    auxMeta: (v >>> 24) & 0xFF,
  };
}

export function hexTypeIsNone(hexTypeId) {
  const v = hexTypeId >>> 0;
  return v === 0xFFFFFFFF || (v & 0xFFFF) === 0xFFFF || ((v >>> 21) & 7) === 7;
}

export function hexTypeBaseTil(hexTypeId) {
  return (hexTypeId >>> 0) & 0xFFFF;
}

export function hexPtr(baseTilId, { isConst = false, depth = 1, kindTag = HEX_KIND.SCALAR, auxMeta = 0 } = {}) {
  return makeHexTypeId({ baseTilId, ptrDepth: depth, isConst, kindTag, auxMeta });
}

// ---------------------------------------------------------------------------
// §3.1 SigBlob flags, format families & call conventions
// ---------------------------------------------------------------------------
export const SIG_FLAG = Object.freeze({
  VARIADIC: 1 << 0,
  NORETURN: 1 << 1,
  FMT_SHIFT: 2,
  FMT_MASK: 0x07 << 2,
  ALLOC: 1 << 5,
  FREE: 1 << 6,
  OBJC_CLASS_METHOD: 1 << 7,
});

export const FMT_FAMILY = Object.freeze({
  NONE: 0,
  PRINTF: 1,
  SCANF: 2,
  NSLOG: 3,
  OS_LOG_FIXED: 4,
});

export const CALL_CONV = Object.freeze({
  AAPCS64: 0,
  SWIFTCALL: 1,
  SWIFTTAILCC: 2,
  SYSV_X64_WIN64: 3,
});

export const TYPE_QUAL = Object.freeze({
  CONST: 1 << 0,
  SIGNED: 1 << 1,
  ENUM: 1 << 2,
  BITMASK: 1 << 3,
});

// ---------------------------------------------------------------------------
// Core TIL Type IDs (0x0040..0x0FFF — fixed build-time IDs, no remapping)
// ---------------------------------------------------------------------------
export const CORE_TID = Object.freeze({
  // Standard C / POSIX typedefs & opaque structs
  FILE: 0x0040,
  SIZE_T: 0x0041,
  SSIZE_T: 0x0042,
  PTRDIFF_T: 0x0043,
  INTPTR_T: 0x0044,
  UINTPTR_T: 0x0045,
  OFF_T: 0x0046,
  PID_T: 0x0047,
  UID_T: 0x0048,
  GID_T: 0x0049,
  MODE_T: 0x004A,
  TIME_T: 0x004B,
  CLOCKID_T: 0x004C,
  SOCKLEN_T: 0x004D,
  VA_LIST: 0x004E,
  JMP_BUF: 0x004F,
  DIR: 0x0050,
  DIRENT: 0x0051,
  STAT: 0x0052,
  TIMESPEC: 0x0053,
  TIMEVAL: 0x0054,
  TM: 0x0055,
  SOCKADDR: 0x0056,
  SOCKADDR_IN: 0x0057,
  SOCKADDR_IN6: 0x0058,
  ADDRINFO: 0x0059,
  IOVEC: 0x005A,
  PTHREAD_T: 0x005B,
  PTHREAD_ATTR_T: 0x005C,
  PTHREAD_MUTEX_T: 0x005D,
  PTHREAD_MUTEXATTR_T: 0x005E,
  PTHREAD_COND_T: 0x005F,
  PTHREAD_CONDATTR_T: 0x0060,
  SIGACTION: 0x0061,
  RLIMIT: 0x0062,
  DIV_T: 0x0063,
  LDIV_T: 0x0064,
  LLDIV_T: 0x0065,

  // Darwin / Apple / ObjC / CoreFoundation / CoreGraphics
  OBJC_CLASS: 0x0070,
  OBJC_OBJECT: 0x0071,
  OBJC_SUPER: 0x0072,
  OBJC_METHOD: 0x0073,
  OBJC_IVAR: 0x0074,
  OBJC_PROTOCOL: 0x0075,
  OBJC_PROPERTY: 0x0076,
  DISPATCH_OBJECT_T: 0x0077,
  DISPATCH_QUEUE_T: 0x0078,
  DISPATCH_GROUP_T: 0x0079,
  DISPATCH_SEMAPHORE_T: 0x007A,
  DISPATCH_TIME_T: 0x007B,
  OS_LOG_T: 0x007C,
  CFSTRING_REF: 0x007D,
  CFARRAY_REF: 0x007E,
  CFDICTIONARY_REF: 0x007F,
  CFDATA_REF: 0x0080,
  CFALLOCATOR_REF: 0x0081,
  CGPOINT: 0x0082,
  CGSIZE: 0x0083,
  CGRECT: 0x0084,
  NSRANGE: 0x0085,
  NSINTEGER: 0x0086,
  NSUINTEGER: 0x0087,
  CGFLOAT: 0x0088,
  MACH_PORT_T: 0x0089,
  KERN_RETURN_T: 0x008A,
  VM_ADDRESS_T: 0x008B,
  VM_SIZE_T: 0x008C,
  OSSTATUS: 0x008D,
  CFNUMBER_REF: 0x008E,
  CFURL_REF: 0x008F,
  CFBUNDLE_REF: 0x0090,
  CFRUNLOOP_REF: 0x0091,
  CFUUID_REF: 0x0092,
  CGCONTEXT_REF: 0x0093,
  CGIMAGE_REF: 0x0094,
  CGCOLORSPACE_REF: 0x0095,
  MACH_TIMEBASE_INFO_T: 0x0096,
  SWIFT_METADATA: 0x0097,
  SWIFT_HEAP_OBJECT: 0x0098,

  // Unity IL2CPP runtime types
  IL2CPP_OBJECT: 0x00A0,
  IL2CPP_CLASS: 0x00A1,
  IL2CPP_STRING: 0x00A2,
  IL2CPP_ARRAY: 0x00A3,
  IL2CPP_DOMAIN: 0x00A4,
  IL2CPP_ASSEMBLY: 0x00A5,
  IL2CPP_IMAGE: 0x00A6,
  IL2CPP_TYPE: 0x00A7,
  IL2CPP_METHOD_INFO: 0x00A8,
  IL2CPP_FIELD_INFO: 0x00A9,
  IL2CPP_PROPERTY_INFO: 0x00AA,
  IL2CPP_EXCEPTION: 0x00AB,
  IL2CPP_THREAD: 0x00AC,

  // C++ ABI / STL core types
  STD_STRING: 0x00B0,
  STD_VECTOR: 0x00B1,
  STD_TYPE_INFO: 0x00B2,

  // Core Enums
  ENUM_SEEK_WHENCE: 0x00C0,
  ENUM_OPEN_FLAGS: 0x00C1,
  ENUM_MMAP_PROT: 0x00C2,
  ENUM_MMAP_FLAGS: 0x00C3,
  ENUM_SOCKET_DOMAIN: 0x00C4,
  ENUM_SOCKET_TYPE: 0x00C5,
  ENUM_OS_LOG_TYPE: 0x00C6,
  ENUM_DLOPEN_FLAGS: 0x00C7,
});

// Shorthand HexTypeId constants for readable curated signatures
const T_VOID = makeHexTypeId({ baseTilId: TIL_PRIM.VOID });
const T_BOOL = makeHexTypeId({ baseTilId: TIL_PRIM.BOOL });
const T_I8 = makeHexTypeId({ baseTilId: TIL_PRIM.I8 });
const T_U8 = makeHexTypeId({ baseTilId: TIL_PRIM.U8 });
const T_I16 = makeHexTypeId({ baseTilId: TIL_PRIM.I16 });
const T_U16 = makeHexTypeId({ baseTilId: TIL_PRIM.U16 });
const T_I32 = makeHexTypeId({ baseTilId: TIL_PRIM.I32 });
const T_U32 = makeHexTypeId({ baseTilId: TIL_PRIM.U32 });
const T_I64 = makeHexTypeId({ baseTilId: TIL_PRIM.I64 });
const T_U64 = makeHexTypeId({ baseTilId: TIL_PRIM.U64 });
const T_F32 = makeHexTypeId({ baseTilId: TIL_PRIM.F32 });
const T_F64 = makeHexTypeId({ baseTilId: TIL_PRIM.F64 });
const T_ID = makeHexTypeId({ baseTilId: TIL_PRIM.OBJC_ID, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_SEL = makeHexTypeId({ baseTilId: TIL_PRIM.OBJC_SEL });

const T_VPTR = hexPtr(TIL_PRIM.VOID);
const T_CVPTR = hexPtr(TIL_PRIM.VOID, { isConst: true });
const T_VPPTR = hexPtr(TIL_PRIM.VOID, { depth: 2 });
const T_CSTR = hexPtr(TIL_PRIM.I8, { isConst: true });
const T_STR = hexPtr(TIL_PRIM.I8);
const T_STRPTR = hexPtr(TIL_PRIM.I8, { depth: 2 });
const T_U8PTR = hexPtr(TIL_PRIM.U8);
const T_CU8PTR = hexPtr(TIL_PRIM.U8, { isConst: true });
const T_U16PTR = hexPtr(TIL_PRIM.U16);
const T_CU16PTR = hexPtr(TIL_PRIM.U16, { isConst: true });
const T_I32PTR = hexPtr(TIL_PRIM.I32);
const T_U32PTR = hexPtr(TIL_PRIM.U32);
const T_I64PTR = hexPtr(TIL_PRIM.I64);
const T_U64PTR = hexPtr(TIL_PRIM.U64);
const T_F64PTR = hexPtr(TIL_PRIM.F64);
const T_F32PTR = hexPtr(TIL_PRIM.F32);
const T_IDPTR = hexPtr(TIL_PRIM.OBJC_ID, { kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });

const T_SIZE = makeHexTypeId({ baseTilId: CORE_TID.SIZE_T });
const T_SSIZE = makeHexTypeId({ baseTilId: CORE_TID.SSIZE_T });
const T_OFF = makeHexTypeId({ baseTilId: CORE_TID.OFF_T });
const T_PID = makeHexTypeId({ baseTilId: CORE_TID.PID_T });
const T_MODE = makeHexTypeId({ baseTilId: CORE_TID.MODE_T });
const T_TIME = makeHexTypeId({ baseTilId: CORE_TID.TIME_T });
const T_SOCKLEN = makeHexTypeId({ baseTilId: CORE_TID.SOCKLEN_T });
const T_SOCKLEN_PTR = hexPtr(CORE_TID.SOCKLEN_T);
const T_FILE_PTR = hexPtr(CORE_TID.FILE, { kindTag: HEX_KIND.STRUCT });
const T_STAT_PTR = hexPtr(CORE_TID.STAT, { kindTag: HEX_KIND.STRUCT });
const T_TIMESPEC_PTR = hexPtr(CORE_TID.TIMESPEC, { kindTag: HEX_KIND.STRUCT });
const T_CTIMESPEC_PTR = hexPtr(CORE_TID.TIMESPEC, { isConst: true, kindTag: HEX_KIND.STRUCT });
const T_TIMEVAL_PTR = hexPtr(CORE_TID.TIMEVAL, { kindTag: HEX_KIND.STRUCT });
const T_TM_PTR = hexPtr(CORE_TID.TM, { kindTag: HEX_KIND.STRUCT });
const T_CTM_PTR = hexPtr(CORE_TID.TM, { isConst: true, kindTag: HEX_KIND.STRUCT });
const T_SOCKADDR_PTR = hexPtr(CORE_TID.SOCKADDR, { kindTag: HEX_KIND.STRUCT });
const T_CSOCKADDR_PTR = hexPtr(CORE_TID.SOCKADDR, { isConst: true, kindTag: HEX_KIND.STRUCT });
const T_ADDRINFO_PTR = hexPtr(CORE_TID.ADDRINFO, { kindTag: HEX_KIND.STRUCT });
const T_ADDRINFO_PPTR = hexPtr(CORE_TID.ADDRINFO, { depth: 2, kindTag: HEX_KIND.STRUCT });
const T_PTHREAD = makeHexTypeId({ baseTilId: CORE_TID.PTHREAD_T });
const T_PTHREAD_PTR = hexPtr(CORE_TID.PTHREAD_T);
const T_PTHREAD_ATTR_CPTR = hexPtr(CORE_TID.PTHREAD_ATTR_T, { isConst: true, kindTag: HEX_KIND.STRUCT });
const T_MUTEX_PTR = hexPtr(CORE_TID.PTHREAD_MUTEX_T, { kindTag: HEX_KIND.STRUCT });
const T_MUTEXATTR_CPTR = hexPtr(CORE_TID.PTHREAD_MUTEXATTR_T, { isConst: true, kindTag: HEX_KIND.STRUCT });
const T_COND_PTR = hexPtr(CORE_TID.PTHREAD_COND_T, { kindTag: HEX_KIND.STRUCT });
const T_CONDATTR_CPTR = hexPtr(CORE_TID.PTHREAD_CONDATTR_T, { isConst: true, kindTag: HEX_KIND.STRUCT });
const T_DIR_PTR = hexPtr(CORE_TID.DIR, { kindTag: HEX_KIND.STRUCT });
const T_DIRENT_PTR = hexPtr(CORE_TID.DIRENT, { kindTag: HEX_KIND.STRUCT });
const T_VA_LIST = makeHexTypeId({ baseTilId: CORE_TID.VA_LIST });
const T_JMP_BUF = makeHexTypeId({ baseTilId: CORE_TID.JMP_BUF });
const T_FN_PTR = makeHexTypeId({ baseTilId: TIL_PRIM.VOID, ptrDepth: 1, kindTag: HEX_KIND.FUNC_PTR });

const T_CLASS = hexPtr(CORE_TID.OBJC_CLASS, { kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_METHOD = hexPtr(CORE_TID.OBJC_METHOD, { kindTag: HEX_KIND.STRUCT });
const T_IVAR = hexPtr(CORE_TID.OBJC_IVAR, { kindTag: HEX_KIND.STRUCT });
const T_OBJC_SUPER_PTR = hexPtr(CORE_TID.OBJC_SUPER, { kindTag: HEX_KIND.STRUCT });
const T_DISPATCH_QUEUE = makeHexTypeId({ baseTilId: CORE_TID.DISPATCH_QUEUE_T, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_DISPATCH_GROUP = makeHexTypeId({ baseTilId: CORE_TID.DISPATCH_GROUP_T, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_DISPATCH_SEMA = makeHexTypeId({ baseTilId: CORE_TID.DISPATCH_SEMAPHORE_T, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_DISPATCH_TIME = makeHexTypeId({ baseTilId: CORE_TID.DISPATCH_TIME_T });
const T_OS_LOG = makeHexTypeId({ baseTilId: CORE_TID.OS_LOG_T, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_CFSTRING = makeHexTypeId({ baseTilId: CORE_TID.CFSTRING_REF, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_CFALLOC = makeHexTypeId({ baseTilId: CORE_TID.CFALLOCATOR_REF, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_NSINT = makeHexTypeId({ baseTilId: CORE_TID.NSINTEGER });
const T_NSUINT = makeHexTypeId({ baseTilId: CORE_TID.NSUINTEGER });
const T_MACH_PORT = makeHexTypeId({ baseTilId: CORE_TID.MACH_PORT_T });
const T_KERN_RET = makeHexTypeId({ baseTilId: CORE_TID.KERN_RETURN_T });
const T_OSSTATUS = makeHexTypeId({ baseTilId: CORE_TID.OSSTATUS });
const T_UINTPTR = makeHexTypeId({ baseTilId: CORE_TID.UINTPTR_T });
const T_SIZE_PTR = hexPtr(CORE_TID.SIZE_T);
const T_PROTOCOL = hexPtr(CORE_TID.OBJC_PROTOCOL, { kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_CFARRAY = makeHexTypeId({ baseTilId: CORE_TID.CFARRAY_REF, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_CFDICT = makeHexTypeId({ baseTilId: CORE_TID.CFDICTIONARY_REF, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_CFDATA = makeHexTypeId({ baseTilId: CORE_TID.CFDATA_REF, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_CFNUMBER = makeHexTypeId({ baseTilId: CORE_TID.CFNUMBER_REF, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_CFURL = makeHexTypeId({ baseTilId: CORE_TID.CFURL_REF, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_CFBUNDLE = makeHexTypeId({ baseTilId: CORE_TID.CFBUNDLE_REF, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_CFRUNLOOP = makeHexTypeId({ baseTilId: CORE_TID.CFRUNLOOP_REF, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_CFUUID = makeHexTypeId({ baseTilId: CORE_TID.CFUUID_REF, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_CGCONTEXT = makeHexTypeId({ baseTilId: CORE_TID.CGCONTEXT_REF, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_CGIMAGE = makeHexTypeId({ baseTilId: CORE_TID.CGIMAGE_REF, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_CGCOLORSPACE = makeHexTypeId({ baseTilId: CORE_TID.CGCOLORSPACE_REF, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
const T_CGSIZE = makeHexTypeId({ baseTilId: CORE_TID.CGSIZE, kindTag: HEX_KIND.STRUCT });
const T_CGRECT = makeHexTypeId({ baseTilId: CORE_TID.CGRECT, kindTag: HEX_KIND.STRUCT });
const T_CGFLOAT = makeHexTypeId({ baseTilId: CORE_TID.CGFLOAT });
const T_MACH_TIMEBASE_PTR = hexPtr(CORE_TID.MACH_TIMEBASE_INFO_T, { kindTag: HEX_KIND.STRUCT });
const T_SWIFT_META_CPTR = hexPtr(CORE_TID.SWIFT_METADATA, { isConst: true, kindTag: HEX_KIND.STRUCT });
const T_SWIFT_OBJ = hexPtr(CORE_TID.SWIFT_HEAP_OBJECT, { kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });

const T_IL2_OBJ = hexPtr(CORE_TID.IL2CPP_OBJECT, { kindTag: HEX_KIND.STRUCT });
const T_IL2_CLASS = hexPtr(CORE_TID.IL2CPP_CLASS, { kindTag: HEX_KIND.STRUCT });
const T_IL2_STR = hexPtr(CORE_TID.IL2CPP_STRING, { kindTag: HEX_KIND.STRUCT });
const T_IL2_ARR = hexPtr(CORE_TID.IL2CPP_ARRAY, { kindTag: HEX_KIND.STRUCT });
const T_IL2_DOM = hexPtr(CORE_TID.IL2CPP_DOMAIN, { kindTag: HEX_KIND.STRUCT });
const T_IL2_ASM = hexPtr(CORE_TID.IL2CPP_ASSEMBLY, { kindTag: HEX_KIND.STRUCT });
const T_IL2_ASM_PPTR = hexPtr(CORE_TID.IL2CPP_ASSEMBLY, { depth: 2, kindTag: HEX_KIND.STRUCT });
const T_IL2_IMG = hexPtr(CORE_TID.IL2CPP_IMAGE, { kindTag: HEX_KIND.STRUCT });
const T_IL2_TYPE = hexPtr(CORE_TID.IL2CPP_TYPE, { kindTag: HEX_KIND.STRUCT });
const T_IL2_METHOD = hexPtr(CORE_TID.IL2CPP_METHOD_INFO, { kindTag: HEX_KIND.STRUCT });
const T_IL2_FIELD = hexPtr(CORE_TID.IL2CPP_FIELD_INFO, { kindTag: HEX_KIND.STRUCT });
const T_IL2_PROP = hexPtr(CORE_TID.IL2CPP_PROPERTY_INFO, { kindTag: HEX_KIND.STRUCT });
const T_IL2_EXC = hexPtr(CORE_TID.IL2CPP_EXCEPTION, { kindTag: HEX_KIND.STRUCT });
const T_IL2_EXC_PPTR = hexPtr(CORE_TID.IL2CPP_EXCEPTION, { depth: 2, kindTag: HEX_KIND.STRUCT });
const T_IL2_THREAD = hexPtr(CORE_TID.IL2CPP_THREAD, { kindTag: HEX_KIND.STRUCT });

const T_TYPEINFO_CPTR = hexPtr(CORE_TID.STD_TYPE_INFO, { isConst: true, kindTag: HEX_KIND.STRUCT });
const T_ENUM_SEEK = makeHexTypeId({ baseTilId: CORE_TID.ENUM_SEEK_WHENCE, auxMeta: HEX_SCALAR_AUX.ENUM });
const T_ENUM_OPEN = makeHexTypeId({ baseTilId: CORE_TID.ENUM_OPEN_FLAGS, auxMeta: HEX_SCALAR_AUX.BITMASK });
const T_ENUM_PROT = makeHexTypeId({ baseTilId: CORE_TID.ENUM_MMAP_PROT, auxMeta: HEX_SCALAR_AUX.BITMASK });
const T_ENUM_MMAP = makeHexTypeId({ baseTilId: CORE_TID.ENUM_MMAP_FLAGS, auxMeta: HEX_SCALAR_AUX.BITMASK });
const T_ENUM_AF = makeHexTypeId({ baseTilId: CORE_TID.ENUM_SOCKET_DOMAIN, auxMeta: HEX_SCALAR_AUX.ENUM });
const T_ENUM_SOCK = makeHexTypeId({ baseTilId: CORE_TID.ENUM_SOCKET_TYPE, auxMeta: HEX_SCALAR_AUX.ENUM });
const T_ENUM_OSLOG = makeHexTypeId({ baseTilId: CORE_TID.ENUM_OS_LOG_TYPE, auxMeta: HEX_SCALAR_AUX.ENUM });
const T_ENUM_DLOPEN = makeHexTypeId({ baseTilId: CORE_TID.ENUM_DLOPEN_FLAGS, auxMeta: HEX_SCALAR_AUX.BITMASK });

// Helper to build a function signature entry concisely
function fn(name, ret, params = [], opts = {}) {
  let flags = opts.flags || 0;
  if (opts.variadic) flags |= SIG_FLAG.VARIADIC;
  if (opts.noreturn) flags |= SIG_FLAG.NORETURN;
  if (opts.alloc) flags |= SIG_FLAG.ALLOC;
  if (opts.free) flags |= SIG_FLAG.FREE;
  if (opts.objcClassMethod) flags |= SIG_FLAG.OBJC_CLASS_METHOD;
  const fmtFamily = opts.fmtFamily || FMT_FAMILY.NONE;
  flags |= (fmtFamily & 0x07) << SIG_FLAG.FMT_SHIFT;
  return {
    name,
    retHexType: ret >>> 0,
    paramHexTypes: params.map((p) => p >>> 0),
    flags: flags & 0xFF,
    fmtArgIdx: opts.fmtArgIdx !== undefined ? opts.fmtArgIdx : 0xFF,
    callConv: opts.callConv || CALL_CONV.AAPCS64,
    category: opts.category || 'libc',
  };
}

// ---------------------------------------------------------------------------
// Core Type Descriptors
// ---------------------------------------------------------------------------
export const CORE_TIL_TYPES = Object.freeze([
  // Typedefs & POSIX structs
  { tid: CORE_TID.FILE, name: 'FILE', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.SIZE_T, name: 'size_t', kind: HEX_KIND.SCALAR, bits: 64, qualifiers: 0, pointeeTid: TIL_PRIM.U64 },
  { tid: CORE_TID.SSIZE_T, name: 'ssize_t', kind: HEX_KIND.SCALAR, bits: 64, qualifiers: TYPE_QUAL.SIGNED, pointeeTid: TIL_PRIM.I64 },
  { tid: CORE_TID.PTRDIFF_T, name: 'ptrdiff_t', kind: HEX_KIND.SCALAR, bits: 64, qualifiers: TYPE_QUAL.SIGNED, pointeeTid: TIL_PRIM.I64 },
  { tid: CORE_TID.INTPTR_T, name: 'intptr_t', kind: HEX_KIND.SCALAR, bits: 64, qualifiers: TYPE_QUAL.SIGNED, pointeeTid: TIL_PRIM.I64 },
  { tid: CORE_TID.UINTPTR_T, name: 'uintptr_t', kind: HEX_KIND.SCALAR, bits: 64, qualifiers: 0, pointeeTid: TIL_PRIM.U64 },
  { tid: CORE_TID.OFF_T, name: 'off_t', kind: HEX_KIND.SCALAR, bits: 64, qualifiers: TYPE_QUAL.SIGNED, pointeeTid: TIL_PRIM.I64 },
  { tid: CORE_TID.PID_T, name: 'pid_t', kind: HEX_KIND.SCALAR, bits: 32, qualifiers: TYPE_QUAL.SIGNED, pointeeTid: TIL_PRIM.I32 },
  { tid: CORE_TID.UID_T, name: 'uid_t', kind: HEX_KIND.SCALAR, bits: 32, qualifiers: 0, pointeeTid: TIL_PRIM.U32 },
  { tid: CORE_TID.GID_T, name: 'gid_t', kind: HEX_KIND.SCALAR, bits: 32, qualifiers: 0, pointeeTid: TIL_PRIM.U32 },
  { tid: CORE_TID.MODE_T, name: 'mode_t', kind: HEX_KIND.SCALAR, bits: 32, qualifiers: 0, pointeeTid: TIL_PRIM.U32 },
  { tid: CORE_TID.TIME_T, name: 'time_t', kind: HEX_KIND.SCALAR, bits: 64, qualifiers: TYPE_QUAL.SIGNED, pointeeTid: TIL_PRIM.I64 },
  { tid: CORE_TID.CLOCKID_T, name: 'clockid_t', kind: HEX_KIND.SCALAR, bits: 32, qualifiers: TYPE_QUAL.SIGNED, pointeeTid: TIL_PRIM.I32 },
  { tid: CORE_TID.SOCKLEN_T, name: 'socklen_t', kind: HEX_KIND.SCALAR, bits: 32, qualifiers: 0, pointeeTid: TIL_PRIM.U32 },
  { tid: CORE_TID.VA_LIST, name: 'va_list', kind: HEX_KIND.SCALAR, bits: 64, qualifiers: 0, pointeeTid: TIL_PRIM.VOID },
  { tid: CORE_TID.JMP_BUF, name: 'jmp_buf', kind: HEX_KIND.ARRAY, bits: 64, qualifiers: 0, pointeeTid: TIL_PRIM.I64 },
  { tid: CORE_TID.DIR, name: 'DIR', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.DIRENT, name: 'dirent', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.STAT, name: 'stat', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.TIMESPEC, name: 'timespec', kind: HEX_KIND.STRUCT, bits: 128, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.TIMEVAL, name: 'timeval', kind: HEX_KIND.STRUCT, bits: 128, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.TM, name: 'tm', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.SOCKADDR, name: 'sockaddr', kind: HEX_KIND.STRUCT, bits: 128, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.SOCKADDR_IN, name: 'sockaddr_in', kind: HEX_KIND.STRUCT, bits: 128, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.SOCKADDR_IN6, name: 'sockaddr_in6', kind: HEX_KIND.STRUCT, bits: 224, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.ADDRINFO, name: 'addrinfo', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.IOVEC, name: 'iovec', kind: HEX_KIND.STRUCT, bits: 128, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.PTHREAD_T, name: 'pthread_t', kind: HEX_KIND.SCALAR, bits: 64, qualifiers: 0, pointeeTid: TIL_PRIM.U64 },
  { tid: CORE_TID.PTHREAD_ATTR_T, name: 'pthread_attr_t', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.PTHREAD_MUTEX_T, name: 'pthread_mutex_t', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.PTHREAD_MUTEXATTR_T, name: 'pthread_mutexattr_t', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.PTHREAD_COND_T, name: 'pthread_cond_t', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.PTHREAD_CONDATTR_T, name: 'pthread_condattr_t', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.SIGACTION, name: 'sigaction', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.RLIMIT, name: 'rlimit', kind: HEX_KIND.STRUCT, bits: 128, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.DIV_T, name: 'div_t', kind: HEX_KIND.STRUCT, bits: 64, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.LDIV_T, name: 'ldiv_t', kind: HEX_KIND.STRUCT, bits: 128, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.LLDIV_T, name: 'lldiv_t', kind: HEX_KIND.STRUCT, bits: 128, qualifiers: 0, pointeeTid: 0 },

  // Darwin / ObjC / CF / CG
  { tid: CORE_TID.OBJC_CLASS, name: 'objc_class', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.OBJC_OBJECT, name: 'objc_object', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 64, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.OBJC_SUPER, name: 'objc_super', kind: HEX_KIND.STRUCT, bits: 128, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.OBJC_METHOD, name: 'objc_method', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.OBJC_IVAR, name: 'objc_ivar', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.OBJC_PROTOCOL, name: 'Protocol', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.OBJC_PROPERTY, name: 'objc_property', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.DISPATCH_OBJECT_T, name: 'dispatch_object_t', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 64, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.DISPATCH_QUEUE_T, name: 'dispatch_queue_t', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 64, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.DISPATCH_GROUP_T, name: 'dispatch_group_t', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 64, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.DISPATCH_SEMAPHORE_T, name: 'dispatch_semaphore_t', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 64, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.DISPATCH_TIME_T, name: 'dispatch_time_t', kind: HEX_KIND.SCALAR, bits: 64, qualifiers: 0, pointeeTid: TIL_PRIM.U64 },
  { tid: CORE_TID.OS_LOG_T, name: 'os_log_t', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 64, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.CFSTRING_REF, name: 'CFStringRef', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 64, qualifiers: TYPE_QUAL.CONST, pointeeTid: 0 },
  { tid: CORE_TID.CFARRAY_REF, name: 'CFArrayRef', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 64, qualifiers: TYPE_QUAL.CONST, pointeeTid: 0 },
  { tid: CORE_TID.CFDICTIONARY_REF, name: 'CFDictionaryRef', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 64, qualifiers: TYPE_QUAL.CONST, pointeeTid: 0 },
  { tid: CORE_TID.CFDATA_REF, name: 'CFDataRef', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 64, qualifiers: TYPE_QUAL.CONST, pointeeTid: 0 },
  { tid: CORE_TID.CFALLOCATOR_REF, name: 'CFAllocatorRef', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 64, qualifiers: TYPE_QUAL.CONST, pointeeTid: 0 },
  { tid: CORE_TID.CGPOINT, name: 'CGPoint', kind: HEX_KIND.STRUCT, bits: 128, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.CGSIZE, name: 'CGSize', kind: HEX_KIND.STRUCT, bits: 128, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.CGRECT, name: 'CGRect', kind: HEX_KIND.STRUCT, bits: 256, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.NSRANGE, name: 'NSRange', kind: HEX_KIND.STRUCT, bits: 128, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.NSINTEGER, name: 'NSInteger', kind: HEX_KIND.SCALAR, bits: 64, qualifiers: TYPE_QUAL.SIGNED, pointeeTid: TIL_PRIM.I64 },
  { tid: CORE_TID.NSUINTEGER, name: 'NSUInteger', kind: HEX_KIND.SCALAR, bits: 64, qualifiers: 0, pointeeTid: TIL_PRIM.U64 },
  { tid: CORE_TID.CGFLOAT, name: 'CGFloat', kind: HEX_KIND.SCALAR, bits: 64, qualifiers: TYPE_QUAL.SIGNED, pointeeTid: TIL_PRIM.F64 },
  { tid: CORE_TID.MACH_PORT_T, name: 'mach_port_t', kind: HEX_KIND.SCALAR, bits: 32, qualifiers: 0, pointeeTid: TIL_PRIM.U32 },
  { tid: CORE_TID.KERN_RETURN_T, name: 'kern_return_t', kind: HEX_KIND.SCALAR, bits: 32, qualifiers: TYPE_QUAL.SIGNED, pointeeTid: TIL_PRIM.I32 },
  { tid: CORE_TID.VM_ADDRESS_T, name: 'vm_address_t', kind: HEX_KIND.SCALAR, bits: 64, qualifiers: 0, pointeeTid: TIL_PRIM.U64 },
  { tid: CORE_TID.VM_SIZE_T, name: 'vm_size_t', kind: HEX_KIND.SCALAR, bits: 64, qualifiers: 0, pointeeTid: TIL_PRIM.U64 },
  { tid: CORE_TID.OSSTATUS, name: 'OSStatus', kind: HEX_KIND.SCALAR, bits: 32, qualifiers: TYPE_QUAL.SIGNED, pointeeTid: TIL_PRIM.I32 },
  { tid: CORE_TID.CFNUMBER_REF, name: 'CFNumberRef', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 64, qualifiers: TYPE_QUAL.CONST, pointeeTid: 0 },
  { tid: CORE_TID.CFURL_REF, name: 'CFURLRef', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 64, qualifiers: TYPE_QUAL.CONST, pointeeTid: 0 },
  { tid: CORE_TID.CFBUNDLE_REF, name: 'CFBundleRef', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 64, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.CFRUNLOOP_REF, name: 'CFRunLoopRef', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 64, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.CFUUID_REF, name: 'CFUUIDRef', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 64, qualifiers: TYPE_QUAL.CONST, pointeeTid: 0 },
  { tid: CORE_TID.CGCONTEXT_REF, name: 'CGContextRef', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 64, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.CGIMAGE_REF, name: 'CGImageRef', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 64, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.CGCOLORSPACE_REF, name: 'CGColorSpaceRef', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 64, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.MACH_TIMEBASE_INFO_T, name: 'mach_timebase_info_data_t', kind: HEX_KIND.STRUCT, bits: 64, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.SWIFT_METADATA, name: 'SwiftMetadata', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.SWIFT_HEAP_OBJECT, name: 'SwiftHeapObject', kind: HEX_KIND.OBJC_OR_SWIFT_OBJ, bits: 128, qualifiers: 0, pointeeTid: 0 },

  // IL2CPP
  { tid: CORE_TID.IL2CPP_OBJECT, name: 'Il2CppObject', kind: HEX_KIND.STRUCT, bits: 128, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.IL2CPP_CLASS, name: 'Il2CppClass', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.IL2CPP_STRING, name: 'Il2CppString', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.IL2CPP_ARRAY, name: 'Il2CppArray', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.IL2CPP_DOMAIN, name: 'Il2CppDomain', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.IL2CPP_ASSEMBLY, name: 'Il2CppAssembly', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.IL2CPP_IMAGE, name: 'Il2CppImage', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.IL2CPP_TYPE, name: 'Il2CppType', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.IL2CPP_METHOD_INFO, name: 'MethodInfo', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.IL2CPP_FIELD_INFO, name: 'FieldInfo', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.IL2CPP_PROPERTY_INFO, name: 'PropertyInfo', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.IL2CPP_EXCEPTION, name: 'Il2CppException', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.IL2CPP_THREAD, name: 'Il2CppThread', kind: HEX_KIND.STRUCT, bits: 0, qualifiers: 0, pointeeTid: 0 },

  // C++ ABI / STL
  { tid: CORE_TID.STD_STRING, name: 'std::string', kind: HEX_KIND.STRUCT, bits: 192, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.STD_VECTOR, name: 'std::vector', kind: HEX_KIND.STRUCT, bits: 192, qualifiers: 0, pointeeTid: 0 },
  { tid: CORE_TID.STD_TYPE_INFO, name: 'std::type_info', kind: HEX_KIND.STRUCT, bits: 128, qualifiers: 0, pointeeTid: 0 },

  // Core Enums
  { tid: CORE_TID.ENUM_SEEK_WHENCE, name: 'seek_whence_t', kind: HEX_KIND.SCALAR, bits: 32, qualifiers: TYPE_QUAL.SIGNED | TYPE_QUAL.ENUM, pointeeTid: TIL_PRIM.I32 },
  { tid: CORE_TID.ENUM_OPEN_FLAGS, name: 'open_flags_t', kind: HEX_KIND.SCALAR, bits: 32, qualifiers: TYPE_QUAL.SIGNED | TYPE_QUAL.BITMASK, pointeeTid: TIL_PRIM.I32 },
  { tid: CORE_TID.ENUM_MMAP_PROT, name: 'mmap_prot_t', kind: HEX_KIND.SCALAR, bits: 32, qualifiers: TYPE_QUAL.SIGNED | TYPE_QUAL.BITMASK, pointeeTid: TIL_PRIM.I32 },
  { tid: CORE_TID.ENUM_MMAP_FLAGS, name: 'mmap_flags_t', kind: HEX_KIND.SCALAR, bits: 32, qualifiers: TYPE_QUAL.SIGNED | TYPE_QUAL.BITMASK, pointeeTid: TIL_PRIM.I32 },
  { tid: CORE_TID.ENUM_SOCKET_DOMAIN, name: 'socket_domain_t', kind: HEX_KIND.SCALAR, bits: 32, qualifiers: TYPE_QUAL.SIGNED | TYPE_QUAL.ENUM, pointeeTid: TIL_PRIM.I32 },
  { tid: CORE_TID.ENUM_SOCKET_TYPE, name: 'socket_type_t', kind: HEX_KIND.SCALAR, bits: 32, qualifiers: TYPE_QUAL.SIGNED | TYPE_QUAL.ENUM, pointeeTid: TIL_PRIM.I32 },
  { tid: CORE_TID.ENUM_OS_LOG_TYPE, name: 'os_log_type_t', kind: HEX_KIND.SCALAR, bits: 8, qualifiers: TYPE_QUAL.ENUM, pointeeTid: TIL_PRIM.U8 },
  { tid: CORE_TID.ENUM_DLOPEN_FLAGS, name: 'dlopen_flags_t', kind: HEX_KIND.SCALAR, bits: 32, qualifiers: TYPE_QUAL.SIGNED | TYPE_QUAL.BITMASK, pointeeTid: TIL_PRIM.I32 },
]);

// ---------------------------------------------------------------------------
// Core Enum Definitions (ExtChunk)
// ---------------------------------------------------------------------------
export const CORE_TIL_ENUMS = Object.freeze([
  {
    tid: CORE_TID.ENUM_SEEK_WHENCE,
    name: 'seek_whence_t',
    isBitmask: false,
    items: [
      { name: 'SEEK_SET', value: 0 },
      { name: 'SEEK_CUR', value: 1 },
      { name: 'SEEK_END', value: 2 },
    ],
  },
  {
    tid: CORE_TID.ENUM_OPEN_FLAGS,
    name: 'open_flags_t',
    isBitmask: true,
    items: [
      { name: 'O_RDONLY', value: 0x0000 },
      { name: 'O_WRONLY', value: 0x0001 },
      { name: 'O_RDWR', value: 0x0002 },
      { name: 'O_CREAT', value: 0x0040 },
      { name: 'O_EXCL', value: 0x0080 },
      { name: 'O_TRUNC', value: 0x0200 },
      { name: 'O_APPEND', value: 0x0400 },
      { name: 'O_NONBLOCK', value: 0x0800 },
    ],
  },
  {
    tid: CORE_TID.ENUM_MMAP_PROT,
    name: 'mmap_prot_t',
    isBitmask: true,
    items: [
      { name: 'PROT_NONE', value: 0x0 },
      { name: 'PROT_READ', value: 0x1 },
      { name: 'PROT_WRITE', value: 0x2 },
      { name: 'PROT_EXEC', value: 0x4 },
    ],
  },
  {
    tid: CORE_TID.ENUM_MMAP_FLAGS,
    name: 'mmap_flags_t',
    isBitmask: true,
    items: [
      { name: 'MAP_SHARED', value: 0x01 },
      { name: 'MAP_PRIVATE', value: 0x02 },
      { name: 'MAP_FIXED', value: 0x10 },
      { name: 'MAP_ANONYMOUS', value: 0x20 },
    ],
  },
  {
    tid: CORE_TID.ENUM_SOCKET_DOMAIN,
    name: 'socket_domain_t',
    isBitmask: false,
    items: [
      { name: 'AF_UNIX', value: 1 },
      { name: 'AF_INET', value: 2 },
      { name: 'AF_INET6', value: 10 },
    ],
  },
  {
    tid: CORE_TID.ENUM_SOCKET_TYPE,
    name: 'socket_type_t',
    isBitmask: false,
    items: [
      { name: 'SOCK_STREAM', value: 1 },
      { name: 'SOCK_DGRAM', value: 2 },
      { name: 'SOCK_RAW', value: 3 },
    ],
  },
  {
    tid: CORE_TID.ENUM_OS_LOG_TYPE,
    name: 'os_log_type_t',
    isBitmask: false,
    items: [
      { name: 'OS_LOG_TYPE_DEFAULT', value: 0x00 },
      { name: 'OS_LOG_TYPE_INFO', value: 0x01 },
      { name: 'OS_LOG_TYPE_DEBUG', value: 0x02 },
      { name: 'OS_LOG_TYPE_ERROR', value: 0x10 },
      { name: 'OS_LOG_TYPE_FAULT', value: 0x11 },
    ],
  },
  {
    tid: CORE_TID.ENUM_DLOPEN_FLAGS,
    name: 'dlopen_flags_t',
    isBitmask: true,
    items: [
      { name: 'RTLD_LAZY', value: 0x1 },
      { name: 'RTLD_NOW', value: 0x2 },
      { name: 'RTLD_LOCAL', value: 0x4 },
      { name: 'RTLD_GLOBAL', value: 0x8 },
    ],
  },
]);

// ---------------------------------------------------------------------------
// Core Struct Layouts (ExtChunk)
// ---------------------------------------------------------------------------
export const CORE_TIL_STRUCT_LAYOUTS = Object.freeze([
  {
    tid: CORE_TID.TIMESPEC,
    name: 'timespec',
    totalSize: 16,
    members: [
      { offset: 0, name: 'tv_sec', hexType: T_TIME, size: 8, bfLsb: 0, bfWidth: 0 },
      { offset: 8, name: 'tv_nsec', hexType: T_I64, size: 8, bfLsb: 0, bfWidth: 0 },
    ],
  },
  {
    tid: CORE_TID.TIMEVAL,
    name: 'timeval',
    totalSize: 16,
    members: [
      { offset: 0, name: 'tv_sec', hexType: T_TIME, size: 8, bfLsb: 0, bfWidth: 0 },
      { offset: 8, name: 'tv_usec', hexType: T_I64, size: 8, bfLsb: 0, bfWidth: 0 },
    ],
  },
  {
    tid: CORE_TID.IOVEC,
    name: 'iovec',
    totalSize: 16,
    members: [
      { offset: 0, name: 'iov_base', hexType: T_VPTR, size: 8, bfLsb: 0, bfWidth: 0 },
      { offset: 8, name: 'iov_len', hexType: T_SIZE, size: 8, bfLsb: 0, bfWidth: 0 },
    ],
  },
  {
    tid: CORE_TID.CGPOINT,
    name: 'CGPoint',
    totalSize: 16,
    members: [
      { offset: 0, name: 'x', hexType: T_F64, size: 8, bfLsb: 0, bfWidth: 0 },
      { offset: 8, name: 'y', hexType: T_F64, size: 8, bfLsb: 0, bfWidth: 0 },
    ],
  },
  {
    tid: CORE_TID.CGSIZE,
    name: 'CGSize',
    totalSize: 16,
    members: [
      { offset: 0, name: 'width', hexType: T_F64, size: 8, bfLsb: 0, bfWidth: 0 },
      { offset: 8, name: 'height', hexType: T_F64, size: 8, bfLsb: 0, bfWidth: 0 },
    ],
  },
  {
    tid: CORE_TID.CGRECT,
    name: 'CGRect',
    totalSize: 32,
    members: [
      { offset: 0, name: 'origin', hexType: makeHexTypeId({ baseTilId: CORE_TID.CGPOINT, kindTag: HEX_KIND.STRUCT }), size: 16, bfLsb: 0, bfWidth: 0 },
      { offset: 16, name: 'size', hexType: makeHexTypeId({ baseTilId: CORE_TID.CGSIZE, kindTag: HEX_KIND.STRUCT }), size: 16, bfLsb: 0, bfWidth: 0 },
    ],
  },
  {
    tid: CORE_TID.NSRANGE,
    name: 'NSRange',
    totalSize: 16,
    members: [
      { offset: 0, name: 'location', hexType: T_NSUINT, size: 8, bfLsb: 0, bfWidth: 0 },
      { offset: 8, name: 'length', hexType: T_NSUINT, size: 8, bfLsb: 0, bfWidth: 0 },
    ],
  },
  {
    tid: CORE_TID.OBJC_SUPER,
    name: 'objc_super',
    totalSize: 16,
    members: [
      { offset: 0, name: 'receiver', hexType: T_ID, size: 8, bfLsb: 0, bfWidth: 0 },
      { offset: 8, name: 'super_class', hexType: T_CLASS, size: 8, bfLsb: 0, bfWidth: 0 },
    ],
  },
  {
    tid: CORE_TID.IL2CPP_OBJECT,
    name: 'Il2CppObject',
    totalSize: 16,
    members: [
      { offset: 0, name: 'klass', hexType: T_IL2_CLASS, size: 8, bfLsb: 0, bfWidth: 0 },
      { offset: 8, name: 'monitor', hexType: T_VPTR, size: 8, bfLsb: 0, bfWidth: 0 },
    ],
  },
  {
    tid: CORE_TID.IL2CPP_STRING,
    name: 'Il2CppString',
    totalSize: 24,
    members: [
      { offset: 0, name: 'object', hexType: makeHexTypeId({ baseTilId: CORE_TID.IL2CPP_OBJECT, kindTag: HEX_KIND.STRUCT }), size: 16, bfLsb: 0, bfWidth: 0 },
      { offset: 16, name: 'length', hexType: T_I32, size: 4, bfLsb: 0, bfWidth: 0 },
      { offset: 20, name: 'chars', hexType: makeHexTypeId({ baseTilId: TIL_PRIM.U16, kindTag: HEX_KIND.ARRAY, auxMeta: 1 }), size: 2, bfLsb: 0, bfWidth: 0 },
    ],
  },
  {
    tid: CORE_TID.DIV_T,
    name: 'div_t',
    totalSize: 8,
    members: [
      { offset: 0, name: 'quot', hexType: T_I32, size: 4, bfLsb: 0, bfWidth: 0 },
      { offset: 4, name: 'rem', hexType: T_I32, size: 4, bfLsb: 0, bfWidth: 0 },
    ],
  },
]);

// ---------------------------------------------------------------------------
// Core Function Signatures (~210 curated POSIX/libc/libm/Darwin/ObjC/C++/IL2CPP)
// ---------------------------------------------------------------------------
export const CORE_TIL_FUNCTIONS = Object.freeze([
  // --- stdio ---
  fn('printf', T_I32, [T_CSTR], { variadic: true, fmtFamily: FMT_FAMILY.PRINTF, fmtArgIdx: 0, category: 'stdio' }),
  fn('fprintf', T_I32, [T_FILE_PTR, T_CSTR], { variadic: true, fmtFamily: FMT_FAMILY.PRINTF, fmtArgIdx: 1, category: 'stdio' }),
  fn('sprintf', T_I32, [T_STR, T_CSTR], { variadic: true, fmtFamily: FMT_FAMILY.PRINTF, fmtArgIdx: 1, category: 'stdio' }),
  fn('snprintf', T_I32, [T_STR, T_SIZE, T_CSTR], { variadic: true, fmtFamily: FMT_FAMILY.PRINTF, fmtArgIdx: 2, category: 'stdio' }),
  fn('vprintf', T_I32, [T_CSTR, T_VA_LIST], { fmtFamily: FMT_FAMILY.PRINTF, fmtArgIdx: 0, category: 'stdio' }),
  fn('vfprintf', T_I32, [T_FILE_PTR, T_CSTR, T_VA_LIST], { fmtFamily: FMT_FAMILY.PRINTF, fmtArgIdx: 1, category: 'stdio' }),
  fn('vsprintf', T_I32, [T_STR, T_CSTR, T_VA_LIST], { fmtFamily: FMT_FAMILY.PRINTF, fmtArgIdx: 1, category: 'stdio' }),
  fn('vsnprintf', T_I32, [T_STR, T_SIZE, T_CSTR, T_VA_LIST], { fmtFamily: FMT_FAMILY.PRINTF, fmtArgIdx: 2, category: 'stdio' }),
  fn('scanf', T_I32, [T_CSTR], { variadic: true, fmtFamily: FMT_FAMILY.SCANF, fmtArgIdx: 0, category: 'stdio' }),
  fn('fscanf', T_I32, [T_FILE_PTR, T_CSTR], { variadic: true, fmtFamily: FMT_FAMILY.SCANF, fmtArgIdx: 1, category: 'stdio' }),
  fn('sscanf', T_I32, [T_CSTR, T_CSTR], { variadic: true, fmtFamily: FMT_FAMILY.SCANF, fmtArgIdx: 1, category: 'stdio' }),
  fn('puts', T_I32, [T_CSTR], { category: 'stdio' }),
  fn('fputs', T_I32, [T_CSTR, T_FILE_PTR], { category: 'stdio' }),
  fn('fgets', T_STR, [T_STR, T_I32, T_FILE_PTR], { category: 'stdio' }),
  fn('putchar', T_I32, [T_I32], { category: 'stdio' }),
  fn('getchar', T_I32, [], { category: 'stdio' }),
  fn('fgetc', T_I32, [T_FILE_PTR], { category: 'stdio' }),
  fn('fputc', T_I32, [T_I32, T_FILE_PTR], { category: 'stdio' }),
  fn('ungetc', T_I32, [T_I32, T_FILE_PTR], { category: 'stdio' }),
  fn('fopen', T_FILE_PTR, [T_CSTR, T_CSTR], { alloc: true, category: 'stdio' }),
  fn('fdopen', T_FILE_PTR, [T_I32, T_CSTR], { alloc: true, category: 'stdio' }),
  fn('freopen', T_FILE_PTR, [T_CSTR, T_CSTR, T_FILE_PTR], { category: 'stdio' }),
  fn('fclose', T_I32, [T_FILE_PTR], { free: true, category: 'stdio' }),
  fn('fflush', T_I32, [T_FILE_PTR], { category: 'stdio' }),
  fn('fread', T_SIZE, [T_VPTR, T_SIZE, T_SIZE, T_FILE_PTR], { category: 'stdio' }),
  fn('fwrite', T_SIZE, [T_CVPTR, T_SIZE, T_SIZE, T_FILE_PTR], { category: 'stdio' }),
  fn('fseek', T_I32, [T_FILE_PTR, T_I64, T_ENUM_SEEK], { category: 'stdio' }),
  fn('fseeko', T_I32, [T_FILE_PTR, T_OFF, T_ENUM_SEEK], { category: 'stdio' }),
  fn('ftell', T_I64, [T_FILE_PTR], { category: 'stdio' }),
  fn('ftello', T_OFF, [T_FILE_PTR], { category: 'stdio' }),
  fn('rewind', T_VOID, [T_FILE_PTR], { category: 'stdio' }),
  fn('feof', T_I32, [T_FILE_PTR], { category: 'stdio' }),
  fn('ferror', T_I32, [T_FILE_PTR], { category: 'stdio' }),
  fn('clearerr', T_VOID, [T_FILE_PTR], { category: 'stdio' }),
  fn('fileno', T_I32, [T_FILE_PTR], { category: 'stdio' }),
  fn('perror', T_VOID, [T_CSTR], { category: 'stdio' }),
  fn('remove', T_I32, [T_CSTR], { category: 'stdio' }),
  fn('rename', T_I32, [T_CSTR, T_CSTR], { category: 'stdio' }),

  // --- stdlib & memory ---
  fn('malloc', T_VPTR, [T_SIZE], { alloc: true, category: 'stdlib' }),
  fn('calloc', T_VPTR, [T_SIZE, T_SIZE], { alloc: true, category: 'stdlib' }),
  fn('realloc', T_VPTR, [T_VPTR, T_SIZE], { alloc: true, category: 'stdlib' }),
  fn('aligned_alloc', T_VPTR, [T_SIZE, T_SIZE], { alloc: true, category: 'stdlib' }),
  fn('posix_memalign', T_I32, [T_VPPTR, T_SIZE, T_SIZE], { alloc: true, category: 'stdlib' }),
  fn('free', T_VOID, [T_VPTR], { free: true, category: 'stdlib' }),
  fn('atoi', T_I32, [T_CSTR], { category: 'stdlib' }),
  fn('atol', T_I64, [T_CSTR], { category: 'stdlib' }),
  fn('atoll', T_I64, [T_CSTR], { category: 'stdlib' }),
  fn('atof', T_F64, [T_CSTR], { category: 'stdlib' }),
  fn('strtol', T_I64, [T_CSTR, T_STRPTR, T_I32], { category: 'stdlib' }),
  fn('strtoll', T_I64, [T_CSTR, T_STRPTR, T_I32], { category: 'stdlib' }),
  fn('strtoul', T_U64, [T_CSTR, T_STRPTR, T_I32], { category: 'stdlib' }),
  fn('strtoull', T_U64, [T_CSTR, T_STRPTR, T_I32], { category: 'stdlib' }),
  fn('strtod', T_F64, [T_CSTR, T_STRPTR], { category: 'stdlib' }),
  fn('strtof', T_F32, [T_CSTR, T_STRPTR], { category: 'stdlib' }),
  fn('abs', T_I32, [T_I32], { category: 'stdlib' }),
  fn('labs', T_I64, [T_I64], { category: 'stdlib' }),
  fn('llabs', T_I64, [T_I64], { category: 'stdlib' }),
  fn('qsort', T_VOID, [T_VPTR, T_SIZE, T_SIZE, T_FN_PTR], { category: 'stdlib' }),
  fn('bsearch', T_VPTR, [T_CVPTR, T_CVPTR, T_SIZE, T_SIZE, T_FN_PTR], { category: 'stdlib' }),
  fn('exit', T_VOID, [T_I32], { noreturn: true, category: 'stdlib' }),
  fn('_exit', T_VOID, [T_I32], { noreturn: true, category: 'stdlib' }),
  fn('quick_exit', T_VOID, [T_I32], { noreturn: true, category: 'stdlib' }),
  fn('abort', T_VOID, [], { noreturn: true, category: 'stdlib' }),
  fn('atexit', T_I32, [T_FN_PTR], { category: 'stdlib' }),
  fn('rand', T_I32, [], { category: 'stdlib' }),
  fn('srand', T_VOID, [T_U32], { category: 'stdlib' }),
  fn('arc4random', T_U32, [], { category: 'stdlib' }),
  fn('arc4random_uniform', T_U32, [T_U32], { category: 'stdlib' }),
  fn('arc4random_buf', T_VOID, [T_VPTR, T_SIZE], { category: 'stdlib' }),
  fn('getenv', T_STR, [T_CSTR], { category: 'stdlib' }),
  fn('setenv', T_I32, [T_CSTR, T_CSTR, T_I32], { category: 'stdlib' }),
  fn('unsetenv', T_I32, [T_CSTR], { category: 'stdlib' }),
  fn('system', T_I32, [T_CSTR], { category: 'stdlib' }),
  fn('__stack_chk_fail', T_VOID, [], { noreturn: true, category: 'stdlib' }),
  fn('__assert_fail', T_VOID, [T_CSTR, T_CSTR, T_U32, T_CSTR], { noreturn: true, category: 'stdlib' }),
  fn('longjmp', T_VOID, [T_JMP_BUF, T_I32], { noreturn: true, category: 'stdlib' }),
  fn('setjmp', T_I32, [T_JMP_BUF], { category: 'stdlib' }),

  // --- string & memory ---
  fn('memcpy', T_VPTR, [T_VPTR, T_CVPTR, T_SIZE], { category: 'string' }),
  fn('memmove', T_VPTR, [T_VPTR, T_CVPTR, T_SIZE], { category: 'string' }),
  fn('memset', T_VPTR, [T_VPTR, T_I32, T_SIZE], { category: 'string' }),
  fn('memcmp', T_I32, [T_CVPTR, T_CVPTR, T_SIZE], { category: 'string' }),
  fn('memchr', T_VPTR, [T_CVPTR, T_I32, T_SIZE], { category: 'string' }),
  fn('bzero', T_VOID, [T_VPTR, T_SIZE], { category: 'string' }),
  fn('bcopy', T_VOID, [T_CVPTR, T_VPTR, T_SIZE], { category: 'string' }),
  fn('strlen', T_SIZE, [T_CSTR], { category: 'string' }),
  fn('strnlen', T_SIZE, [T_CSTR, T_SIZE], { category: 'string' }),
  fn('strcmp', T_I32, [T_CSTR, T_CSTR], { category: 'string' }),
  fn('strncmp', T_I32, [T_CSTR, T_CSTR, T_SIZE], { category: 'string' }),
  fn('strcasecmp', T_I32, [T_CSTR, T_CSTR], { category: 'string' }),
  fn('strncasecmp', T_I32, [T_CSTR, T_CSTR, T_SIZE], { category: 'string' }),
  fn('strcpy', T_STR, [T_STR, T_CSTR], { category: 'string' }),
  fn('stpcpy', T_STR, [T_STR, T_CSTR], { category: 'string' }),
  fn('strncpy', T_STR, [T_STR, T_CSTR, T_SIZE], { category: 'string' }),
  fn('strlcpy', T_SIZE, [T_STR, T_CSTR, T_SIZE], { category: 'string' }),
  fn('strcat', T_STR, [T_STR, T_CSTR], { category: 'string' }),
  fn('strncat', T_STR, [T_STR, T_CSTR, T_SIZE], { category: 'string' }),
  fn('strlcat', T_SIZE, [T_STR, T_CSTR, T_SIZE], { category: 'string' }),
  fn('strchr', T_STR, [T_CSTR, T_I32], { category: 'string' }),
  fn('strrchr', T_STR, [T_CSTR, T_I32], { category: 'string' }),
  fn('strstr', T_STR, [T_CSTR, T_CSTR], { category: 'string' }),
  fn('strpbrk', T_STR, [T_CSTR, T_CSTR], { category: 'string' }),
  fn('strspn', T_SIZE, [T_CSTR, T_CSTR], { category: 'string' }),
  fn('strcspn', T_SIZE, [T_CSTR, T_CSTR], { category: 'string' }),
  fn('strtok', T_STR, [T_STR, T_CSTR], { category: 'string' }),
  fn('strtok_r', T_STR, [T_STR, T_CSTR, T_STRPTR], { category: 'string' }),
  fn('strdup', T_STR, [T_CSTR], { alloc: true, category: 'string' }),
  fn('strndup', T_STR, [T_CSTR, T_SIZE], { alloc: true, category: 'string' }),
  fn('strerror', T_STR, [T_I32], { category: 'string' }),
  fn('__memcpy_chk', T_VPTR, [T_VPTR, T_CVPTR, T_SIZE, T_SIZE], { category: 'string' }),
  fn('__memmove_chk', T_VPTR, [T_VPTR, T_CVPTR, T_SIZE, T_SIZE], { category: 'string' }),
  fn('__memset_chk', T_VPTR, [T_VPTR, T_I32, T_SIZE, T_SIZE], { category: 'string' }),
  fn('__strcpy_chk', T_STR, [T_STR, T_CSTR, T_SIZE], { category: 'string' }),
  fn('__strncpy_chk', T_STR, [T_STR, T_CSTR, T_SIZE, T_SIZE], { category: 'string' }),
  fn('__strcat_chk', T_STR, [T_STR, T_CSTR, T_SIZE], { category: 'string' }),
  fn('__snprintf_chk', T_I32, [T_STR, T_SIZE, T_I32, T_SIZE, T_CSTR], { variadic: true, fmtFamily: FMT_FAMILY.PRINTF, fmtArgIdx: 4, category: 'string' }),

  // --- ctype ---
  fn('isalpha', T_I32, [T_I32], { category: 'ctype' }),
  fn('isdigit', T_I32, [T_I32], { category: 'ctype' }),
  fn('isalnum', T_I32, [T_I32], { category: 'ctype' }),
  fn('isspace', T_I32, [T_I32], { category: 'ctype' }),
  fn('isupper', T_I32, [T_I32], { category: 'ctype' }),
  fn('islower', T_I32, [T_I32], { category: 'ctype' }),
  fn('isprint', T_I32, [T_I32], { category: 'ctype' }),
  fn('isxdigit', T_I32, [T_I32], { category: 'ctype' }),
  fn('tolower', T_I32, [T_I32], { category: 'ctype' }),
  fn('toupper', T_I32, [T_I32], { category: 'ctype' }),
  fn('__errno_location', T_I32PTR, [], { category: 'errno' }),
  fn('__error', T_I32PTR, [], { category: 'errno' }),

  // --- POSIX I/O, mmap, sockets, dlfcn, pthread, time ---
  fn('open', T_I32, [T_CSTR, T_ENUM_OPEN], { variadic: true, category: 'posix' }),
  fn('openat', T_I32, [T_I32, T_CSTR, T_ENUM_OPEN], { variadic: true, category: 'posix' }),
  fn('close', T_I32, [T_I32], { category: 'posix' }),
  fn('read', T_SSIZE, [T_I32, T_VPTR, T_SIZE], { category: 'posix' }),
  fn('write', T_SSIZE, [T_I32, T_CVPTR, T_SIZE], { category: 'posix' }),
  fn('pread', T_SSIZE, [T_I32, T_VPTR, T_SIZE, T_OFF], { category: 'posix' }),
  fn('pwrite', T_SSIZE, [T_I32, T_CVPTR, T_SIZE, T_OFF], { category: 'posix' }),
  fn('lseek', T_OFF, [T_I32, T_OFF, T_ENUM_SEEK], { category: 'posix' }),
  fn('ioctl', T_I32, [T_I32, T_U64], { variadic: true, category: 'posix' }),
  fn('fcntl', T_I32, [T_I32, T_I32], { variadic: true, category: 'posix' }),
  fn('stat', T_I32, [T_CSTR, T_STAT_PTR], { category: 'posix' }),
  fn('fstat', T_I32, [T_I32, T_STAT_PTR], { category: 'posix' }),
  fn('lstat', T_I32, [T_CSTR, T_STAT_PTR], { category: 'posix' }),
  fn('access', T_I32, [T_CSTR, T_I32], { category: 'posix' }),
  fn('unlink', T_I32, [T_CSTR], { category: 'posix' }),
  fn('mkdir', T_I32, [T_CSTR, T_MODE], { category: 'posix' }),
  fn('rmdir', T_I32, [T_CSTR], { category: 'posix' }),
  fn('opendir', T_DIR_PTR, [T_CSTR], { alloc: true, category: 'posix' }),
  fn('readdir', T_DIRENT_PTR, [T_DIR_PTR], { category: 'posix' }),
  fn('closedir', T_I32, [T_DIR_PTR], { free: true, category: 'posix' }),
  fn('mmap', T_VPTR, [T_VPTR, T_SIZE, T_ENUM_PROT, T_ENUM_MMAP, T_I32, T_OFF], { alloc: true, category: 'posix' }),
  fn('munmap', T_I32, [T_VPTR, T_SIZE], { free: true, category: 'posix' }),
  fn('mprotect', T_I32, [T_VPTR, T_SIZE, T_ENUM_PROT], { category: 'posix' }),
  fn('socket', T_I32, [T_ENUM_AF, T_ENUM_SOCK, T_I32], { category: 'posix' }),
  fn('connect', T_I32, [T_I32, T_CSOCKADDR_PTR, T_SOCKLEN], { category: 'posix' }),
  fn('bind', T_I32, [T_I32, T_CSOCKADDR_PTR, T_SOCKLEN], { category: 'posix' }),
  fn('listen', T_I32, [T_I32, T_I32], { category: 'posix' }),
  fn('accept', T_I32, [T_I32, T_SOCKADDR_PTR, T_SOCKLEN_PTR], { category: 'posix' }),
  fn('send', T_SSIZE, [T_I32, T_CVPTR, T_SIZE, T_I32], { category: 'posix' }),
  fn('recv', T_SSIZE, [T_I32, T_VPTR, T_SIZE, T_I32], { category: 'posix' }),
  fn('sendto', T_SSIZE, [T_I32, T_CVPTR, T_SIZE, T_I32, T_CSOCKADDR_PTR, T_SOCKLEN], { category: 'posix' }),
  fn('recvfrom', T_SSIZE, [T_I32, T_VPTR, T_SIZE, T_I32, T_SOCKADDR_PTR, T_SOCKLEN_PTR], { category: 'posix' }),
  fn('setsockopt', T_I32, [T_I32, T_I32, T_I32, T_CVPTR, T_SOCKLEN], { category: 'posix' }),
  fn('getsockopt', T_I32, [T_I32, T_I32, T_I32, T_VPTR, T_SOCKLEN_PTR], { category: 'posix' }),
  fn('getaddrinfo', T_I32, [T_CSTR, T_CSTR, T_ADDRINFO_PTR, T_ADDRINFO_PPTR], { category: 'posix' }),
  fn('freeaddrinfo', T_VOID, [T_ADDRINFO_PTR], { free: true, category: 'posix' }),
  fn('dlopen', T_VPTR, [T_CSTR, T_ENUM_DLOPEN], { category: 'dlfcn' }),
  fn('dlsym', T_VPTR, [T_VPTR, T_CSTR], { category: 'dlfcn' }),
  fn('dlclose', T_I32, [T_VPTR], { category: 'dlfcn' }),
  fn('dlerror', T_STR, [], { category: 'dlfcn' }),
  fn('getpid', T_PID, [], { category: 'posix' }),
  fn('getppid', T_PID, [], { category: 'posix' }),
  fn('fork', T_PID, [], { category: 'posix' }),
  fn('execve', T_I32, [T_CSTR, T_STRPTR, T_STRPTR], { category: 'posix' }),
  fn('sleep', T_U32, [T_U32], { category: 'posix' }),
  fn('usleep', T_I32, [T_U32], { category: 'posix' }),
  fn('nanosleep', T_I32, [T_CTIMESPEC_PTR, T_TIMESPEC_PTR], { category: 'posix' }),
  fn('clock_gettime', T_I32, [makeHexTypeId({ baseTilId: CORE_TID.CLOCKID_T }), T_TIMESPEC_PTR], { category: 'time' }),
  fn('gettimeofday', T_I32, [T_TIMEVAL_PTR, T_VPTR], { category: 'time' }),
  fn('time', T_TIME, [hexPtr(CORE_TID.TIME_T)], { category: 'time' }),
  fn('localtime_r', T_TM_PTR, [hexPtr(CORE_TID.TIME_T, { isConst: true }), T_TM_PTR], { category: 'time' }),
  fn('gmtime_r', T_TM_PTR, [hexPtr(CORE_TID.TIME_T, { isConst: true }), T_TM_PTR], { category: 'time' }),
  fn('strftime', T_SIZE, [T_STR, T_SIZE, T_CSTR, T_CTM_PTR], { category: 'time' }),
  fn('pthread_create', T_I32, [T_PTHREAD_PTR, T_PTHREAD_ATTR_CPTR, T_FN_PTR, T_VPTR], { category: 'pthread' }),
  fn('pthread_join', T_I32, [T_PTHREAD, T_VPPTR], { category: 'pthread' }),
  fn('pthread_detach', T_I32, [T_PTHREAD], { category: 'pthread' }),
  fn('pthread_self', T_PTHREAD, [], { category: 'pthread' }),
  fn('pthread_mutex_init', T_I32, [T_MUTEX_PTR, T_MUTEXATTR_CPTR], { category: 'pthread' }),
  fn('pthread_mutex_lock', T_I32, [T_MUTEX_PTR], { category: 'pthread' }),
  fn('pthread_mutex_trylock', T_I32, [T_MUTEX_PTR], { category: 'pthread' }),
  fn('pthread_mutex_unlock', T_I32, [T_MUTEX_PTR], { category: 'pthread' }),
  fn('pthread_mutex_destroy', T_I32, [T_MUTEX_PTR], { category: 'pthread' }),
  fn('pthread_cond_init', T_I32, [T_COND_PTR, T_CONDATTR_CPTR], { category: 'pthread' }),
  fn('pthread_cond_wait', T_I32, [T_COND_PTR, T_MUTEX_PTR], { category: 'pthread' }),
  fn('pthread_cond_signal', T_I32, [T_COND_PTR], { category: 'pthread' }),
  fn('pthread_cond_broadcast', T_I32, [T_COND_PTR], { category: 'pthread' }),
  fn('pthread_cond_destroy', T_I32, [T_COND_PTR], { category: 'pthread' }),
  fn('pthread_once', T_I32, [T_I32PTR, T_FN_PTR], { category: 'pthread' }),

  // --- libm ---
  fn('sin', T_F64, [T_F64], { category: 'libm' }),
  fn('sinf', T_F32, [T_F32], { category: 'libm' }),
  fn('cos', T_F64, [T_F64], { category: 'libm' }),
  fn('cosf', T_F32, [T_F32], { category: 'libm' }),
  fn('tan', T_F64, [T_F64], { category: 'libm' }),
  fn('tanf', T_F32, [T_F32], { category: 'libm' }),
  fn('atan2', T_F64, [T_F64, T_F64], { category: 'libm' }),
  fn('atan2f', T_F32, [T_F32, T_F32], { category: 'libm' }),
  fn('sqrt', T_F64, [T_F64], { category: 'libm' }),
  fn('sqrtf', T_F32, [T_F32], { category: 'libm' }),
  fn('pow', T_F64, [T_F64, T_F64], { category: 'libm' }),
  fn('powf', T_F32, [T_F32, T_F32], { category: 'libm' }),
  fn('exp', T_F64, [T_F64], { category: 'libm' }),
  fn('expf', T_F32, [T_F32], { category: 'libm' }),
  fn('log', T_F64, [T_F64], { category: 'libm' }),
  fn('logf', T_F32, [T_F32], { category: 'libm' }),
  fn('log2', T_F64, [T_F64], { category: 'libm' }),
  fn('log10', T_F64, [T_F64], { category: 'libm' }),
  fn('floor', T_F64, [T_F64], { category: 'libm' }),
  fn('floorf', T_F32, [T_F32], { category: 'libm' }),
  fn('ceil', T_F64, [T_F64], { category: 'libm' }),
  fn('ceilf', T_F32, [T_F32], { category: 'libm' }),
  fn('round', T_F64, [T_F64], { category: 'libm' }),
  fn('roundf', T_F32, [T_F32], { category: 'libm' }),
  fn('fabs', T_F64, [T_F64], { category: 'libm' }),
  fn('fabsf', T_F32, [T_F32], { category: 'libm' }),
  fn('fmod', T_F64, [T_F64, T_F64], { category: 'libm' }),
  fn('fmodf', T_F32, [T_F32, T_F32], { category: 'libm' }),
  fn('ldexp', T_F64, [T_F64, T_I32], { category: 'libm' }),
  fn('frexp', T_F64, [T_F64, T_I32PTR], { category: 'libm' }),
  fn('modf', T_F64, [T_F64, T_F64PTR], { category: 'libm' }),
  fn('modff', T_F32, [T_F32, T_F32PTR], { category: 'libm' }),

  // --- Darwin / libSystem / GCD / os_log / Mach ---
  fn('_os_log_impl', T_VOID, [T_VPTR, T_OS_LOG, T_ENUM_OSLOG, T_CSTR, T_U8PTR, T_U32], { fmtFamily: FMT_FAMILY.OS_LOG_FIXED, fmtArgIdx: 3, category: 'darwin' }),
  fn('_os_log_error_impl', T_VOID, [T_VPTR, T_OS_LOG, T_ENUM_OSLOG, T_CSTR, T_U8PTR, T_U32], { fmtFamily: FMT_FAMILY.OS_LOG_FIXED, fmtArgIdx: 3, category: 'darwin' }),
  fn('_os_log_debug_impl', T_VOID, [T_VPTR, T_OS_LOG, T_ENUM_OSLOG, T_CSTR, T_U8PTR, T_U32], { fmtFamily: FMT_FAMILY.OS_LOG_FIXED, fmtArgIdx: 3, category: 'darwin' }),
  fn('_os_log_fault_impl', T_VOID, [T_VPTR, T_OS_LOG, T_ENUM_OSLOG, T_CSTR, T_U8PTR, T_U32], { fmtFamily: FMT_FAMILY.OS_LOG_FIXED, fmtArgIdx: 3, category: 'darwin' }),
  fn('os_log_type_enabled', T_BOOL, [T_OS_LOG, T_ENUM_OSLOG], { category: 'darwin' }),
  fn('os_log_create', T_OS_LOG, [T_CSTR, T_CSTR], { category: 'darwin' }),
  fn('dispatch_async', T_VOID, [T_DISPATCH_QUEUE, T_ID], { category: 'darwin' }),
  fn('dispatch_sync', T_VOID, [T_DISPATCH_QUEUE, T_ID], { category: 'darwin' }),
  fn('dispatch_after', T_VOID, [T_DISPATCH_TIME, T_DISPATCH_QUEUE, T_ID], { category: 'darwin' }),
  fn('dispatch_once', T_VOID, [T_I64PTR, T_ID], { category: 'darwin' }),
  fn('dispatch_get_global_queue', T_DISPATCH_QUEUE, [T_I64, T_U64], { category: 'darwin' }),
  fn('dispatch_queue_create', T_DISPATCH_QUEUE, [T_CSTR, T_ID], { alloc: true, category: 'darwin' }),
  fn('dispatch_semaphore_create', T_DISPATCH_SEMA, [T_I64], { alloc: true, category: 'darwin' }),
  fn('dispatch_semaphore_wait', T_I64, [T_DISPATCH_SEMA, T_DISPATCH_TIME], { category: 'darwin' }),
  fn('dispatch_semaphore_signal', T_I64, [T_DISPATCH_SEMA], { category: 'darwin' }),
  fn('dispatch_group_create', T_DISPATCH_GROUP, [], { alloc: true, category: 'darwin' }),
  fn('dispatch_group_enter', T_VOID, [T_DISPATCH_GROUP], { category: 'darwin' }),
  fn('dispatch_group_leave', T_VOID, [T_DISPATCH_GROUP], { category: 'darwin' }),
  fn('dispatch_release', T_VOID, [T_ID], { free: true, category: 'darwin' }),
  fn('mach_task_self', T_MACH_PORT, [], { category: 'darwin' }),
  fn('mach_absolute_time', T_U64, [], { category: 'darwin' }),
  fn('sysctlbyname', T_I32, [T_CSTR, T_VPTR, hexPtr(CORE_TID.SIZE_T), T_VPTR, T_SIZE], { category: 'darwin' }),
  fn('CFStringCreateWithCString', T_CFSTRING, [T_CFALLOC, T_CSTR, T_U32], { alloc: true, category: 'darwin' }),
  fn('CFRelease', T_VOID, [T_CVPTR], { free: true, category: 'darwin' }),
  fn('CFRetain', T_CVPTR, [T_CVPTR], { category: 'darwin' }),
  fn('NSLog', T_VOID, [T_ID], { variadic: true, fmtFamily: FMT_FAMILY.NSLOG, fmtArgIdx: 0, category: 'objc' }),

  // --- Objective-C Runtime ---
  fn('objc_msgSend', T_ID, [T_ID, T_SEL], { variadic: true, category: 'objc' }),
  fn('objc_msgSendSuper2', T_ID, [T_OBJC_SUPER_PTR, T_SEL], { variadic: true, category: 'objc' }),
  fn('objc_retain', T_ID, [T_ID], { category: 'objc' }),
  fn('objc_release', T_VOID, [T_ID], { free: true, category: 'objc' }),
  fn('objc_autorelease', T_ID, [T_ID], { category: 'objc' }),
  fn('objc_autoreleaseReturnValue', T_ID, [T_ID], { category: 'objc' }),
  fn('objc_retainAutoreleasedReturnValue', T_ID, [T_ID], { category: 'objc' }),
  fn('objc_retainAutoreleaseReturnValue', T_ID, [T_ID], { category: 'objc' }),
  fn('objc_claimAutoreleasedReturnValue', T_ID, [T_ID], { category: 'objc' }),
  fn('objc_storeStrong', T_VOID, [T_IDPTR, T_ID], { category: 'objc' }),
  fn('objc_storeWeak', T_ID, [T_IDPTR, T_ID], { category: 'objc' }),
  fn('objc_loadWeakRetained', T_ID, [T_IDPTR], { category: 'objc' }),
  fn('objc_destroyWeak', T_VOID, [T_IDPTR], { category: 'objc' }),
  fn('objc_copyWeak', T_VOID, [T_IDPTR, T_IDPTR], { category: 'objc' }),
  fn('objc_initWeak', T_ID, [T_IDPTR, T_ID], { category: 'objc' }),
  fn('objc_alloc', T_ID, [T_CLASS], { alloc: true, category: 'objc' }),
  fn('objc_alloc_init', T_ID, [T_CLASS], { alloc: true, category: 'objc' }),
  fn('objc_allocWithZone', T_ID, [T_CLASS], { alloc: true, category: 'objc' }),
  fn('objc_opt_new', T_ID, [T_CLASS], { alloc: true, category: 'objc' }),
  fn('objc_opt_class', T_CLASS, [T_ID], { category: 'objc' }),
  fn('objc_opt_isKindOfClass', T_BOOL, [T_ID, T_CLASS], { category: 'objc' }),
  fn('objc_opt_respondsToSelector', T_BOOL, [T_ID, T_SEL], { category: 'objc' }),
  fn('objc_autoreleasePoolPush', T_VPTR, [], { category: 'objc' }),
  fn('objc_autoreleasePoolPop', T_VOID, [T_VPTR], { category: 'objc' }),
  fn('objc_getClass', T_CLASS, [T_CSTR], { category: 'objc' }),
  fn('objc_lookUpClass', T_CLASS, [T_CSTR], { category: 'objc' }),
  fn('object_getClass', T_CLASS, [T_ID], { category: 'objc' }),
  fn('class_getName', T_CSTR, [T_CLASS], { category: 'objc' }),
  fn('class_getSuperclass', T_CLASS, [T_CLASS], { category: 'objc' }),
  fn('class_getInstanceMethod', T_METHOD, [T_CLASS, T_SEL], { category: 'objc' }),
  fn('class_getClassMethod', T_METHOD, [T_CLASS, T_SEL], { category: 'objc' }),
  fn('class_getInstanceVariable', T_IVAR, [T_CLASS, T_CSTR], { category: 'objc' }),
  fn('method_getImplementation', T_FN_PTR, [T_METHOD], { category: 'objc' }),
  fn('sel_registerName', T_SEL, [T_CSTR], { category: 'objc' }),
  fn('sel_getName', T_CSTR, [T_SEL], { category: 'objc' }),
  fn('objc_exception_throw', T_VOID, [T_ID], { noreturn: true, category: 'objc' }),
  fn('objc_sync_enter', T_I32, [T_ID], { category: 'objc' }),
  fn('objc_sync_exit', T_I32, [T_ID], { category: 'objc' }),

  // --- C++ Itanium ABI ---
  fn('_Znwm', T_VPTR, [T_SIZE], { alloc: true, category: 'cxxabi' }),
  fn('_Znam', T_VPTR, [T_SIZE], { alloc: true, category: 'cxxabi' }),
  fn('_ZdlPv', T_VOID, [T_VPTR], { free: true, category: 'cxxabi' }),
  fn('_ZdaPv', T_VOID, [T_VPTR], { free: true, category: 'cxxabi' }),
  fn('_ZdlPvm', T_VOID, [T_VPTR, T_SIZE], { free: true, category: 'cxxabi' }),
  fn('_ZdaPvm', T_VOID, [T_VPTR, T_SIZE], { free: true, category: 'cxxabi' }),
  fn('__cxa_allocate_exception', T_VPTR, [T_SIZE], { alloc: true, category: 'cxxabi' }),
  fn('__cxa_free_exception', T_VOID, [T_VPTR], { free: true, category: 'cxxabi' }),
  fn('__cxa_throw', T_VOID, [T_VPTR, T_TYPEINFO_CPTR, T_FN_PTR], { noreturn: true, category: 'cxxabi' }),
  fn('__cxa_rethrow', T_VOID, [], { noreturn: true, category: 'cxxabi' }),
  fn('__cxa_begin_catch', T_VPTR, [T_VPTR], { category: 'cxxabi' }),
  fn('__cxa_end_catch', T_VOID, [], { category: 'cxxabi' }),
  fn('__cxa_guard_acquire', T_I32, [T_I64PTR], { category: 'cxxabi' }),
  fn('__cxa_guard_release', T_VOID, [T_I64PTR], { category: 'cxxabi' }),
  fn('__cxa_guard_abort', T_VOID, [T_I64PTR], { category: 'cxxabi' }),
  fn('__cxa_atexit', T_I32, [T_FN_PTR, T_VPTR, T_VPTR], { category: 'cxxabi' }),
  fn('__cxa_pure_virtual', T_VOID, [], { noreturn: true, category: 'cxxabi' }),
  fn('__dynamic_cast', T_VPTR, [T_CVPTR, T_TYPEINFO_CPTR, T_TYPEINFO_CPTR, T_I64], { category: 'cxxabi' }),
  fn('__cxa_demangle', T_STR, [T_CSTR, T_STR, hexPtr(CORE_TID.SIZE_T), T_I32PTR], { alloc: true, category: 'cxxabi' }),

  // --- Unity IL2CPP Runtime ---
  fn('il2cpp_init', T_I32, [T_CSTR], { category: 'il2cpp' }),
  fn('il2cpp_shutdown', T_VOID, [], { category: 'il2cpp' }),
  fn('il2cpp_domain_get', T_IL2_DOM, [], { category: 'il2cpp' }),
  fn('il2cpp_domain_get_assemblies', T_IL2_ASM_PPTR, [T_IL2_DOM, hexPtr(CORE_TID.SIZE_T)], { category: 'il2cpp' }),
  fn('il2cpp_assembly_get_image', T_IL2_IMG, [T_IL2_ASM], { category: 'il2cpp' }),
  fn('il2cpp_image_get_name', T_CSTR, [T_IL2_IMG], { category: 'il2cpp' }),
  fn('il2cpp_image_get_class_count', T_SIZE, [T_IL2_IMG], { category: 'il2cpp' }),
  fn('il2cpp_image_get_class', T_IL2_CLASS, [T_IL2_IMG, T_SIZE], { category: 'il2cpp' }),
  fn('il2cpp_class_from_name', T_IL2_CLASS, [T_IL2_IMG, T_CSTR, T_CSTR], { category: 'il2cpp' }),
  fn('il2cpp_class_get_name', T_CSTR, [T_IL2_CLASS], { category: 'il2cpp' }),
  fn('il2cpp_class_get_namespace', T_CSTR, [T_IL2_CLASS], { category: 'il2cpp' }),
  fn('il2cpp_class_get_parent', T_IL2_CLASS, [T_IL2_CLASS], { category: 'il2cpp' }),
  fn('il2cpp_class_get_method_from_name', T_IL2_METHOD, [T_IL2_CLASS, T_CSTR, T_I32], { category: 'il2cpp' }),
  fn('il2cpp_class_get_field_from_name', T_IL2_FIELD, [T_IL2_CLASS, T_CSTR], { category: 'il2cpp' }),
  fn('il2cpp_class_get_property_from_name', T_IL2_PROP, [T_IL2_CLASS, T_CSTR], { category: 'il2cpp' }),
  fn('il2cpp_class_get_type', T_IL2_TYPE, [T_IL2_CLASS], { category: 'il2cpp' }),
  fn('il2cpp_object_new', T_IL2_OBJ, [T_IL2_CLASS], { alloc: true, category: 'il2cpp' }),
  fn('il2cpp_object_get_class', T_IL2_CLASS, [T_IL2_OBJ], { category: 'il2cpp' }),
  fn('il2cpp_object_unbox', T_VPTR, [T_IL2_OBJ], { category: 'il2cpp' }),
  fn('il2cpp_value_box', T_IL2_OBJ, [T_IL2_CLASS, T_VPTR], { alloc: true, category: 'il2cpp' }),
  fn('il2cpp_string_new', T_IL2_STR, [T_CSTR], { alloc: true, category: 'il2cpp' }),
  fn('il2cpp_string_new_len', T_IL2_STR, [T_CSTR, T_U32], { alloc: true, category: 'il2cpp' }),
  fn('il2cpp_string_new_utf16', T_IL2_STR, [T_CU16PTR, T_I32], { alloc: true, category: 'il2cpp' }),
  fn('il2cpp_string_chars', T_U16PTR, [T_IL2_STR], { category: 'il2cpp' }),
  fn('il2cpp_string_length', T_I32, [T_IL2_STR], { category: 'il2cpp' }),
  fn('il2cpp_array_new', T_IL2_ARR, [T_IL2_CLASS, T_U64], { alloc: true, category: 'il2cpp' }),
  fn('il2cpp_array_length', T_U32, [T_IL2_ARR], { category: 'il2cpp' }),
  fn('il2cpp_runtime_invoke', T_IL2_OBJ, [T_IL2_METHOD, T_VPTR, T_VPPTR, T_IL2_EXC_PPTR], { category: 'il2cpp' }),
  fn('il2cpp_field_get_value', T_VOID, [T_IL2_OBJ, T_IL2_FIELD, T_VPTR], { category: 'il2cpp' }),
  fn('il2cpp_field_set_value', T_VOID, [T_IL2_OBJ, T_IL2_FIELD, T_VPTR], { category: 'il2cpp' }),
  fn('il2cpp_field_static_get_value', T_VOID, [T_IL2_FIELD, T_VPTR], { category: 'il2cpp' }),
  fn('il2cpp_field_static_set_value', T_VOID, [T_IL2_FIELD, T_VPTR], { category: 'il2cpp' }),
  fn('il2cpp_thread_attach', T_IL2_THREAD, [T_IL2_DOM], { category: 'il2cpp' }),
  fn('il2cpp_thread_detach', T_VOID, [T_IL2_THREAD], { category: 'il2cpp' }),
  fn('il2cpp_resolve_icall', T_FN_PTR, [T_CSTR], { category: 'il2cpp' }),
  fn('il2cpp_raise_exception', T_VOID, [T_IL2_EXC], { noreturn: true, category: 'il2cpp' }),
  fn('il2cpp_gc_collect', T_VOID, [T_I32], { category: 'il2cpp' }),

  // --- CoreFoundation (iOS / macOS) ---
  fn('CFArrayGetCount', T_I64, [T_CFARRAY], { category: 'corefoundation' }),
  fn('CFArrayGetValueAtIndex', T_CVPTR, [T_CFARRAY, T_I64], { category: 'corefoundation' }),
  fn('CFArrayCreate', T_CFARRAY, [T_CFALLOC, T_VPPTR, T_I64, T_CVPTR], { alloc: true, category: 'corefoundation' }),
  fn('CFDictionaryGetValue', T_CVPTR, [T_CFDICT, T_CVPTR], { category: 'corefoundation' }),
  fn('CFDictionaryCreate', T_CFDICT, [T_CFALLOC, T_VPPTR, T_VPPTR, T_I64, T_CVPTR, T_CVPTR], { alloc: true, category: 'corefoundation' }),
  fn('CFDataGetBytePtr', T_CU8PTR, [T_CFDATA], { category: 'corefoundation' }),
  fn('CFDataGetLength', T_I64, [T_CFDATA], { category: 'corefoundation' }),
  fn('CFDataCreate', T_CFDATA, [T_CFALLOC, T_CU8PTR, T_I64], { alloc: true, category: 'corefoundation' }),
  fn('CFStringGetLength', T_I64, [T_CFSTRING], { category: 'corefoundation' }),
  fn('CFStringGetCString', T_BOOL, [T_CFSTRING, T_STR, T_I64, T_U32], { category: 'corefoundation' }),
  fn('CFStringCreateWithBytes', T_CFSTRING, [T_CFALLOC, T_CU8PTR, T_I64, T_U32, T_BOOL], { alloc: true, category: 'corefoundation' }),
  fn('CFNumberGetValue', T_BOOL, [T_CFNUMBER, T_I64, T_VPTR], { category: 'corefoundation' }),
  fn('CFNumberCreate', T_CFNUMBER, [T_CFALLOC, T_I64, T_CVPTR], { alloc: true, category: 'corefoundation' }),
  fn('CFURLCreateWithString', T_CFURL, [T_CFALLOC, T_CFSTRING, T_CFURL], { alloc: true, category: 'corefoundation' }),
  fn('CFBundleGetMainBundle', T_CFBUNDLE, [], { category: 'corefoundation' }),
  fn('CFBundleGetInfoDictionary', T_CFDICT, [T_CFBUNDLE], { category: 'corefoundation' }),
  fn('CFPreferencesCopyAppValue', T_CVPTR, [T_CFSTRING, T_CFSTRING], { alloc: true, category: 'corefoundation' }),
  fn('CFRunLoopGetMain', T_CFRUNLOOP, [], { category: 'corefoundation' }),
  fn('CFRunLoopGetCurrent', T_CFRUNLOOP, [], { category: 'corefoundation' }),
  fn('CFUUIDCreate', T_CFUUID, [T_CFALLOC], { alloc: true, category: 'corefoundation' }),
  fn('CFUUIDCreateString', T_CFSTRING, [T_CFALLOC, T_CFUUID], { alloc: true, category: 'corefoundation' }),

  // --- Dispatch (GCD) extensions ---
  fn('dispatch_group_notify', T_VOID, [T_DISPATCH_GROUP, T_DISPATCH_QUEUE, T_ID], { category: 'darwin' }),
  fn('dispatch_group_wait', T_I64, [T_DISPATCH_GROUP, T_DISPATCH_TIME], { category: 'darwin' }),
  fn('dispatch_time', T_DISPATCH_TIME, [T_DISPATCH_TIME, T_I64], { category: 'darwin' }),
  fn('dispatch_barrier_async', T_VOID, [T_DISPATCH_QUEUE, T_ID], { category: 'darwin' }),
  fn('dispatch_async_f', T_VOID, [T_DISPATCH_QUEUE, T_VPTR, T_FN_PTR], { category: 'darwin' }),
  fn('dispatch_once_f', T_VOID, [T_I64PTR, T_VPTR, T_FN_PTR], { category: 'darwin' }),

  // --- ObjC Runtime extensions ---
  fn('objc_moveWeak', T_VOID, [T_IDPTR, T_IDPTR], { category: 'objc' }),
  fn('objc_allocateClassPair', T_CLASS, [T_CLASS, T_CSTR, T_SIZE], { alloc: true, category: 'objc' }),
  fn('objc_registerClassPair', T_VOID, [T_CLASS], { category: 'objc' }),
  fn('objc_getProtocol', T_PROTOCOL, [T_CSTR], { category: 'objc' }),
  fn('objc_setAssociatedObject', T_VOID, [T_ID, T_CVPTR, T_ID, T_UINTPTR], { category: 'objc' }),
  fn('objc_getAssociatedObject', T_ID, [T_ID, T_CVPTR], { category: 'objc' }),
  fn('class_addMethod', T_BOOL, [T_CLASS, T_SEL, T_FN_PTR, T_CSTR], { category: 'objc' }),
  fn('class_replaceMethod', T_FN_PTR, [T_CLASS, T_SEL, T_FN_PTR, T_CSTR], { category: 'objc' }),
  fn('method_exchangeImplementations', T_VOID, [T_METHOD, T_METHOD], { category: 'objc' }),
  fn('objc_retainAutorelease', T_ID, [T_ID], { category: 'objc' }),
  fn('objc_unsafeClaimAutoreleasedReturnValue', T_ID, [T_ID], { category: 'objc' }),
  fn('objc_enumerationMutation', T_VOID, [T_ID], { category: 'objc' }),

  // --- Swift Runtime ---
  fn('swift_allocObject', T_SWIFT_OBJ, [T_SWIFT_META_CPTR, T_SIZE, T_SIZE], { alloc: true, category: 'swift' }),
  fn('swift_deallocObject', T_VOID, [T_SWIFT_OBJ, T_SIZE, T_SIZE], { free: true, category: 'swift' }),
  fn('swift_retain', T_SWIFT_OBJ, [T_SWIFT_OBJ], { category: 'swift' }),
  fn('swift_release', T_VOID, [T_SWIFT_OBJ], { free: true, category: 'swift' }),
  fn('swift_bridgeObjectRetain', T_VPTR, [T_VPTR], { category: 'swift' }),
  fn('swift_bridgeObjectRelease', T_VOID, [T_VPTR], { free: true, category: 'swift' }),
  fn('swift_unknownObjectRetain', T_VPTR, [T_VPTR], { category: 'swift' }),
  fn('swift_unknownObjectRelease', T_VOID, [T_VPTR], { free: true, category: 'swift' }),
  fn('swift_beginAccess', T_VOID, [T_VPTR, T_VPTR, T_UINTPTR, T_VPTR], { category: 'swift' }),
  fn('swift_endAccess', T_VOID, [T_VPTR], { category: 'swift' }),
  fn('swift_once', T_VOID, [T_I64PTR, T_FN_PTR, T_VPTR], { category: 'swift' }),
  fn('swift_dynamicCast', T_BOOL, [T_VPTR, T_VPTR, T_SWIFT_META_CPTR, T_SWIFT_META_CPTR, T_SIZE], { category: 'swift' }),
  fn('swift_getWitnessTable', T_CVPTR, [T_CVPTR, T_SWIFT_META_CPTR, T_VPPTR], { category: 'swift' }),
  fn('swift_getGenericMetadata', T_SWIFT_META_CPTR, [T_SIZE, T_CVPTR, T_CVPTR], { category: 'swift' }),
  fn('swift_getTypeByMangledNameInContext', T_SWIFT_META_CPTR, [T_CSTR, T_SIZE, T_CVPTR, T_CVPTR], { category: 'swift' }),
  fn('swift_errorRetain', T_VPTR, [T_VPTR], { category: 'swift' }),
  fn('swift_errorRelease', T_VOID, [T_VPTR], { free: true, category: 'swift' }),
  fn('swift_willThrow', T_VOID, [T_VPTR], { category: 'swift' }),
  fn('swift_slowAlloc', T_VPTR, [T_SIZE, T_SIZE], { alloc: true, category: 'swift' }),
  fn('swift_slowDealloc', T_VOID, [T_VPTR, T_SIZE, T_SIZE], { free: true, category: 'swift' }),
  fn('swift_isUniquelyReferenced_nonNull_native', T_BOOL, [T_SWIFT_OBJ], { category: 'swift' }),

  // --- UIKit / CoreGraphics / Security / CommonCrypto / Darwin ---
  fn('UIApplicationMain', T_I32, [T_I32, T_STRPTR, T_ID, T_ID], { category: 'uikit' }),
  fn('UIGraphicsBeginImageContextWithOptions', T_VOID, [T_CGSIZE, T_BOOL, T_CGFLOAT], { category: 'uikit' }),
  fn('UIGraphicsEndImageContext', T_VOID, [], { category: 'uikit' }),
  fn('UIGraphicsGetCurrentContext', T_CGCONTEXT, [], { category: 'uikit' }),
  fn('CGContextDrawImage', T_VOID, [T_CGCONTEXT, T_CGRECT, T_CGIMAGE], { category: 'coregraphics' }),
  fn('CGContextFillRect', T_VOID, [T_CGCONTEXT, T_CGRECT], { category: 'coregraphics' }),
  fn('CGImageGetWidth', T_SIZE, [T_CGIMAGE], { category: 'coregraphics' }),
  fn('CGImageGetHeight', T_SIZE, [T_CGIMAGE], { category: 'coregraphics' }),
  fn('CGImageRelease', T_VOID, [T_CGIMAGE], { free: true, category: 'coregraphics' }),
  fn('CGColorSpaceCreateDeviceRGB', T_CGCOLORSPACE, [], { alloc: true, category: 'coregraphics' }),
  fn('SecItemCopyMatching', T_OSSTATUS, [T_CFDICT, T_VPPTR], { category: 'security' }),
  fn('SecItemAdd', T_OSSTATUS, [T_CFDICT, T_VPPTR], { category: 'security' }),
  fn('SecItemUpdate', T_OSSTATUS, [T_CFDICT, T_CFDICT], { category: 'security' }),
  fn('SecItemDelete', T_OSSTATUS, [T_CFDICT], { category: 'security' }),
  fn('SecRandomCopyBytes', T_I32, [T_CVPTR, T_SIZE, T_VPTR], { category: 'security' }),
  fn('CC_SHA256', T_U8PTR, [T_CVPTR, T_U32, T_U8PTR], { category: 'security' }),
  fn('CC_SHA1', T_U8PTR, [T_CVPTR, T_U32, T_U8PTR], { category: 'security' }),
  fn('CC_MD5', T_U8PTR, [T_CVPTR, T_U32, T_U8PTR], { category: 'security' }),
  fn('CCCrypt', T_I32, [T_U32, T_U32, T_U32, T_CVPTR, T_SIZE, T_CVPTR, T_CVPTR, T_SIZE, T_VPTR, T_SIZE, T_SIZE_PTR], { category: 'security' }),
  fn('mach_timebase_info', T_KERN_RET, [T_MACH_TIMEBASE_PTR], { category: 'darwin' }),
]);

// ---------------------------------------------------------------------------
// Core ObjC Selector Signatures (Sel Index)
// ---------------------------------------------------------------------------
export const CORE_TIL_SELECTORS = Object.freeze([
  fn('+NSObject:alloc', T_ID, [T_CLASS, T_SEL], { alloc: true, objcClassMethod: true, category: 'objc' }),
  fn('+NSObject:new', T_ID, [T_CLASS, T_SEL], { alloc: true, objcClassMethod: true, category: 'objc' }),
  fn('-NSObject:init', T_ID, [T_ID, T_SEL], { category: 'objc' }),
  fn('-NSObject:retain', T_ID, [T_ID, T_SEL], { category: 'objc' }),
  fn('-NSObject:release', T_VOID, [T_ID, T_SEL], { free: true, category: 'objc' }),
  fn('-NSObject:autorelease', T_ID, [T_ID, T_SEL], { category: 'objc' }),
  fn('-NSObject:description', T_ID, [T_ID, T_SEL], { category: 'objc' }),
  fn('-NSObject:isEqual:', T_BOOL, [T_ID, T_SEL, T_ID], { category: 'objc' }),
  fn('-NSObject:hash', T_NSUINT, [T_ID, T_SEL], { category: 'objc' }),
  fn('*:alloc', T_ID, [T_CLASS, T_SEL], { alloc: true, objcClassMethod: true, category: 'objc' }),
  fn('*:init', T_ID, [T_ID, T_SEL], { category: 'objc' }),
  fn('*:count', T_NSUINT, [T_ID, T_SEL], { category: 'objc' }),
  fn('*:length', T_NSUINT, [T_ID, T_SEL], { category: 'objc' }),
  fn('*:UTF8String', T_CSTR, [T_ID, T_SEL], { category: 'objc' }),
  fn('+NSString:stringWithUTF8String:', T_ID, [T_CLASS, T_SEL, T_CSTR], { alloc: true, objcClassMethod: true, category: 'objc' }),
  fn('+NSString:stringWithFormat:', T_ID, [T_CLASS, T_SEL, T_ID], { alloc: true, variadic: true, fmtFamily: FMT_FAMILY.NSLOG, fmtArgIdx: 2, objcClassMethod: true, category: 'objc' }),
  fn('-NSString:isEqualToString:', T_BOOL, [T_ID, T_SEL, T_ID], { category: 'objc' }),
  fn('-NSArray:objectAtIndex:', T_ID, [T_ID, T_SEL, T_NSUINT], { category: 'objc' }),
  fn('+NSArray:arrayWithObjects:count:', T_ID, [T_CLASS, T_SEL, T_IDPTR, T_NSUINT], { alloc: true, objcClassMethod: true, category: 'objc' }),
  fn('-NSDictionary:objectForKey:', T_ID, [T_ID, T_SEL, T_ID], { category: 'objc' }),
  fn('-NSMutableDictionary:setObject:forKey:', T_VOID, [T_ID, T_SEL, T_ID, T_ID], { category: 'objc' }),
  fn('+NSData:dataWithBytes:length:', T_ID, [T_CLASS, T_SEL, T_CVPTR, T_NSUINT], { alloc: true, objcClassMethod: true, category: 'objc' }),
  fn('-NSData:bytes', T_CVPTR, [T_ID, T_SEL], { category: 'objc' }),
  fn('-UIView:initWithFrame:', T_ID, [T_ID, T_SEL, T_CGRECT], { category: 'uikit' }),
  fn('*:initWithFrame:', T_ID, [T_ID, T_SEL, T_CGRECT], { category: 'uikit' }),
  fn('-UIViewController:viewDidLoad', T_VOID, [T_ID, T_SEL], { category: 'uikit' }),
  fn('*:viewDidLoad', T_VOID, [T_ID, T_SEL], { category: 'uikit' }),
  fn('*:objectForKey:', T_ID, [T_ID, T_SEL, T_ID], { category: 'objc' }),
  fn('*:setObject:forKey:', T_VOID, [T_ID, T_SEL, T_ID, T_ID], { category: 'objc' }),
  fn('*:stringWithFormat:', T_ID, [T_CLASS, T_SEL, T_ID], { alloc: true, variadic: true, fmtFamily: FMT_FAMILY.NSLOG, fmtArgIdx: 2, objcClassMethod: true, category: 'objc' }),
  fn('*:dataWithBytes:length:', T_ID, [T_CLASS, T_SEL, T_CVPTR, T_NSUINT], { alloc: true, objcClassMethod: true, category: 'objc' }),
  fn('*:bytes', T_CVPTR, [T_ID, T_SEL], { category: 'objc' }),
  fn('*:objectAtIndex:', T_ID, [T_ID, T_SEL, T_NSUINT], { category: 'objc' }),
  fn('-NSMutableArray:addObject:', T_VOID, [T_ID, T_SEL, T_ID], { category: 'objc' }),
  fn('*:addObject:', T_VOID, [T_ID, T_SEL, T_ID], { category: 'objc' }),
  fn('+UIApplication:sharedApplication', T_ID, [T_CLASS, T_SEL], { objcClassMethod: true, category: 'uikit' }),
  fn('*:sharedApplication', T_ID, [T_CLASS, T_SEL], { objcClassMethod: true, category: 'uikit' }),
  fn('+NSNotificationCenter:defaultCenter', T_ID, [T_CLASS, T_SEL], { objcClassMethod: true, category: 'objc' }),
  fn('*:defaultCenter', T_ID, [T_CLASS, T_SEL], { objcClassMethod: true, category: 'objc' }),
  fn('-NSNotificationCenter:addObserver:selector:name:object:', T_VOID, [T_ID, T_SEL, T_ID, T_SEL, T_ID, T_ID], { category: 'objc' }),
  fn('*:addObserver:selector:name:object:', T_VOID, [T_ID, T_SEL, T_ID, T_SEL, T_ID, T_ID], { category: 'objc' }),
  fn('-NSNotificationCenter:postNotificationName:object:', T_VOID, [T_ID, T_SEL, T_ID, T_ID], { category: 'objc' }),
  fn('*:postNotificationName:object:', T_VOID, [T_ID, T_SEL, T_ID, T_ID], { category: 'objc' }),
  fn('+NSUserDefaults:standardUserDefaults', T_ID, [T_CLASS, T_SEL], { objcClassMethod: true, category: 'objc' }),
  fn('*:standardUserDefaults', T_ID, [T_CLASS, T_SEL], { objcClassMethod: true, category: 'objc' }),
  fn('+NSURL:URLWithString:', T_ID, [T_CLASS, T_SEL, T_ID], { alloc: true, objcClassMethod: true, category: 'objc' }),
  fn('*:URLWithString:', T_ID, [T_CLASS, T_SEL, T_ID], { alloc: true, objcClassMethod: true, category: 'objc' }),
  fn('*:isEqualToString:', T_BOOL, [T_ID, T_SEL, T_ID], { category: 'objc' }),
  fn('-NSObject:copy', T_ID, [T_ID, T_SEL], { alloc: true, category: 'objc' }),
  fn('*:copy', T_ID, [T_ID, T_SEL], { alloc: true, category: 'objc' }),
  fn('-NSObject:mutableCopy', T_ID, [T_ID, T_SEL], { alloc: true, category: 'objc' }),
  fn('*:mutableCopy', T_ID, [T_ID, T_SEL], { alloc: true, category: 'objc' }),
  fn('*:description', T_ID, [T_ID, T_SEL], { category: 'objc' }),
]);

/**
 * Returns the complete Tier-0 Core TIL IR object ready for TIL1 compilation or direct resolution.
 */
export function getCoreTilIr() {
  return {
    packId: 'core-til-lite',
    version: '1.0.0',
    isCore: true,
    localTidRelative: false,
    abiMask: 0x01,
    types: CORE_TIL_TYPES,
    functions: CORE_TIL_FUNCTIONS,
    selectors: CORE_TIL_SELECTORS,
    enums: CORE_TIL_ENUMS,
    structLayouts: CORE_TIL_STRUCT_LAYOUTS,
  };
}

/**
 * Formats a 32-bit HexTypeId into a readable C-like type string using an optional type resolver.
 */
export function formatHexTypeId(hexTypeId, lookupTypeName = null) {
  if (hexTypeIsNone(hexTypeId)) return 'unknown';
  const { baseTilId, ptrDepth, isConst, kindTag } = unpackHexTypeId(hexTypeId);
  let baseName = TIL_PRIM_NAMES[baseTilId];
  if (!baseName && lookupTypeName) {
    baseName = lookupTypeName(baseTilId);
  }
  if (!baseName) {
    const core = CORE_TIL_TYPES.find((t) => t.tid === baseTilId);
    baseName = core ? core.name : `til_0x${baseTilId.toString(16)}`;
  }
  if (baseName === 'int8_t' && ptrDepth >= 1) {
    baseName = 'char';
  }
  const prefix = isConst ? 'const ' : '';
  if (kindTag === HEX_KIND.FUNC_PTR && ptrDepth >= 1) {
    return `${prefix}void (*)(...)`;
  }
  const stars = ptrDepth > 0 ? '*'.repeat(ptrDepth) : '';
  return `${prefix}${baseName}${stars}`;
}
