(function installSwiftAbiLayout(root) {
  'use strict';
  const PROTOCOL_REQUIREMENT_KINDS = Object.freeze([
    'base-protocol', 'method', 'init', 'getter', 'setter',
    'read-coroutine', 'modify-coroutine',
    'associated-type-access-function', 'associated-conformance-access-function',
  ]);
  const FUNCTION_REQUIREMENT_KINDS = new Set([1, 2, 3, 4, 5, 6]);

  function classDescriptorTail(flags) {
    const raw = Number(flags) >>> 0;
    const specific = (raw >>> 16) & 0xffff;
    const isGeneric = !!(raw & 0x80);
    const hasResilientSuperclass = !!(specific & (1 << 13));
    const metadataInitKind = specific & 0x3;
    const hasVTable = !!(specific & (1 << 15));
    return Object.freeze({
      specific, isGeneric, hasResilientSuperclass, metadataInitKind, hasVTable,
      canParseTail: !isGeneric && !hasResilientSuperclass && metadataInitKind === 0,
    });
  }

  function protocolDescriptor(flags) {
    const specific = ((Number(flags) >>> 0) >>> 16) & 0xffff;
    return Object.freeze({ specific, isResilient: !!(specific & 0x2) });
  }

  function protocolRequirement(flags) {
    const raw = Number(flags) >>> 0;
    const kindId = raw & 0x0f;
    const kind = PROTOCOL_REQUIREMENT_KINDS[kindId] || 'unknown';
    const isCoroutine = kindId === 5 || kindId === 6;
    const asyncBit = !!(raw & 0x20);
    const isAsync = !isCoroutine && asyncBit;
    return Object.freeze({
      flags: raw, kindId, kind, known: kindId < PROTOCOL_REQUIREMENT_KINDS.length,
      instance: !!(raw & 0x10), async: isAsync, coroutine: isCoroutine,
      extraDiscriminator: (raw >>> 16) & 0xffff,
      isFunctionImplementation: FUNCTION_REQUIREMENT_KINDS.has(kindId) && !isAsync,
    });
  }

  root.HexSwiftAbiLayout = Object.freeze({
    protocolRequirementKinds: PROTOCOL_REQUIREMENT_KINDS,
    classDescriptorTail,
    protocolDescriptor,
    protocolRequirement,
  });
})(globalThis);
