export function cilStackValueWidth(value) {
  const bits = value?.bits;
  return typeof bits === 'number' && Number.isSafeInteger(bits) && bits > 0 ? bits : null;
}
