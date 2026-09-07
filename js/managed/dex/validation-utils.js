export function fail(code) {
  throw new TypeError(code);
}

export function checkedRange(limit, offset, size, code) {
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(size)
      || limit < 0 || offset < 0 || size < 0 || offset > limit || size > limit - offset) {
    fail(code);
  }
}
