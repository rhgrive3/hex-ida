// Compiler-truth components historically inherited this from run.mjs because
// they were imported into one process. Local parallel mode executes them in
// isolated child processes, so preserve the exact BigInt diagnostic contract.
if (typeof BigInt.prototype.toJSON !== 'function') {
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value() { return this.toString(); },
    configurable: true,
  });
}
