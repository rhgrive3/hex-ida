export const CLI_HEADER_SIZE = 72;

export function validateCliHeaderSize(cb, directorySize) {
  if (!Number.isSafeInteger(cb) || !Number.isSafeInteger(directorySize)
    || cb < CLI_HEADER_SIZE || cb > directorySize) {
    throw new TypeError('cil-invalid-cli-header-size');
  }
  return cb;
}
