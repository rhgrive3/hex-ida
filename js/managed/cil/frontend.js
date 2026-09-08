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
    yield {
      id: createManagedTypeId(image.moduleId, 'MainType'),
      moduleId: image.moduleId,
      name: 'MainType',
    };
  }

  async *enumerateMethods(image, options = {}) {
    const resolveMethodSignature = createCilMethodSignatureResolver(image);
    for (let i = 0; i < image.methodBodies.length; i++) {
      const methodAuthority = resolveMethodSignature(image.methodBodies[i]);
      const token = methodTokenText(i, methodAuthority);
      const methodId = createManagedMethodId(image.moduleId, token);
      yield {
        id: methodId,
        moduleId: image.moduleId,
        bodyIndex: i,
        token,
        name: `Method_${i + 1}`,
      };
    }
  }

  async decodeMethod(method, context = {}) {
    const cilImage = context.image;
    if (!cilImage) throw new TypeError('cil-context-image-required');
    return liftCilMethod(method.bodyIndex, cilImage, context);
  }

  async validateMethod(decoded, context = {}) {
    return validateCilEffectFunction(decoded, context);
  }

  async liftMethod(decoded, validation, context = {}) {
    return decoded;
  }
}
