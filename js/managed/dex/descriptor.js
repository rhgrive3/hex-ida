import { fail } from './validation-utils.js';

// References occupy one logical DEX register, independently of the host ABI.
// Their descriptor remains attached; this is not a native object-layout claim.
export function dexTypeInfo(descriptor, { allowVoid = false } = {}) {
  if (typeof descriptor !== 'string' || !descriptor) fail('dex-invalid-type-descriptor');
  let depth = 0;
  while (descriptor[depth] === '[') depth++;
  if (depth > 255) fail('dex-invalid-type-descriptor');
  const base = descriptor.slice(depth);
  const object = /^L(?:[^.;\[\]/]+\/)*[^.;\[\]/]+;$/.test(base);
  if (!object && !/^[VZBSCIJFD]$/.test(base)) fail('dex-invalid-type-descriptor');
  if (base === 'V' && (depth || !allowVoid)) fail('dex-invalid-type-descriptor');
  if (object || depth) return { descriptor, category:'object', shorty:'L', bits:32, words:1, byteWidth:4, type:{ kind:'address', widthBits:32, addressSpace:'managed-heap' } };
  if (base === 'V') return { descriptor, category:'void', shorty:'V', bits:0, words:0 };
  const bits = base === 'J' || base === 'D' ? 64 : 32;
  const byteWidth = base === 'Z' || base === 'B' ? 1 : base === 'S' || base === 'C' ? 2 : bits / 8;
  const type = base === 'F' || base === 'D'
    ? { kind:'float', widthBits:bits, format:bits === 64 ? 'binary64' : 'binary32' }
    : { kind:'bitvector', widthBits:bits };
  return { descriptor, category:bits === 64 ? 'wide' : 'single', shorty:base, bits, words:bits / 32, byteWidth, type,
    ...(byteWidth < 4 ? { extension:base === 'B' || base === 'S' ? 'sign' : 'zero' } : {}) };
}

export function dexPrototypeShorty(returnType, params) {
  if (!Array.isArray(params)) fail('dex-invalid-proto-parameters');
  return dexTypeInfo(returnType, { allowVoid:true }).shorty + params.map(type => dexTypeInfo(type).shorty).join('');
}
