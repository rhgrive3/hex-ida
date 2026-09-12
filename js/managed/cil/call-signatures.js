import {
  buildCilCallMetadataIndex,
  MEMBER_REF_TABLE,
  METHOD_DEF_TABLE,
  METHOD_SPEC_TABLE,
  STANDALONE_SIG_TABLE,
  readCilMetadataBlob,
  readCilMetadataString,
} from './call-signature-metadata.js';
import {
  parseCilMethodSignature,
  parseCilLocalVarSignature,
  parseCilMethodSpecInstantiation,
  substituteCilMethodGeneric,
} from './call-signature-types.js';

function fail(code) { throw new TypeError(code); }
function tokenFor(table, rid) { return ((table << 24) | rid) >>> 0; }

const OWNER_TYPE_DEF = 0x02;
const OWNER_TYPE_REF = 0x01;
const OWNER_TYPE_SPEC = 0x1b;
const OWNER_METHOD_DEF = 0x06;
const OWNER_MODULE_REF = 0x1a;
const SCOPE_ASSEMBLY_REF = 0x23;
const SCOPE_TYPE_REF = 0x01;
const SCOPE_MODULE_REF = 0x1a;
const SCOPE_MODULE = 0x00;

function readOwnerString(heap, index, code) {
  return index === 0 ? '' : readCilMetadataString(heap, index, code);
}

function resolveOwnerScope(index, scopeEncoded, depth) {
  if (scopeEncoded === 0) return null;
  if (depth > 2) fail('cil-call-signature-memberref-owner-scope-invalid');
  const tag = scopeEncoded & 0x03;
  const rid = scopeEncoded >>> 2;
  const table = [SCOPE_MODULE, SCOPE_MODULE_REF, SCOPE_ASSEMBLY_REF, SCOPE_TYPE_REF][tag];
  if (table === undefined) fail('cil-call-signature-memberref-owner-scope-invalid');
  const rowCount = index.tableRowCounts?.[table];
  if (!Number.isSafeInteger(rowCount) || rid < 1 || rid > rowCount) {
    fail('cil-call-signature-memberref-owner-scope-row-missing');
  }
  if (table === SCOPE_ASSEMBLY_REF) {
    const row = index.assemblyRefs[rid - 1];
    if (!row) fail('cil-call-signature-memberref-owner-scope-row-missing');
    const publicKeyOrToken = row.publicKeyBlobIndex === 0 ? null
      : readCilMetadataBlob(index.blobHeap, row.publicKeyBlobIndex,
        'cil-call-signature-memberref-owner-scope-public-key-invalid');
    const hashValue = row.hashValueBlobIndex === 0 ? null
      : readCilMetadataBlob(index.blobHeap, row.hashValueBlobIndex,
        'cil-call-signature-memberref-owner-scope-hash-invalid');
    const culture = row.cultureIndex === 0 ? null
      : readCilMetadataString(index.stringsHeap, row.cultureIndex,
        'cil-call-signature-memberref-owner-scope-culture-invalid');
    return Object.freeze({
      table:'AssemblyRef',
      rid,
      name:readOwnerString(index.stringsHeap, row.nameIndex, 'cil-call-signature-memberref-owner-scope-name-invalid'),
      majorVersion:row.majorVersion,
      minorVersion:row.minorVersion,
      buildNumber:row.buildNumber,
      revisionNumber:row.revisionNumber,
      flags:row.flags,
      publicKeyOrToken:publicKeyOrToken && Object.freeze([...publicKeyOrToken]),
      culture,
      hashValue:hashValue && Object.freeze([...hashValue]),
    });
  }
  if (table === SCOPE_MODULE_REF) {
    const row = index.moduleRefs[rid - 1];
    if (!row) fail('cil-call-signature-memberref-owner-scope-row-missing');
    return Object.freeze({
      table:'ModuleRef',
      rid,
      name:readOwnerString(index.stringsHeap, row.nameIndex, 'cil-call-signature-memberref-owner-scope-name-invalid'),
    });
  }
  if (table === SCOPE_TYPE_REF) {
    const row = index.typeRefs[rid - 1];
    if (!row) fail('cil-call-signature-memberref-owner-scope-row-missing');
    return Object.freeze({
      table:'TypeRef',
      rid,
      name:readOwnerString(index.stringsHeap, row.nameIndex, 'cil-call-signature-memberref-owner-scope-name-invalid'),
      namespace:readOwnerString(index.stringsHeap, row.namespaceIndex,
        'cil-call-signature-memberref-owner-scope-namespace-invalid'),
      scope:resolveOwnerScope(index, row.scopeEncoded, depth + 1),
    });
  }
  return Object.freeze({ table:'Module', rid });
}

