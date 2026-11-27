// Lightweight invocation & fallback telemetry for C++/WASM modules.
const counts = Object.create(null);
const fallbacks = Object.create(null);

export function recordWasmCall(moduleName) {
  counts[moduleName] = (counts[moduleName] || 0) + 1;
}
export function getWasmCallCount(moduleName) {
  return counts[moduleName] || 0;
}
export function getWasmCallCounts() {
  return { ...counts };
}
export function recordFallback(reasonCode) {
  const key = String(reasonCode || 'UNKNOWN');
  fallbacks[key] = (fallbacks[key] || 0) + 1;
}
export function getFallbackCount(reasonCode) {
  return fallbacks[reasonCode] || 0;
}
export function getFallbackCounts() {
  return { ...fallbacks };
}
export function resetAllTelemetry() {
  for (const k of Object.keys(counts)) delete counts[k];
  for (const k of Object.keys(fallbacks)) delete fallbacks[k];
}
export function resetWasmCallCounts() {
  resetAllTelemetry();
}
