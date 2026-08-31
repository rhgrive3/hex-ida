/**
 * HEX-C3-03 — Go Runtime Metadata Provider.
 *
 * Implements toolchain-aware Go runtime metadata extraction from `.gopclntab`,
 * `.gosymtab`, `.go.buildinfo`, and moduledata structures.
 *
 * Supported Go pclntab formats:
 * - Go 1.2  (magic: 0xfffffffb)
 * - Go 1.16 (magic: 0xfffffffa)
 * - Go 1.18 (magic: 0xfffffff0)
 * - Go 1.20+ (magic: 0xfffffff1)
 *
 * Strict fail-closed rules:
 * - Unrecognized pclntab magic -> explicit `unsupported` verdict; never guess layout.
 * - Truncated, cyclic, or out-of-bounds tables -> explicit `malformed` / `partial` completeness.
 * - Stripped binaries with no pclntab -> `present: false`, `identity-unavailable`, zero fabricated types.
 */

import {
  LanguageMetadataProvider,
  createLanguageMetadataIdentity,
  createLanguageMetadataRecord,
  createLanguageMetadataPage,
  createLanguageMetadataResult,
  METADATA_DEFAULT_BUDGET,
} from './provider.js';

export const GO_PROVIDER_ID = 'metadata.go';
export const GO_PROVIDER_VERSION = '1.0.0';

export const GO_PCLNTAB_MAGICS = Object.freeze({
  0xfffffffb: { version: '1.2', name: 'go1.2' },
  0xfffffffa: { version: '1.16', name: 'go1.16' },
  0xfffffff0: { version: '1.18', name: 'go1.18' },
  0xfffffff1: { version: '1.20+', name: 'go1.20+' },
});

export const GO_TYPE_KINDS = Object.freeze({
  1: 'bool',
  2: 'int',
  3: 'int8',
  4: 'int16',
  5: 'int32',
  6: 'int64',
  7: 'uint',
  8: 'uint8',
  9: 'uint16',
  10: 'uint32',
  11: 'uint64',
  12: 'uintptr',
  13: 'float32',
  14: 'float64',
  15: 'complex64',
  16: 'complex128',
  17: 'array',
  18: 'chan',
  19: 'func',
  20: 'interface',
  21: 'map',
  22: 'pointer',
  23: 'slice',
  24: 'string',
  25: 'struct',
  26: 'unsafePointer',
});

function u8(buf, off) {
  if (off < 0 || off >= buf.length) return null;
  return buf[off];
}

function u16(buf, off, little = true) {
  if (off < 0 || off + 2 > buf.length) return null;
  return little ? (buf[off] | (buf[off + 1] << 8)) : ((buf[off] << 8) | buf[off + 1]);
}

function u32(buf, off, little = true) {
  if (off < 0 || off + 4 > buf.length) return null;
  const val = little
    ? (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24))
    : ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]);
  return val >>> 0;
}

function i32(buf, off, little = true) {
  const val = u32(buf, off, little);
  return val == null ? null : (val | 0);
}

function u64(buf, off, little = true) {
  if (off < 0 || off + 8 > buf.length) return null;
  let val = 0n;
  if (little) {
    for (let i = 7; i >= 0; i--) val = (val << 8n) | BigInt(buf[off + i]);
  } else {
    for (let i = 0; i < 8; i++) val = (val << 8n) | BigInt(buf[off + i]);
  }
  return val;
}

function readPtr(buf, off, ptrSize, little = true) {
  return ptrSize === 4 ? BigInt(u32(buf, off, little) ?? 0) : (u64(buf, off, little) ?? 0n);
}

function readCString(buf, off, maxLen = 1024) {
  if (off < 0 || off >= buf.length) return null;
  let end = off;
  const limit = Math.min(buf.length, off + maxLen);
  while (end < limit && buf[end] !== 0) {
    if (buf[end] < 0x20 || buf[end] === 0x7f) return null; // control chars
    end++;
  }
  if (end >= limit || end === off) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(off, end));
  } catch {
    return null;
  }
}