function resolveMemberRefOwner(index, row) {
  switch (row.parentTable) {
    case OWNER_TYPE_DEF: {
      const owner = index.typeDefs[row.parentRid - 1];
      if (!owner) fail('cil-call-signature-memberref-parent-row-missing');
      return Object.freeze({
        table:'TypeDef',
        rid:row.parentRid,
        name:readOwnerString(index.stringsHeap, owner.nameIndex, 'cil-call-signature-memberref-owner-name-invalid'),
        namespace:readOwnerString(index.stringsHeap, owner.namespaceIndex,
          'cil-call-signature-memberref-owner-namespace-invalid'),
      });
    }
    case OWNER_TYPE_REF: {
      const owner = index.typeRefs[row.parentRid - 1];
      if (!owner) fail('cil-call-signature-memberref-parent-row-missing');
      return Object.freeze({
        table:'TypeRef',
        rid:row.parentRid,
        name:readOwnerString(index.stringsHeap, owner.nameIndex, 'cil-call-signature-memberref-owner-name-invalid'),
        namespace:readOwnerString(index.stringsHeap, owner.namespaceIndex,
          'cil-call-signature-memberref-owner-namespace-invalid'),
        scope:resolveOwnerScope(index, owner.scopeEncoded, 0),
      });
    }
    case OWNER_TYPE_SPEC: {
      const owner = index.typeSpecs[row.parentRid - 1];
      if (!owner) fail('cil-call-signature-memberref-parent-row-missing');
      const signature = readCilMetadataBlob(index.blobHeap, owner.signatureBlobIndex,
        'cil-call-signature-memberref-owner-typespec-blob-invalid');
      try {
        const wrapped = new Uint8Array(signature.length + 2);
        wrapped[0] = 0x0a;
        wrapped[1] = 0x01;
        wrapped.set(signature, 2);
        parseCilMethodSpecInstantiation(wrapped, index.typeDefOrRefRowCounts);
      } catch {
        fail('cil-call-signature-memberref-owner-typespec-signature-invalid');
      }
      return Object.freeze({
        table:'TypeSpec',
        rid:row.parentRid,
        signatureBlobIndex:owner.signatureBlobIndex,
        signatureBytes:Object.freeze([...signature]),
      });
    }
    case OWNER_METHOD_DEF: {
      const owner = index.methodDefs[row.parentRid - 1];
      if (!owner) fail('cil-call-signature-memberref-parent-row-missing');
      return Object.freeze({
        table:'MethodDef',
        rid:row.parentRid,
        name:readOwnerString(index.stringsHeap, owner.nameIndex, 'cil-call-signature-memberref-owner-name-invalid'),
      });
    }
    case OWNER_MODULE_REF: {
      const owner = index.moduleRefs[row.parentRid - 1];
      if (!owner) fail('cil-call-signature-memberref-parent-row-missing');
      return Object.freeze({
        table:'ModuleRef',
        rid:row.parentRid,
        name:readOwnerString(index.stringsHeap, owner.nameIndex, 'cil-call-signature-memberref-owner-name-invalid'),
      });
    }
    default: fail('cil-call-signature-memberref-parent-invalid');
  }
}

function ownerScopeResolved(scope) {
  if (scope == null || scope.table === 'Module') return false;
  if (scope.table === 'TypeRef') return ownerScopeResolved(scope.scope);
  return true;
}

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
          ...(base.provenance.owner != null
            ? { owner:base.provenance.owner, ownerTable:base.provenance.ownerTable, ownerRid:base.provenance.ownerRid }
            : {}),
        }),
      });
    }

    const rows = table === METHOD_DEF_TABLE ? index.methodDefs : index.memberRefs;
    const row = rows[rid - 1];
    const blobIndex = row?.signatureBlobIndex;
    if (!row || !Number.isSafeInteger(blobIndex) || blobIndex < 1) fail('cil-call-signature-row-missing');
    let owner = null;
    if (table === MEMBER_REF_TABLE) {
      if (!Number.isSafeInteger(row.parentTable) || !Number.isSafeInteger(row.parentRid) || row.parentRid < 1) {
        fail('cil-call-signature-memberref-parent-invalid');
      }
      const parentRowCount = index.tableRowCounts?.[row.parentTable];
      if (!Number.isSafeInteger(parentRowCount) || row.parentRid > parentRowCount) {
        fail('cil-call-signature-memberref-parent-row-missing');
      }
      owner = resolveMemberRefOwner(index, row);
    }
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
        ...(table === METHOD_DEF_TABLE
          ? { methodAccessFlags:row.accessFlags }
          : { owner, ownerTable:row.parentTable, ownerRid:row.parentRid }),
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

