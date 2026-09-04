/** Strict parsing for proof-authority capability and resource limits. */

export function requirePositiveSafeInteger(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a primitive positive safe integer`);
  }
  return value;
}

export function effectivePositiveSafeInteger(options, name, sessionValue, backendCeiling) {
  const candidate = Object.prototype.hasOwnProperty.call(options || {}, name)
    ? options[name]
    : sessionValue;
  return Math.min(
    requirePositiveSafeInteger(candidate, name),
    requirePositiveSafeInteger(backendCeiling, `${name} backend ceiling`),
  );
}