/**
 * Decodes Go varint / uvarint used in string length and offsets.
 */
function readUvarint(buf, off) {
  let val = 0;
  let shift = 0;
  let pos = off;
  while (pos < buf.length && shift < 35) {
    const b = buf[pos++];
    val |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: val, bytesRead: pos - off };
    shift += 7;
  }
  return null;
}

/**
 * Searches a byte buffer for Go build info (go1.x.y version).
 */
export function findGoBuildVersion(buffer) {
  if (!buffer || buffer.length < 16) return null;
  // Look for `\xff Go buildinf:` magic or `go1.` string pattern
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, Math.min(buffer.length, 1024 * 1024)));
  const match = text.match(/\bgo(1\.\d+(?:\.\d+)?(?:[a-zA-Z0-9_.-]+)?)\b/);
  return match ? match[1] : null;
}

/**
 * Parses the pclntab header and returns layout information.
 */
export function parsePclntabHeader(buf) {
  if (!buf || buf.length < 16) return { valid: false, reason: 'buffer-too-small' };

  let little = true;
  let magic = u32(buf, 0, true);
  if (!GO_PCLNTAB_MAGICS[magic]) {
    magic = u32(buf, 0, false);
    little = false;
  }

  if (!GO_PCLNTAB_MAGICS[magic]) {
    return { valid: false, reason: 'unrecognized-magic', magic: u32(buf, 0, true) };
  }

  const magicInfo = GO_PCLNTAB_MAGICS[magic];
  const minLC = u8(buf, 6);
  const ptrSize = u8(buf, 7);

  if (ptrSize !== 4 && ptrSize !== 8) {
    return { valid: false, reason: 'invalid-pointer-size', ptrSize };
  }

  const requiredHeaderSize = magicInfo.version === '1.2'
    ? 8 + ptrSize
    : magicInfo.version === '1.16'
      ? 8 + 7 * ptrSize
      : 8 + 8 * ptrSize;
  if (buf.length < requiredHeaderSize) {
    return { valid: false, reason: 'buffer-too-small' };
  }

  let nfunc = 0;
  let nfiles = 0;
  let textStart = 0n;
  let funcnametabOff = 0;
  let cutabOff = 0;
  let filetabOff = 0;
  let pctabOff = 0;
  let pclnOff = 0;
  let ftabOff = 0;

  if (magicInfo.version === '1.2') {
    nfunc = Number(readPtr(buf, 8, ptrSize, little));
    ftabOff = 8 + ptrSize;
  } else if (magicInfo.version === '1.16') {
    nfunc = Number(readPtr(buf, 8, ptrSize, little));
    nfiles = Number(readPtr(buf, 8 + ptrSize, ptrSize, little));
    funcnametabOff = Number(readPtr(buf, 8 + 2 * ptrSize, ptrSize, little));
    cutabOff = Number(readPtr(buf, 8 + 3 * ptrSize, ptrSize, little));
    filetabOff = Number(readPtr(buf, 8 + 4 * ptrSize, ptrSize, little));
    pctabOff = Number(readPtr(buf, 8 + 5 * ptrSize, ptrSize, little));
    pclnOff = Number(readPtr(buf, 8 + 6 * ptrSize, ptrSize, little));
    ftabOff = 8 + 7 * ptrSize;
  } else {
    // 1.18 and 1.20+
    nfunc = Number(readPtr(buf, 8, ptrSize, little));
    nfiles = Number(readPtr(buf, 8 + ptrSize, ptrSize, little));
    textStart = readPtr(buf, 8 + 2 * ptrSize, ptrSize, little);
    funcnametabOff = Number(readPtr(buf, 8 + 3 * ptrSize, ptrSize, little));
    cutabOff = Number(readPtr(buf, 8 + 4 * ptrSize, ptrSize, little));
    filetabOff = Number(readPtr(buf, 8 + 5 * ptrSize, ptrSize, little));
    pctabOff = Number(readPtr(buf, 8 + 6 * ptrSize, ptrSize, little));
    pclnOff = Number(readPtr(buf, 8 + 7 * ptrSize, ptrSize, little));
    ftabOff = 8 + 8 * ptrSize;
  }

  return {
    valid: true,
    magic,
    version: magicInfo.version,
    versionName: magicInfo.name,
    little,
    minLC,
    ptrSize,
    nfunc,
    nfiles,
    textStart,
    funcnametabOff,
    cutabOff,
    filetabOff,
    pctabOff,
    pclnOff,
    ftabOff,
  };
}

