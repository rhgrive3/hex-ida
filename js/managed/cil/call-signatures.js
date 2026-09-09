import {
  buildCilCallMetadataIndex,
  MEMBER_REF_TABLE,
  METHOD_DEF_TABLE,
  METHOD_SPEC_TABLE,
  readCilMetadataBlob,
  readCilMetadataString,
} from './call-signature-metadata.js';
import {
  parseCilMethodSignature,
  parseCilMethodSpecInstantiation,
  substituteCilMethodGeneric,
} from './call-signature-types.js';

function fail(code) { throw new TypeError(code); }
function tokenFor(table, rid) { return ((table << 24) | rid) >>> 0; }

function resolveIndexed(index, token, depth = 0) {
  if (depth > 4 || !Number.isSafeInteger(token) || token < 0 || token > 0xffffffff) {
    return Object.freeze({ complete:false, reason:'cil-call-signature-token-invalid' });
  }
  const table = token >>> 24;
  const rid = token & 0x00ffffff;
  if (rid < 1 || ![METHOD_DEF_TABLE, MEMBER_REF_TABLE, METHOD_SPEC_TABLE].includes(table)) {
    return Object.freeze({ complete:false, reason:'cil-call-signature-token-kind-invalid' });
  }

  try {
    if (table === METHOD_SPEC_TABLE) {
      const row = index.methodSpecs[rid - 1];
      if (!row) fail('cil-call-signature-methodspec-row-missing');
      const baseRid = row.method >>> 1;
      const baseTable = (row.method & 1) === 0 ? METHOD_DEF_TABLE : MEMBER_REF_TABLE;
      if (baseRid < 1) fail('cil-call-signature-methodspec-target-invalid');
      const baseToken = tokenFor(baseTable, baseRid);
      const base = resolveIndexed(index, baseToken, depth + 1);
      if (!base.complete) return base;
      const args = parseCilMethodSpecInstantiation(readCilMetadataBlob(index.blobHeap, row.instantiation,
        'cil-call-signature-methodspec-blob-invalid'), index.typeDefOrRefRowCounts);
      if (args.length !== base.signature.genericParameterCount) fail('cil-call-signature-methodspec-arity-mismatch');
      const parameters = base.signature.parameters.map((value) => substituteCilMethodGeneric(value, args));
      const returnValue = substituteCilMethodGeneric(base.signature.returnValue, args);
      return Object.freeze({
        complete:true,
        signature:Object.freeze({
          ...base.signature,
          genericArguments:args,
          parameters:Object.freeze(parameters),
          returnValue,
        }),
        methodName:base.methodName,
        provenance:Object.freeze({
          token,
          table:'MethodSpec',
          rid,
          instantiationBlobIndex:row.instantiation,
          resolvedToken:baseToken,
          resolvedTable:base.provenance.table,
          signatureBlobIndex:base.provenance.signatureBlobIndex,
          nameStringIndex:base.provenance.nameStringIndex,
          methodName:base.methodName,
        }),
      });
    }

    const rows = table === METHOD_DEF_TABLE ? index.methodDefs : index.memberRefs;
    const row = rows[rid - 1];
    const blobIndex = row?.signatureBlobIndex;
    if (!row || !Number.isSafeInteger(blobIndex) || blobIndex < 1) fail('cil-call-signature-row-missing');
    const methodName = readCilMetadataString(index.stringsHeap, row.nameIndex,
      'cil-call-signature-method-name-invalid');
    const signature = parseCilMethodSignature(readCilMetadataBlob(index.blobHeap, blobIndex,
      'cil-call-signature-blob-invalid'), index.typeDefOrRefRowCounts);
    if (table === METHOD_DEF_TABLE) {
      if (!Number.isSafeInteger(row.accessFlags) || row.accessFlags < 0 || row.accessFlags > 0xffff) {
        fail('cil-call-signature-methoddef-flags-invalid');
      }
      const isStatic = (row.accessFlags & 0x0010) !== 0;
      if (isStatic === signature.hasThis) fail('cil-call-signature-methoddef-static-hasthis-mismatch');
    }
    return Object.freeze({
      complete:true,
      signature,
      methodName,
      provenance:Object.freeze({
        token,
        table:table === METHOD_DEF_TABLE ? 'MethodDef' : 'MemberRef',
        rid,
        resolvedToken:token,
        signatureBlobIndex:blobIndex,
        nameStringIndex:row.nameIndex,
        methodName,
        ...(table === METHOD_DEF_TABLE ? { methodAccessFlags:row.accessFlags } : {}),
      }),
    });
  } catch (error) {
    return Object.freeze({
      complete:false,
      reason:error instanceof Error ? error.message : 'cil-call-signature-invalid',
    });
  }
}

