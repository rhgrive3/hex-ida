// Shared method_info.access_flags validation for the parser and verifier.
//
// The parser always supplies the class-file context.  The verifier may also
// be called directly with incomplete metadata, so version- and owner-dependent
// rules report unsupported evidence instead of guessing.

const ACC_PUBLIC = 0x0001;
const ACC_PRIVATE = 0x0002;
const ACC_PROTECTED = 0x0004;
const ACC_STATIC = 0x0008;
const ACC_FINAL = 0x0010;
const ACC_SYNCHRONIZED = 0x0020;
const ACC_BRIDGE = 0x0040;
const ACC_VARARGS = 0x0080;
const ACC_NATIVE = 0x0100;
const ACC_INTERFACE = 0x0200;
const ACC_ABSTRACT = 0x0400;
const ACC_STRICT = 0x0800;

const VISIBILITY = ACC_PUBLIC | ACC_PRIVATE | ACC_PROTECTED;
const ABSTRACT_FORBIDDEN = ACC_PRIVATE | ACC_STATIC | ACC_FINAL | ACC_SYNCHRONIZED | ACC_NATIVE;
const INTERFACE_FORBIDDEN = ACC_PROTECTED | ACC_FINAL | ACC_SYNCHRONIZED | ACC_NATIVE;
const INIT_FORBIDDEN = ACC_STATIC | ACC_FINAL | ACC_SYNCHRONIZED | ACC_BRIDGE | ACC_NATIVE | ACC_ABSTRACT;

function knownMajor(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function strictAssigned(majorVersion) {
  return majorVersion != null && majorVersion >= 46 && majorVersion <= 60;
}

function hasSingleVisibility(flags) {
  const visibility = flags & VISIBILITY;
  return visibility === 0 || visibility === ACC_PUBLIC || visibility === ACC_PRIVATE || visibility === ACC_PROTECTED;
}

/**
 * Validate the JVMS §4.6 context-sensitive method flag grammar.
 *
 * `errors` contain hard format violations. `unsupported` contains evidence
 * that the verifier cannot prove a version- or owner-dependent rule. Unknown
 * flag bits remain reserved and are intentionally ignored by the JVM.
 */
export function validateJvmMethodFlags(flags, {
  methodName = null,
  ownerAccessFlags = null,
  majorVersion = null,
} = {}) {
  const errors = [];
  const unsupported = [];
  const major = knownMajor(majorVersion);

  if (!Number.isSafeInteger(flags) || flags < 0 || flags > 0xffff) {
    return { errors: ['jvm-method-access-flags-invalid'], unsupported };
  }

  const isInterface = Number.isSafeInteger(ownerAccessFlags) && (ownerAccessFlags & ACC_INTERFACE) !== 0;
  const isStrict = (flags & ACC_STRICT) !== 0;
  const strictIsAssigned = strictAssigned(major);

  // ACC_STRICT is reserved outside class-file versions 46..60.  If the
  // verifier lacks a version, retaining the method as partial is safer than
  // treating the bit as either legal or illegal.
  if (isStrict && major == null) unsupported.push('jvm-method-strict-version-metadata-missing');

  // The JVM ignores all method flags except STATIC and (where assigned)
  // STRICT for class/interface initialization methods.  This exemption must
  // precede visibility and abstract/interface checks.
  if (methodName === '<clinit>') {
    if (major == null) {
      if ((flags & ACC_STATIC) === 0) unsupported.push('jvm-clinit-version-metadata-missing');
    } else if (major >= 51 && (flags & ACC_STATIC) === 0) {
      errors.push('jvm-clinit-static-required');
    }
    return { errors, unsupported };
  }

  if (!hasSingleVisibility(flags)) errors.push('jvm-method-visibility-conflict');

  if (methodName === '<init>') {
    if (isInterface) errors.push('jvm-interface-init-method-forbidden');
    if ((flags & INIT_FORBIDDEN) !== 0) errors.push('jvm-init-flag-conflict');
    // `<init>` is allowed PUBLIC/PRIVATE/PROTECTED, VARARGS, SYNTHETIC, and
    // STRICT only while STRICT is assigned.  Reserved bits stay ignored.
    return { errors, unsupported };
  }

  if (isInterface) {
    if ((flags & INTERFACE_FORBIDDEN) !== 0) errors.push('jvm-interface-method-flag-conflict');
    if (major == null) {
      unsupported.push('jvm-interface-version-metadata-missing');
    } else if (major < 52) {
      if ((flags & (ACC_PUBLIC | ACC_ABSTRACT)) !== (ACC_PUBLIC | ACC_ABSTRACT)) {
        errors.push('jvm-interface-method-version-flags');
      }
    } else {
      const visibility = flags & (ACC_PUBLIC | ACC_PRIVATE);
      if (visibility !== ACC_PUBLIC && visibility !== ACC_PRIVATE) {
        errors.push('jvm-interface-method-version-flags');
      }
    }
  }

  const isAbstract = (flags & ACC_ABSTRACT) !== 0;
  if (isAbstract && (flags & ABSTRACT_FORBIDDEN) !== 0) {
    errors.push('jvm-method-abstract-flag-conflict');
  } else if (isAbstract && isStrict && strictIsAssigned) {
    errors.push('jvm-method-abstract-flag-conflict');
  }

  return { errors, unsupported };
}
