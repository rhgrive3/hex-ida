// field_info.access_flags validation; the parser supplies the owner context.

const ACC_PUBLIC = 0x0001;
const ACC_PRIVATE = 0x0002;
const ACC_PROTECTED = 0x0004;
const ACC_STATIC = 0x0008;
const ACC_FINAL = 0x0010;
const ACC_VOLATILE = 0x0040;
const ACC_TRANSIENT = 0x0080;
const ACC_INTERFACE = 0x0200;
const ACC_ENUM = 0x4000;
const JAVA_5_MAJOR = 49;

const VISIBILITY = ACC_PUBLIC | ACC_PRIVATE | ACC_PROTECTED;
const INTERFACE_REQUIRED = ACC_PUBLIC | ACC_STATIC | ACC_FINAL;
const INTERFACE_FORBIDDEN = ACC_PRIVATE | ACC_PROTECTED | ACC_VOLATILE | ACC_TRANSIENT;

function hasSingleVisibility(flags) {
  const visibility = flags & VISIBILITY;
  return visibility === 0 || visibility === ACC_PUBLIC || visibility === ACC_PRIVATE || visibility === ACC_PROTECTED;
}

/**
 * Validate the JVMS §4.5 context-sensitive field flag grammar.
 *
 * Unlike the §4.6 method rules, the core field constraints here hold across
 * every class-file version this parser accepts. ACC_ENUM is assigned starting
 * with Java 5 (class-file major 49); when version metadata is absent, retain
 * the modern rejection conservatively. Other unknown flag bits remain
 * reserved and are intentionally ignored by the JVM.
 */
export function validateJvmFieldFlags(flags, {
  ownerAccessFlags = null,
  majorVersion = null,
} = {}) {
  const errors = [];

  if (!Number.isSafeInteger(flags) || flags < 0 || flags > 0xffff) {
    return { errors: ['jvm-field-access-flags-invalid'] };
  }

  const isInterface = Number.isSafeInteger(ownerAccessFlags) && (ownerAccessFlags & ACC_INTERFACE) !== 0;
  const knownMajor = Number.isSafeInteger(majorVersion) && majorVersion >= 0 ? majorVersion : null;
  const enumIsAssigned = knownMajor === null || knownMajor >= JAVA_5_MAJOR;

  if (!hasSingleVisibility(flags)) errors.push('jvm-field-visibility-conflict');

  // JVMS §4.5: a field is never both final and volatile. Interface fields are
  // always public static final and never private/protected/volatile/transient.
  if ((flags & ACC_FINAL) !== 0 && (flags & ACC_VOLATILE) !== 0) errors.push('jvm-field-final-volatile-conflict');

  if (isInterface) {
    if ((flags & INTERFACE_REQUIRED) !== INTERFACE_REQUIRED) errors.push('jvm-interface-field-version-flags');
    if ((flags & INTERFACE_FORBIDDEN) !== 0 || (enumIsAssigned && (flags & ACC_ENUM) !== 0)) {
      errors.push('jvm-interface-field-flag-conflict');
    }
  }

  return { errors };
}