function buildResolverIndex(cilImage) {
  try {
    return { index:buildCilCallMetadataIndex(cilImage?.rawBytes), reason:null };
  } catch (error) {
    return {
      index:null,
      reason:error instanceof Error ? error.message : 'cil-call-signature-metadata-invalid',
    };
  }
}

export function createCilCallSignatureResolver(cilImage) {
  const { index, reason } = buildResolverIndex(cilImage);
  if (!index) return () => Object.freeze({ complete:false, reason });
  return (token) => resolveIndexed(index, token);
}

export function createCilMethodSignatureResolver(cilImage) {
  const { index, reason } = buildResolverIndex(cilImage);
  if (!index) return () => Object.freeze({ complete:false, reason });

  return (methodBody) => {
    const bodyOffset = methodBody?.headerOffset;
    if (!Number.isSafeInteger(bodyOffset) || bodyOffset < 0) {
      return Object.freeze({ complete:false, reason:'cil-return-method-body-identity-unavailable' });
    }

    const matches = [];
    for (let row = 0; row < index.methodDefs.length; row++) {
      if (index.methodDefs[row]?.bodyOffset === bodyOffset) matches.push(row + 1);
    }
    if (matches.length !== 1) {
      return Object.freeze({
        complete:false,
        reason:matches.length === 0
          ? 'cil-return-methoddef-unresolved'
          : 'cil-return-methoddef-ambiguous',
      });
    }

    const rid = matches[0];
    const methodToken = tokenFor(METHOD_DEF_TABLE, rid);
    const resolved = resolveIndexed(index, methodToken);
    return Object.freeze({
      ...resolved,
      methodToken,
      bodyOffset,
    });
  };
}

export function createCilCallStackEffect(kind, resolution) {
  if (!['call', 'callvirt', 'newobj'].includes(kind)) fail('cil-call-stack-kind-invalid');
  if (!resolution?.complete || !resolution.signature) {
    return Object.freeze({
      complete:false,
      reason:resolution?.reason || 'cil-call-signature-unresolved',
      consumedValues:Object.freeze([]),
      producedValues:Object.freeze([]),
      provenance:resolution?.provenance ?? null,
    });
  }

  const signature = resolution.signature;
  if ((kind === 'callvirt' || kind === 'newobj') && !signature.hasThis) {
    return Object.freeze({
      complete:false,
      reason:'cil-call-instance-signature-required',
      consumedValues:Object.freeze([]),
      producedValues:Object.freeze([]),
      provenance:resolution.provenance,
    });
  }
  if (kind === 'newobj' && resolution.methodName !== '.ctor') {
    return Object.freeze({
      complete:false,
      reason:'cil-newobj-constructor-target-invalid',
      consumedValues:Object.freeze([]),
      producedValues:Object.freeze([]),
      provenance:resolution.provenance,
    });
  }
  if (kind === 'newobj' && signature.returnValue !== null) {
    return Object.freeze({
      complete:false,
      reason:'cil-newobj-constructor-signature-invalid',
      consumedValues:Object.freeze([]),
      producedValues:Object.freeze([]),
      provenance:resolution.provenance,
    });
  }

  const consumedValues = [];
  for (let index = signature.parameters.length - 1; index >= 0; index--) {
    consumedValues.push(Object.freeze({ id:`arg${index}`, ...signature.parameters[index] }));
  }
  if (kind !== 'newobj' && signature.hasThis) consumedValues.push(Object.freeze({ id:'this' }));

  const producedValues = [];
  if (kind === 'newobj') producedValues.push(Object.freeze({ id:'constructed-object', stackType:'object-ref' }));
  else if (signature.returnValue) producedValues.push(Object.freeze({ id:'call-result', ...signature.returnValue }));

  return Object.freeze({
    complete:true,
    consumedValues:Object.freeze(consumedValues),
    producedValues:Object.freeze(producedValues),
    provenance:resolution.provenance,
    parameterCount:signature.parameters.length,
    hasThis:signature.hasThis,
    returnsValue:producedValues.length === 1,
  });
}