/**
 * Parses Go pclntab function entries with bounds checking.
 */
export function parseGoFunctions(buf, header, options = {}) {
  const maxFuncs = Math.min(header.nfunc, options.maxRecords ?? 50000);
  const functions = [];
  let unreadableEntries = 0;
  let invalidEntries = 0;

  const ftabOff = header.ftabOff;
  const is118Plus = header.version === '1.18' || header.version === '1.20+';
  const entrySize = is118Plus ? 8 : header.ptrSize * 2;

  for (let i = 0; i < maxFuncs; i++) {
    const slot = ftabOff + i * entrySize;
    if (slot + entrySize > buf.length) {
      unreadableEntries++;
      break;
    }

    let entryPC = 0n;
    let funcOff = 0;

    if (is118Plus) {
      const entryOff = u32(buf, slot, header.little);
      funcOff = u32(buf, slot + 4, header.little);
      if (entryOff == null || funcOff == null) { invalidEntries++; continue; }
      entryPC = header.textStart + BigInt(entryOff);
    } else {
      entryPC = readPtr(buf, slot, header.ptrSize, header.little);
      funcOff = Number(readPtr(buf, slot + header.ptrSize, header.ptrSize, header.little));
    }

    if (funcOff < 0 || funcOff >= buf.length) {
      invalidEntries++;
      continue;
    }

    // Read function descriptor _func
    let name = null;
    let frameSize = null;
    let argsSize = null;

    if (is118Plus) {
      const nameOff = i32(buf, funcOff + 4, header.little);
      argsSize = i32(buf, funcOff + 8, header.little);
      if (nameOff != null && header.funcnametabOff + nameOff < buf.length) {
        name = readCString(buf, header.funcnametabOff + nameOff);
      }
    } else if (header.version === '1.16') {
      const nameOff = i32(buf, funcOff + header.ptrSize, header.little);
      argsSize = i32(buf, funcOff + header.ptrSize + 4, header.little);
      if (nameOff != null && header.funcnametabOff + nameOff < buf.length) {
        name = readCString(buf, header.funcnametabOff + nameOff);
      }
    } else {
      // 1.2
      const nameOff = i32(buf, funcOff + header.ptrSize, header.little);
      argsSize = i32(buf, funcOff + header.ptrSize + 4, header.little);
      frameSize = i32(buf, funcOff + header.ptrSize + 8, header.little);
      if (nameOff != null && nameOff < buf.length) {
        name = readCString(buf, nameOff);
      }
    }

    if (!name) {
      invalidEntries++;
      continue;
    }

    functions.push({
      index: i,
      name,
      address: `0x${entryPC.toString(16)}`,
      entryPC,
      argsSize,
      frameSize,
      funcOff,
    });
  }

  const capped = header.nfunc > maxFuncs;
  const complete = !capped && unreadableEntries === 0 && invalidEntries === 0 && functions.length === header.nfunc;

  return {
    functions,
    completeness: {
      present: true,
      declared: header.nfunc,
      scanned: maxFuncs,
      parsed: functions.length,
      capped,
      unreadableEntries,
      invalidEntries,
      complete,
    },
  };
}

/**
 * Parses Go type descriptor (_type) at a given buffer offset.
 */
