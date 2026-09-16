import test from 'node:test';
import { execFileSync } from 'node:child_process';
test('actual Worker auth routes precede generic API/ASSETS; encoded/raw private aliases do not bypass', () => {
  execFileSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', new URL('./worker-entry-harness.mjs', import.meta.url).pathname], { timeout: 15000, stdio: 'pipe', maxBuffer: 256 * 1024 });
});
