import { deepFreeze } from '../../core/identity/index.js';
import { createManagedMethodId, createManagedTypeId } from '../shared/identity.js';
import { createCilCallSignatureResolver } from './call-signatures.js';
import { liftCilMethod } from './lifter.js';
import { validateCilEffectFunction } from './validation.js';
import { parseCil, probeCil } from './parser.js';

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
    for (let i = 0; i < image.methodBodies.length; i++) {
      const token = `0x0600000${(i + 1).toString(16)}`;
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
    let returnStackSlots = context?.returnStackSlots;
    if (returnStackSlots === undefined && context?.image && decoded?.methodId) {
      try {
        const tokenMatch = String(decoded.methodId).match(/0x[0-9a-fA-F]+/);
        if (tokenMatch) {
          const token = parseInt(tokenMatch[0], 16);
          const resolver = createCilCallSignatureResolver(context.image);
          const res = resolver(token);
          if (res?.complete && res.signature) {
            returnStackSlots = res.signature.returnValue ? 1 : 0;
          }
        }
      } catch {
        // Fall back to context/unresolved return shape
      }
    }
    return validateCilEffectFunction(decoded, returnStackSlots !== undefined ? { ...context, returnStackSlots } : context);
  }

  async liftMethod(decoded, validation, context = {}) {
    return decoded;
  }
}