export function parseGoTypeDescriptor(buf, typeOff, options = {}) {
  const ptrSize = options.ptrSize ?? 8;
  const little = options.little ?? true;

  if (typeOff < 0 || typeOff + ptrSize * 4 + 8 > buf.length) return null;

  const size = Number(readPtr(buf, typeOff, ptrSize, little));
  const ptrdata = Number(readPtr(buf, typeOff + ptrSize, ptrSize, little));
  const hash = u32(buf, typeOff + ptrSize * 2, little);
  const tflag = u8(buf, typeOff + ptrSize * 2 + 4);
  const align = u8(buf, typeOff + ptrSize * 2 + 5);
  const fieldAlign = u8(buf, typeOff + ptrSize * 2 + 6);
  const rawKind = u8(buf, typeOff + ptrSize * 2 + 7);

  if (rawKind == null) return null;
  const kindId = rawKind & 0x1f;
  const kind = GO_TYPE_KINDS[kindId] || 'unknown';

  // In Go 1.7+, str is a name offset (int32 or ptr)
  const nameOff = i32(buf, typeOff + ptrSize * 2 + 8, little);
  let name = null;
  if (options.typesBase != null && nameOff != null) {
    const strPos = options.typesBase + nameOff;
    if (strPos >= 0 && strPos + 2 < buf.length) {
      // Go name structure has 1 byte header flag followed by length varint
      const lenInfo = readUvarint(buf, strPos + 1);
      if (lenInfo && strPos + 1 + lenInfo.bytesRead + lenInfo.value <= buf.length) {
        try {
          name = new TextDecoder('utf-8', { fatal: true }).decode(
            buf.subarray(strPos + 1 + lenInfo.bytesRead, strPos + 1 + lenInfo.bytesRead + lenInfo.value)
          );
        } catch {
          name = null;
        }
      }
    }
  }

  return {
    kind,
    kindId,
    size,
    ptrdata,
    hash,
    tflag,
    align,
    fieldAlign,
    name: name || `go_type_${kind}_${typeOff.toString(16)}`,
    address: `0x${(BigInt(options.baseAddress ?? 0) + BigInt(typeOff)).toString(16)}`,
  };
}

/**
 * Go Language Metadata Provider implementation.
 */
export class GoMetadataProvider extends LanguageMetadataProvider {
  constructor({
    pclntabBuffer = null,
    rodataBuffer = null,
    sections = [],
    binaryIdentity = null,
    architecture = 'x86_64',
    platform = 'linux',
    baseAddress = 0n,
    options = {},
  } = {}) {
    super({ id: GO_PROVIDER_ID, version: GO_PROVIDER_VERSION, ecosystem: 'go' });
    this.pclntabBuffer = pclntabBuffer;
    this.rodataBuffer = rodataBuffer;
    this.sections = sections;
    this.binaryIdentity = binaryIdentity;
    this.architecture = architecture;
    this.platform = platform;
    this.baseAddress = BigInt(baseAddress);
    this.options = options;
    this.cachedHeader = null;
    this.cachedFunctions = null;
  }

