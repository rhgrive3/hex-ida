import { deepFreeze } from '../../core/identity/index.js';
import { createManagedMethodId, createManagedTypeId } from '../shared/identity.js';
import { createManagedValidationReport } from '../shared/validation.js';
import { createVMEffectFunction } from '../shared/vm-effects.js';
import { liftJvmMethod } from './lifter.js';
import { parseJvm, probeJvm } from './parser.js';
import { verifyJvmMethod } from './verifier.js';

function classMajorVersion(image) {
  const match = /^class-(\d+)\./.exec(image?.formatVersion ?? '');
  return match ? Number(match[1]) : null;
}

export class JvmFrontend {
  constructor(options = {}) {
    this.id = 'jvm';
    this.contractVersion = '1.0.0';
    this.semanticVersion = '1.0.0';
    this.options = options;
  }

  async probe(bytes, context = {}) {
    return probeJvm(bytes);
  }

  async open(bytes, context = {}) {
    const jvmClass = parseJvm(bytes, { ...this.options, ...context });
    return jvmClass;
  }

  async *enumerateModules(image, options = {}) {
    yield {
      id: image.moduleId,
      imageId: image.imageId,
      name: `${image.thisClassName}.class`,
      formatVersion: image.formatVersion,
    };
  }

  async *enumerateTypes(image, options = {}) {
    yield {
      id: createManagedTypeId(image.moduleId, image.thisClassName),
      moduleId: image.moduleId,
      thisClassName: image.thisClassName,
      superClassName: image.superClassName,
      interfaces: image.interfaces,
      accessFlags: image.accessFlags,
    };
  }

  async *enumerateMethods(image, options = {}) {
    for (let i = 0; i < image.methods.length; i++) {
      const meth = image.methods[i];
      const methodId = createManagedMethodId(image.moduleId, i, meth.name);
      yield {
        id: methodId,
        moduleId: image.moduleId,
        methodIdx: i,
        name: meth.name,
        descriptor: meth.descriptor,
        accessFlags: meth.accessFlags,
      };
    }
  }

  async decodeMethod(method, context = {}) {
    const jvmClass = context.image;
    if (!jvmClass) throw new TypeError('jvm-context-image-required');
    const decoded = liftJvmMethod(method.methodIdx, jvmClass, context);
    const sourceMethod = jvmClass.methods[method.methodIdx];
    return createVMEffectFunction({
      ...decoded,
      metadata: {
        ...decoded.metadata,
        methodIdx: method.methodIdx,
        descriptor: sourceMethod?.descriptor ?? method.descriptor,
        accessFlags: sourceMethod?.accessFlags ?? method.accessFlags,
        hasCode: sourceMethod?.code != null,
        codeLength: sourceMethod?.code?.codeLength ?? 0,
        classMajorVersion: classMajorVersion(jvmClass),
      },
    }, context);
  }

  async validateMethod(decoded, context = {}) {
    const verification = verifyJvmMethod(decoded, context);
    const hasUnknowns = decoded.bundles.some((b) => b.completeness === 'unknown');
    const hasPartials = decoded.bundles.some((b) => b.completeness === 'partial');
    const semanticStatus = hasUnknowns || hasPartials ? 'partial' : 'valid';
    const status = verification.status === 'invalid'
      ? 'invalid'
      : verification.status === 'valid' && semanticStatus === 'valid'
        ? 'valid'
        : 'partial';
    return createManagedValidationReport({
      targetId: decoded.methodId,
      status,
      completeness: {
        structural: hasUnknowns ? 'partial' : 'complete',
        specValidation: verification.status === 'invalid'
          ? 'failed'
          : verification.status === 'valid'
            ? 'valid'
            : 'partial',
        semanticEffect: semanticStatus === 'valid' ? 'complete' : 'partial',
      },
      errors: verification.errors,
      warnings: verification.warnings,
      verifierFacts: verification.verifierFacts,
    });
  }

  async liftMethod(decoded, validation, context = {}) {
    return decoded;
  }
}
