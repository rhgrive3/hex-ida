'use strict';

/* Preserve the latest main worker implementation byte-for-byte in
 * worker-legacy.js, then override only audited entry points. */
importScripts('./worker-legacy.js');
importScripts('./worker-fixes.js');
importScripts('./worker-xref-memory-fix.js');
importScripts('./worker-kind-fix.js');
importScripts('./worker-function-provenance-fix.js');
/* Install merge-point hardening last so it wraps the current canonical scanners. */
importScripts('./worker-loop-provenance-fix.js');
/* #2117: extend the loop-entry prepass to unconditional direct B back-edges. */
importScripts('./worker-loop-unconditional-fix.js');