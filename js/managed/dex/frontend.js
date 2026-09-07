import { deepFreeze } from '../../core/identity/index.js';
import { createManagedMethodId, createManagedTypeId } from '../shared/identity.js';
import { createManagedValidationReport } from '../shared/validation.js';
import { liftDexMethod } from './lifter.js';
import { parseDex, probeDex } from './parser.js';
import { validateLinearIntRegisterDataflow } from './register-dataflow.js';
import { captureDexValidationMetadata, validateDexMethod } from './validation.js';

export class DexFrontend {
  constructor(options = {}) {
    this.id = 'dex';
    this.contractVersion = '1.0.0';
    this.semanticVersion = '1.0.0';
    this.options = options;
  }

  async probe(bytes, context = {}) {
    return probeDex(bytes);
  }

  async open(bytes, context = {}) {
    const dexImage = parseDex(bytes, { ...this.options, ...context });
    return dexImage;
  }

  async *enumerateModules(image, options = {}) {
    yield {
      id: image.moduleId,
      imageId: image.imageId,
      name: 'classes.dex',
      formatVersion: image.formatVersion,
    };
  }

  async *enumerateTypes(image, options = {}) {
    for (let i = 0; i < image.classes.length; i++) {
      const cls = image.classes[i];
      yield {
        id: createManagedTypeId(image.moduleId, cls.classType),
        moduleId: image.moduleId,
        classType: cls.classType,
        superType: cls.superType,
        sourceFile: cls.sourceFile,
        accessFlags: cls.accessFlags,
      };
    }
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
        classType: meth.classType,
        proto: meth.proto,
      };
    }
  }

  async decodeMethod(method, context = {}) {
    const dexImage = context.image;
    if (!dexImage) throw new TypeError('dex-context-image-required');
    const decoded = liftDexMethod(method.methodIdx, dexImage, context);
    const dexValidation = captureDexValidationMetadata(method.methodIdx, dexImage);
    return deepFreeze({
      ...decoded,
      metadata: {
        ...(decoded.metadata ?? {}),
        dexValidation,
      },
    });
  }

  async validateMethod(decoded, context = {}) {
    const verifier = validateDexMethod(decoded);
    const dataflow = validateLinearIntRegisterDataflow(decoded?.metadata?.dexValidation, context.image);
    const provenOffsets = dataflow.complete ? new Set(dataflow.provenOffsets) : null;
    const partialReasons = verifier.partialReasons.filter((reason) => !(provenOffsets
      && reason?.code === 'dex-verifier-dataflow-incomplete'
      && provenOffsets.has(reason.offset)));
    const verifierErrors = [...verifier.errors, ...dataflow.errors];
    const verifierFacts = dataflow.complete
      ? [...verifier.verifierFacts, { code:'dex-linear-int-register-dataflow-validated', instructionOffsets:dataflow.provenOffsets }]
      : verifier.verifierFacts;
    const hasUnknowns = decoded.bundles.some((b) => b.completeness === 'unknown');
    const hasPartials = decoded.bundles.some((b) => b.completeness === 'partial');
    const semanticPartial = hasUnknowns || hasPartials;
    const invalid = verifier.structuralErrors.length > 0 || verifierErrors.length > 0;
    const verifierPartial = partialReasons.length > 0;
    const status = invalid ? 'invalid' : (semanticPartial || verifierPartial) ? 'partial' : 'valid';
    return createManagedValidationReport({
      targetId: decoded.methodId,
      status,
      errors: [...verifier.structuralErrors, ...verifierErrors],
      warnings: [...verifier.warnings, ...partialReasons],
      verifierFacts,
      completeness: {
        structural: verifier.structuralErrors.length > 0 ? 'failed' : 'complete',
        specValidation: invalid ? 'failed' : verifierPartial || semanticPartial ? 'partial' : 'valid',
        semanticEffect: semanticPartial ? 'partial' : 'complete',
      },
    });
  }

  async liftMethod(decoded, validation, context = {}) {
    return decoded;
  }
}
