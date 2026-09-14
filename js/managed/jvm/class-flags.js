// Shared class_header.access_flags validation for the parser.
//
// The parser always supplies the class-file context.  The verifier may also
// be called with a bare flags value, so version-dependent rules stay honest
// about what they cannot prove.

const ACC_PUBLIC = 0x0001;
const ACC_FINAL = 0x0010;
const ACC_SUPER = 0x0020;
const ACC_INTERFACE = 0x0200;
const ACC_ABSTRACT = 0x0400;
const ACC_ANNOTATION = 0x2000;
const ACC_MODULE = 0x8000;

function knownMajor(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Validate the JVMS §4.1 class/interface access-flag grammar.
 *
 * `errors` contain hard format violations. `unsupported` contains evidence
 * that cannot be proven without more context. Reserved bits are intentionally
 * ignored: the JVM itself permits unspecified bits in class access_flags.
 */
export function validateJvmClassFlags(flags, {
  majorVersion = null,
} = {}) {
  const errors = [];
  const unsupported = [];
  const major = knownMajor(majorVersion);

  if (!Number.isSafeInteger(flags) || flags < 0 || flags > 0xffff) {
    return { errors: ['jvm-class-access-flags-invalid'], unsupported };
  }

  const isInterface = (flags & ACC_INTERFACE) !== 0;
  const isAbstract = (flags & ACC_ABSTRACT) !== 0;
  const isModule = (flags & ACC_MODULE) !== 0;
  const isAnnotation = (flags & ACC_ANNOTATION) !== 0;

  // JVMS §4.1: a class may not be both final and abstract. This holds for
  // every class-file version this parser accepts.
  if ((flags & ACC_FINAL) !== 0 && isAbstract) errors.push('jvm-class-final-abstract-conflict');

  // §4.1: since class-file version 52 (Java SE 7) ACC_SUPER is forbidden on
  // interface flags. Older interface versions did use it, so a missing or
  // pre-52 version cannot prove the rule either way.
  if (isInterface && (flags & ACC_SUPER) !== 0) {
    if (major == null) unsupported.push('jvm-interface-super-version-metadata-missing');
    else if (major >= 52) errors.push('jvm-interface-super-flag-conflict');
  }

  // §4.1: ACC_ANNOTATION requires ACC_INTERFACE. On module-info (major 53 +
  // ACC_MODULE) the only flags are ACC_MODULE and ACC_SYNTHETIC/ACC_PUBLIC.
  if (isAnnotation && !isInterface) errors.push('jvm-annotation-requires-interface');

  if (isModule) {
    if (major != null && major < 53) errors.push('jvm-module-flag-version');
    if (isInterface || isAbstract || (flags & ACC_FINAL) !== 0) errors.push('jvm-module-flag-conflict');
  }

  return { errors, unsupported };
}
