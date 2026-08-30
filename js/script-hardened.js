import { createApi as createBaseApi } from './script-base.js';

function ownerRegion(app, address) {
  const addr = BigInt(address);
  const direct = app?.executableRegionFor?.(addr);
  if (direct) return direct;
  return (app?.store?.get?.('regions') || []).find((region) => {
    try { return region?.exec === true && addr >= BigInt(region.vmAddr) && addr < BigInt(region.vmAddr) + BigInt(region.size); }
    catch { return false; }
  }) || null;
}

function appForOwner(app, owner) {
  return new Proxy(app, {
    get(target, property, receiver) {
      if (property === 'codeRegion') return () => owner;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function unavailable(address) {
  return { supported:false, reason:'address-not-in-executable-region', address:BigInt(address) };
}

export function createHardenedApi(app, out) {
  const result = createBaseApi(app, out);
  const api = result.api;
  for (const method of ['disasm', 'decompile', 'patch']) {
    const fallback = api[method];
    if (typeof fallback !== 'function') continue;
    api[method] = async (address, ...args) => {
      const owner = ownerRegion(app, address);
      if (!owner) return unavailable(address);
      const scoped = createBaseApi(appForOwner(app, owner), () => {}).api;
      return scoped[method](address, ...args);
    };
  }
  return result;
}