  probe() {
    if (!this.pclntabBuffer || this.pclntabBuffer.length === 0) {
      return createLanguageMetadataResult({
        providerId: this.id,
        providerVersion: this.version,
        ecosystem: 'go',
        identity: createLanguageMetadataIdentity({
          verdict: 'identity-unavailable',
          providerId: this.id,
          providerVersion: this.version,
          ecosystem: 'go',
          binaryIdentity: this.binaryIdentity,
          architecture: this.architecture,
          platform: this.platform,
          method: 'pclntab-probe',
          detail: 'no pclntab section or buffer present',
        }),
        sections: this.sections.map((s) => s.name || s.section || String(s)),
        completeness: { present: false, declared: 0, scanned: 0, parsed: 0, complete: true },
      });
    }

    if (this.pclntabBuffer.length < 16) {
      return createLanguageMetadataResult({
        providerId: this.id,
        providerVersion: this.version,
        ecosystem: 'go',
        identity: createLanguageMetadataIdentity({
          verdict: 'malformed',
          providerId: this.id,
          providerVersion: this.version,
          ecosystem: 'go',
          binaryIdentity: this.binaryIdentity,
          architecture: this.architecture,
          platform: this.platform,
          method: 'pclntab-probe',
          detail: 'pclntab buffer truncated (smaller than minimum header)',
        }),
        sections: this.sections.map((s) => s.name || s.section || String(s)),
        completeness: { present: true, declared: 0, scanned: 0, parsed: 0, complete: false, reasons: ['buffer-too-small'] },
      });
    }

    const header = parsePclntabHeader(this.pclntabBuffer);
    this.cachedHeader = header;

    if (!header.valid) {
      const verdict = header.reason === 'unrecognized-magic' ? 'unsupported' : 'malformed';
      return createLanguageMetadataResult({
        providerId: this.id,
        providerVersion: this.version,
        ecosystem: 'go',
        identity: createLanguageMetadataIdentity({
          verdict,
          providerId: this.id,
          providerVersion: this.version,
          ecosystem: 'go',
          binaryIdentity: this.binaryIdentity,
          architecture: this.architecture,
          platform: this.platform,
          method: 'pclntab-header',
          detail: `pclntab validation failed: ${header.reason}`,
        }),
        sections: this.sections.map((s) => s.name || s.section || String(s)),
        completeness: { present: true, declared: 0, scanned: 0, parsed: 0, complete: false, reasons: [header.reason] },
        diagnostics: [`Go pclntab invalid: ${header.reason}`],
      });
    }

    const buildVersion = findGoBuildVersion(this.rodataBuffer) || header.versionName;
    const funcResult = parseGoFunctions(this.pclntabBuffer, header, this.options);
    this.cachedFunctions = funcResult;

    const identity = createLanguageMetadataIdentity({
      verdict: funcResult.completeness.complete ? 'matched-authoritative' : 'matched-partial',
      providerId: this.id,
      providerVersion: this.version,
      ecosystem: 'go',
      toolchainVersion: buildVersion,
      binaryIdentity: this.binaryIdentity,
      expected: this.binaryIdentity,
      observed: this.binaryIdentity,
      architecture: this.architecture,
      platform: this.platform,
      method: 'pclntab-magic',
      detail: `Go ${header.versionName} (${funcResult.functions.length} functions)`,
      coverage: funcResult.completeness.complete ? null : {
        recordKinds: ['symbol', 'type'],
        addresses: funcResult.functions.map((f) => f.address),
      },
    });

    return createLanguageMetadataResult({
      providerId: this.id,
      providerVersion: this.version,
      ecosystem: 'go',
      identity,
      sections: this.sections.map((s) => s.name || s.section || String(s)),
      counts: {
        symbols: funcResult.functions.length,
      },
      completeness: funcResult.completeness,
    });
  }

  symbols() {
    if (!this.cachedFunctions) {
      const probeResult = this.probe();
      if (!probeResult.completeness.present || !this.cachedFunctions) {
        return createLanguageMetadataPage({ records: [] });
      }
    }

    const records = this.cachedFunctions.functions.map((fn) =>
      createLanguageMetadataRecord({
        kind: 'symbol',
        entityId: `sym@${fn.address}`,
        name: fn.name,
        address: fn.address,
        providerId: this.id,
        providerVersion: this.version,
        ecosystem: 'go',
        buildIdentity: this.binaryIdentity,
        descriptor: {
          isFunction: true,
          argsSize: fn.argsSize,
          frameSize: fn.frameSize,
          entryPC: fn.entryPC.toString(),
        },
      })
    );

    return createLanguageMetadataPage({
      records,
      truncated: this.cachedFunctions.completeness.capped,
    });
  }
}