// Local slot typing for the lifter (#5353): ldloc*/stloc* resolve their width
// and stack type from the fat header's LocalVarSigTok authority instead of
// fabricating a 32-bit exact fact. Arguments ride on the MethodDef signature
// authority already resolved for the enclosing method.
export function createCilLocalTypeResolver(cilImage) {
  const { index, reason } = buildResolverIndex(cilImage);
  if (!index) {
    return () => Object.freeze({ complete:false, reason, locals:null });
  }

  const cache = new Map();
  return (methodBody) => {
    if (cache.has(methodBody)) return cache.get(methodBody);
    let declared;
    const token = methodBody?.localVarSigTok;
    if (!Number.isSafeInteger(token) || token <= 0) {
      // No LocalVarSigTok: the method declares zero typed locals, so any
      // access is out of frame rather than an unknown 32-bit slot.
      declared = Object.freeze({ complete:true, reason:null, locals:[] });
    } else if ((token >>> 24) !== STANDALONE_SIG_TABLE) {
      declared = Object.freeze({ complete:false, reason:'cil-local-var-sig-token-invalid', locals:null });
    } else {
      const rid = token & 0x00ffffff;
      const blobIndex = index.standAloneSigs[rid - 1];
      if (!Number.isSafeInteger(blobIndex) || blobIndex < 1) {
        declared = Object.freeze({ complete:false, reason:'cil-local-var-sig-row-missing', locals:null });
      } else {
        try {
          const blob = readCilMetadataBlob(index.blobHeap, blobIndex, 'cil-local-var-sig-blob-invalid');
          declared = Object.freeze({
            complete:true,
            reason:null,
            locals:parseCilLocalVarSignature(blob, index.typeDefOrRefRowCounts),
          });
        } catch (error) {
          declared = Object.freeze({
            complete:false,
            reason:error instanceof Error ? error.message : 'cil-local-var-signature-invalid',
            locals:null,
          });
        }
      }
    }
    cache.set(methodBody, declared);
    return declared;
  };
}

export function createCilCallStackEffect(kind, resolution) {  if (!['call', 'callvirt', 'newobj'].includes(kind)) fail('cil-call-stack-kind-invalid');
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
  const prov = resolution.provenance;
  const owner = prov?.owner ?? null;
  const typeOwnerResolved = owner != null && (owner.table === 'TypeDef' || owner.table === 'TypeSpec'
    || (owner.table === 'TypeRef' && ownerScopeResolved(owner.scope)));
  const ownerTargetResolved = kind === 'newobj'
    ? typeOwnerResolved
    : (owner != null && (owner.table === 'TypeDef' || owner.table === 'TypeSpec'
      || owner.table === 'MethodDef' || owner.table === 'ModuleRef'
      || (owner.table === 'TypeRef' && ownerScopeResolved(owner.scope))));
  const callTargetResolved = prov?.table === 'MethodDef'
    || (prov?.table === 'MethodSpec'
      ? (prov.resolvedTable === 'MethodDef' || ownerTargetResolved)
      : prov?.table === 'MemberRef' ? ownerTargetResolved : false);
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
  if (kind === 'newobj') {
    producedValues.push(Object.freeze({
      id:'constructed-object',
      stackType:'object-ref',
      ...(owner != null && (owner.table === 'TypeDef' || owner.table === 'TypeRef' || owner.table === 'TypeSpec')
        ? { constructedType:owner } : {}),
    }));
  } else if (signature.returnValue) producedValues.push(Object.freeze({ id:'call-result', ...signature.returnValue }));

  return Object.freeze({
    complete:true,
    consumedValues:Object.freeze(consumedValues),
    producedValues:Object.freeze(producedValues),
    provenance:resolution.provenance,
    parameterCount:signature.parameters.length,
    hasThis:signature.hasThis,
    returnsValue:producedValues.length === 1,
    callTargetResolved,
    ...(callTargetResolved ? {} : { callTargetReason:
      kind === 'newobj' && owner != null && (owner.table === 'MethodDef' || owner.table === 'ModuleRef')
        ? 'cil-newobj-owner-not-type-authority'
        : owner?.table === 'TypeRef' ? 'cil-call-target-owner-scope-unresolved' : 'cil-call-target-owner-external' }),
  });
}
