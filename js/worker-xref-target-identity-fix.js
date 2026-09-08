'use strict';

/*
 * Follow-up hardening for #5872. The canonical parser installed by
 * worker-fixes.js intentionally accepts only primitive address identities, but
 * JavaScript has one primitive spelling that collapses during normalization:
 * -0 (number) and '-0' (string) both become the canonical address 0. Treat
 * those non-canonical identities as malformed before any xref scanner can
 * consume them. Later worker override layers reuse this global binding.
 */
const __canonicalAddressBeforeNegativeZeroGuard = canonicalAddress;
canonicalAddress = function canonicalAddressWithoutNegativeZero(value) {
  if ((typeof value === 'number' && Object.is(value, -0)) ||
      (typeof value === 'string' && value === '-0')) {
    throw new Error('Invalid xref target.');
  }
  return __canonicalAddressBeforeNegativeZeroGuard(value);
};
