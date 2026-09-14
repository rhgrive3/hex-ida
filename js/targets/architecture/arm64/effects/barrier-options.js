function frozenScopes(scopes) {
  return Object.freeze(Object.fromEntries(
    Object.entries(scopes).map(([option, scope]) => [option, Object.freeze(scope)]),
  ));
}

const DATA_BARRIER_SCOPES = frozenScopes({
  sy:{ domain:'full-system', access:'all' },
  st:{ domain:'full-system', access:'stores' },
  ld:{ domain:'full-system', access:'loads' },
  ish:{ domain:'inner-shareable', access:'all' },
  ishst:{ domain:'inner-shareable', access:'stores' },
  ishld:{ domain:'inner-shareable', access:'loads' },
  nsh:{ domain:'non-shareable', access:'all' },
  nshst:{ domain:'non-shareable', access:'stores' },
  nshld:{ domain:'non-shareable', access:'loads' },
  osh:{ domain:'outer-shareable', access:'all' },
  oshst:{ domain:'outer-shareable', access:'stores' },
  oshld:{ domain:'outer-shareable', access:'loads' },
});

const DMB_OPTION_BY_CRM = Object.freeze([
  'sy','oshld','oshst','osh',
  'sy','nshld','nshst','nsh',
  'sy','ishld','ishst','ish',
  'sy','ld','st','sy',
]);
const DSB_OPTION_BY_CRM = Object.freeze([
  'ssbb','oshld','oshst','osh',
  'pssbb','nshld','nshst','nsh',
  'sy','ishld','ishst','ish',
  'sy','ld','st','sy',
]);

export const ARM64_DSB_NXS_OPTIONS = frozenScopes({
  oshnxs:{ domain:'outer-shareable', access:'all', nonXs:true },
  nshnxs:{ domain:'non-shareable', access:'all', nonXs:true },
  ishnxs:{ domain:'inner-shareable', access:'all', nonXs:true },
  synxs:{ domain:'full-system', access:'all', nonXs:true },
});

const STORE_BYPASS_SCOPE = Object.freeze({ domain:'speculation', access:'store-bypass' });

const DSB_NXS_OPTION_BY_CRM = Object.freeze({
  16:'oshnxs',
  20:'nshnxs',
  24:'ishnxs',
  28:'synxs',
});

export function arm64BarrierScope(option) {
  if (typeof option !== 'string') return null;
  if (option === 'ssbb' || option === 'pssbb') return STORE_BYPASS_SCOPE;
  if (Object.prototype.hasOwnProperty.call(DATA_BARRIER_SCOPES, option)) return DATA_BARRIER_SCOPES[option];
  if (Object.prototype.hasOwnProperty.call(ARM64_DSB_NXS_OPTIONS, option)) return ARM64_DSB_NXS_OPTIONS[option];
  return null;
}

export function arm64BarrierOptionFromText(mnemonic, raw) {
  if (typeof raw !== 'string') return null;
  const option = raw.trim().toLowerCase().replace(/^#/, '');
  if (!option) return null;
  if (mnemonic === 'isb') return option === 'sy' ? { option, crm:null, reservedEncoding:false } : null;
  if (mnemonic === 'dmb') return arm64BarrierScope(option) && Object.prototype.hasOwnProperty.call(DATA_BARRIER_SCOPES, option)
    ? { option, crm:null, reservedEncoding:false }
    : null;
  if (mnemonic === 'dsb') return Object.prototype.hasOwnProperty.call(DATA_BARRIER_SCOPES, option) || Object.prototype.hasOwnProperty.call(ARM64_DSB_NXS_OPTIONS, option)
    ? { option, crm:null, reservedEncoding:false }
    : null;
  return null;
}

export function arm64BarrierOptionFromImmediate(mnemonic, immediate) {
  if (typeof immediate !== 'bigint' || immediate < 0n) return null;
  const crm = Number(immediate);
  if (mnemonic === 'dmb') {
    if (immediate > 15n) return null;
    return { option:DMB_OPTION_BY_CRM[crm], crm, reservedEncoding:false };
  }
  if (mnemonic === 'dsb') {
    if (immediate <= 15n) {
      return { option:DSB_OPTION_BY_CRM[crm], crm, reservedEncoding:crm === 8 || crm === 12 };
    }
    const option = DSB_NXS_OPTION_BY_CRM[crm];
    return option ? { option, crm, reservedEncoding:false } : null;
  }
  if (mnemonic === 'isb') {
    if (immediate > 15n) return null;
    return { option:'sy', crm, reservedEncoding:crm !== 15 };
  }
  return null;
}
