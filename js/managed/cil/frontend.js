import { createVMEffectBundle, createVMEffectFunction } from '../shared/vm-effects.js';
import { createVMOperationId } from '../shared/identity.js';
import { cilMetadataToken } from './metadata-layout.js';
import { deepFreeze } from '../../core/identity/index.js';
import { createManagedMethodId, createManagedTypeId } from '../shared/identity.js';
import { createCilMethodSignatureResolver } from './call-signatures.js';
import { liftCilMethod } from './lifter.js';
import { validateCilEffectFunction } from './validation.js';
import { parseCil, probeCil } from './parser.js';

function methodTokenText(bodyIndex, methodAuthority) {
  const token = methodAuthority?.methodToken;
  if (Number.isSafeInteger(token) && token >= 0x06000001 && token <= 0x06ffffff) {
    return `0x${token.toString(16).padStart(8, '0')}`;
  }
  return `0x06${(bodyIndex + 1).toString(16).padStart(6, '0')}`;
}

export class CilFrontend {
  constructor(options = {}) {
    this.id = 'cil';
    this.contractVersion = '1.0.0';
    this.semanticVersion = '1.0.0';
    this.options = options;
  }

  async probe(bytes, context = {}) {
    return probeCil(bytes);
  }

  async open(bytes, context = {}) {
    const cilImage = parseCil(bytes, { ...this.options, ...context });
    return cilImage;
  }

  async *enumerateModules(image, options = {}) {
    yield {
      id: image.moduleId,
      imageId: image.imageId,
      name: 'Assembly.dll',
      formatVersion: image.formatVersion,
    };
  }

  async *enumerateTypes(image, options = {}) {
    for (const type of image.types ?? []) {
      yield {
        ...type,
        id: createManagedTypeId(image.moduleId, type.token),
        moduleId: image.moduleId,
      };
    }
  }

  async *enumerateMethods(image, options = {}) {
    const resolveMethodSignature = createCilMethodSignatureResolver(image);
    const methods = image.methods?.length ? image.methods : image.methodBodies.map((body, i) => ({
      bodyIndex: i,
      token: body.token ?? methodTokenText(i, resolveMethodSignature(body)),
      name: `Method_${i + 1}`,
    }));
    for (const [index, method] of methods.entries()) {
      const body = method.bodyIndex == null ? null : image.methodBodies[method.bodyIndex];
      const authority = body ? resolveMethodSignature(body) : null;
      const token = method.token ?? methodTokenText(method.bodyIndex ?? 0, authority);
      const name = typeof method.name === 'string' && method.name.length > 0
        ? method.name : `Method_${index + 1}`;
      yield {
        ...method,
        name,
        token,
        id: createManagedMethodId(image.moduleId, token),
        moduleId: image.moduleId,
        declaringTypeId: method.declaringTypeToken
          ? createManagedTypeId(image.moduleId, method.declaringTypeToken) : null,
      };
    }
  }

  async decodeMethod(method, context = {}) {
    const image = context.image;
    if (!image) throw new TypeError('cil-context-image-required');
    const hasDefinitions = Array.isArray(image.methods) && image.methods.length > 0;
    const definition = hasDefinitions ? image.methods.find(row => row.token === method.token) : null;
    if (hasDefinitions && (!definition || definition.bodyIndex !== method.bodyIndex)) {
      throw new TypeError('cil-method-definition-mismatch');
    }
    if (definition?.bodyIndex === null) {
      const methodId = createManagedMethodId(image.moduleId, definition.token);
      const bundle = createVMEffectBundle({
        operationId: createVMOperationId(methodId, 0, 0), methodId,
        frontendId: 'cil', profileId: image.vmSpecEdition,
        bytecodeOffset: 0, mnemonic: 'body-unavailable', completeness: 'unknown',
        unknownEffects: [{ category: 'control', reason: 'cil-method-body-unavailable' }],
      });
      return createVMEffectFunction({ frontendId: 'cil', profileId: image.vmSpecEdition,
        methodId, bundles: [bundle], aggregateCompleteness: 'unknown' }, context);
    }
    const body = image.methodBodies[method.bodyIndex];
    if (!body) throw new TypeError('cil-invalid-method-body-index');
    const authority = createCilMethodSignatureResolver(image)(body);
    return liftCilMethod(method.bodyIndex, image, context, authority);
  }

  async validateMethod(decoded, context = {}) {
    return validateCilEffectFunction(decoded, context);
  }

  async liftMethod(decoded, validation, context = {}) {
    return decoded;
  }
}
