// Compatibility entry point for the retired 1.0.<source epoch> version check.
// Content-bound release identity and monotonic 2.0 serials are now canonical;
// keep one regression contract instead of requiring both incompatible schemes.
await import('./userscript-release-version.mjs');
