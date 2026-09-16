import { verifySource } from './client.js';
export async function loadParentModule(payload) {
  await verifySource(payload.source, payload.hash);
  const url = URL.createObjectURL(new Blob([payload.source], { type: 'text/javascript' }));
  try { return await import(url); } finally { URL.revokeObjectURL(url); }
}
/** Use the existing inherited ChatGPT nonce; no sandbox permissions are added. */
export async function loadChildModule(payload, documentRef = globalThis.document, globalObject = globalThis) {
  await verifySource(payload.source, payload.hash);
  const slot = `__hexExtension_${[...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return new Promise((resolve, reject) => {
    const script = documentRef.createElement('script'); script.type = 'module';
    const existing = documentRef.querySelector('script[nonce]');
    if (existing) script.nonce = existing.nonce || existing.getAttribute('nonce');
    let done = false;
    const finish = (error, module) => {
      if (done) return; done = true; clearTimeout(timer); script.remove();
      try { delete globalObject[slot]; } catch {}
      error ? reject(error) : resolve(module);
    };
    const timer = setTimeout(() => finish(new Error('Privileged extension loading timed out.')), 12000);
    Object.defineProperty(globalObject, slot, { configurable: true, value: (module) => {
      if (typeof module?.installChildExtension !== 'function') finish(new Error('Invalid privileged extension.'));
      else finish(null, module);
    } });
    script.onerror = () => finish(new Error('Privileged extension blocked by browser policy.'));
    script.textContent = `${payload.source}\n;globalThis[${JSON.stringify(slot)}](HexPrivilegedChild);`;
    try { documentRef.head.append(script); } catch { finish(new Error('Privileged extension mount unavailable.')); }
  });
}
