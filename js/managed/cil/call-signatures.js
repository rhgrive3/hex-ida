import {
  buildCilCallMetadataIndex,
  MEMBER_REF_TABLE,
  METHOD_DEF_TABLE,
  METHOD_SPEC_TABLE,
  readCilMetadataBlob,
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
        'cil-call-signature-methodspec-blob-invalid'));
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
        provenance:Object.freeze({
          token,
          table:'MethodSpec',
          rid,
          instantiationBlobIndex:row.instantiation,
          resolvedToken:baseToken,
          resolvedTable:base.provenance.table,
          signatureBlobIndex:base.provenance.signatureBlobIndex,
        }),
      });
    }

    const rows = table === METHOD_DEF_TABLE ? index.methodDefs : index.memberRefs;
    const blobIndex = rows[rid - 1];
    if (!Number.isSafeInteger(blobIndex) || blobIndex < 1) fail('cil-call-signature-row-missing');
    const signature = parseCilMethodSignature(readCilMetadataBlob(index.blobHeap, blobIndex,
      'cil-call-signature-blob-invalid'));
    return Object.freeze({
      complete:true,
      signature,
      provenance:Object.freeze({
        token,
        table:table === METHOD_DEF_TABLE ? 'MethodDef' : 'MemberRef',
        rid,
        resolvedToken:token,
        signatureBlobIndex:blobIndex,
      }),
    });
  } catch (error) {
    return Object.freeze({
      complete:false,
      reason:error instanceof Error ? error.message : 'cil-call-signature-invalid',
    });
  }
}

export function createCilCallSignatureResolver(cilImage) {
  let index;
  try {
    index = buildCilCallMetadataIndex(cilImage?.rawBytes);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'cil-call-signature-metadata-invalid';
    return () => Object.freeze({ complete:false, reason });
  }
  return (token) => resolveIndexed(index, token);
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
