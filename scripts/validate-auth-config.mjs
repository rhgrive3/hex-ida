import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export const LOCAL_D1_ID = '00000000-0000-0000-0000-000000000000';
export function validateAuthConfig(config, { local = false } = {}) {
  const binding = config?.d1_databases?.find((item) => item.binding === 'AUTH_DB');
  if (!binding || binding.database_name !== 'hex-auth' || binding.migrations_dir !== 'migrations/auth') throw new Error('AUTH_DB and migrations/auth must be configured.');
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(binding.database_id || '')) throw new Error('AUTH_DB database_id must be a real D1 UUID.');
  if (!local && binding.database_id === LOCAL_D1_ID) throw new Error('Local-only AUTH_DB sentinel: set the real production D1 ID before deployment.');
  if (config.assets?.run_worker_first !== true) throw new Error('Protected asset routes require assets.run_worker_first=true.');
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const file = process.argv.find((arg) => arg.startsWith('--config='))?.slice(9) || 'wrangler.jsonc';
    const config = JSON.parse((await readFile(file, 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
    validateAuthConfig(config, { local: process.argv.includes('--local') });
    console.log('Auth deployment configuration validated.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
