/*
 * Canonical Worker ownership identity (#8810).
 *
 * runId / workerId / leaseId are authority, not display text. They must stay in
 * a primitive non-empty string token domain: a structured value such as
 * ['run-A'] or { toString() { return 'run-A'; } } must never collapse onto the
 * same owner as the primitive, and validation must not execute a
 * caller-controlled toString()/valueOf(). Display formatting keeps its own
 * String() helpers so an identity policy can never be weakened by them.
 */

export function canonicalWorkerIdentity(value, field = 'Worker identity') {
  const message = `${field} must be a primitive non-empty string.`;
  if (typeof value !== 'string') throw new TypeError(message);
  const text = value.trim();
  if (!text) throw new TypeError(message);
  return text;
}

export function optionalWorkerIdentity(value, field = 'Worker identity') {
  return value == null ? null : canonicalWorkerIdentity(value, field);
}
