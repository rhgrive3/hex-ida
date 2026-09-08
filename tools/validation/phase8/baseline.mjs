import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../../js/core/identity/index.js';

import { loadCorpus } from './build-corpus.mjs';
import { observeCorpus } from './decompile-corpus.mjs';
import {
  PHASE8_REFERENCE_MODES,
  loadFrozenBaseline,
  validateNativeBaseline,
  validateNativeProvenance,
} from './metrics.mjs';

/**
 * Captures the frozen Phase 8 baseline.
 *
 * The point of capturing it before any optimizer lands is that the comparison
 * numbers exist before anyone knows whether they will be flattering. A baseline
 * captured after the candidate is visible is not a baseline.
 *
 * The ledger binds the corpus digest and the toolchain identity. If either
 * changes the old ledger is a different series and must be re-captured rather
 * than compared across (§5 evidence identity).
 *
 * `--current` re-captures from the working tree, which is only correct while
 * Phase 8 is still a no-op. Once an optimizer changes output, re-capturing the
 * baseline from the candidate would erase exactly the evidence Phase 8 is judged
 * against, so the command refuses unless `--force` is given.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TARGET = path.join(ROOT, 'tests/phase8/corpus/pre-phase8-observations.json');
const PROVENANCE_TARGET = path.join(ROOT, 'tests/phase8/corpus/pre-phase8-provenance.json');
const NATIVE_TARGET = path.join(ROOT, 'tests/phase8/corpus/pre-phase8-native-observations.json');
const NATIVE_PROVENANCE_TARGET = path.join(ROOT, 'tests/phase8/corpus/pre-phase8-native-provenance.json');

function emptyProvenance() {
  const sourceAddresses = [];
  const irProvenance = [];
  return {
    available:false,
    sourceAddresses,
    sourceAddressesDigest:stableDigest(sourceAddresses),
    irProvenance,
    irProvenanceDigest:stableDigest(irProvenance),
    irProvenanceCount:0,
  };
}

function provenanceEntry(observation) {
  const provenance = observation?.provenance;
  if (provenance == null) return { id:observation.id, architectureId:observation.architectureId, ...emptyProvenance() };
  return {
    id:observation.id,
    architectureId:observation.architectureId,
    available:true,
    sourceAddresses:[...provenance.sourceAddresses],
    sourceAddressesDigest:provenance.sourceAddressesDigest,
    irProvenance:[...provenance.irProvenance],
    irProvenanceDigest:provenance.irProvenanceDigest,
    irProvenanceCount:provenance.irProvenanceCount,
  };
}

function provenanceLedger({ ledger, measuredObservations, corpus }) {
  const provenanceObservations = measuredObservations.map(provenanceEntry);
  return {
    schemaVersion:1,
    profileVersion:3,
    note:'Frozen pre-Phase-8 source/IR provenance sets captured from the exact pre-Phase-8 product and corpus. This sidecar is immutable evidence; re-capturing it changes acceptance semantics and invalidates Phase 8 evidence.',
    baseProductSha:ledger.baseCommit,
    corpusId:corpus.corpusId,
    corpusVersion:corpus.corpusVersion,
    corpusDigest:corpus.corpusDigest,
    toolchain:corpus.toolchain,
    baselineObservationsDigest:ledger.observationsDigest,
    observations:provenanceObservations,
    observationsDigest:stableDigest(provenanceObservations),
  };
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

export function captureBaseline({ target = TARGET, baseCommit = git(['rev-parse', 'HEAD']), decompilerTimeBudgetMs = 5000 } = {}) {
  const corpus = loadCorpus();
  const measuredObservations = observeCorpus({ corpus, decompilerTimeBudgetMs });
  // Keep the historical observation ledger byte-for-byte compatible with the
  // frozen file. Provenance is a separate acceptance identity and must not
  // silently recapture or rewrite pre-phase-8 observations.
  const observations = measuredObservations.map(({ phase8, provenance, ...rest }) => rest);
  const ledger = {
    schemaVersion: 1,
    note: 'Frozen pre-Phase-8 decompiler output for the Phase 8 corpus. Captured from the product at the Phase 8 base commit with the rewrite engine time valve disabled, so the fixed point depends only on the input and the rules. Regenerating this file is an acceptance-semantics change: it invalidates every Phase 8 no-op and quality comparison derived from it.',
    baseCommit,
    corpusId: corpus.corpusId,
    corpusVersion: corpus.corpusVersion,
    corpusDigest: corpus.corpusDigest,
    toolchain: corpus.toolchain,
    deterministicTransforms: true,
    decompilerTimeBudgetMs,
    observations,
  };
  ledger.observationsDigest = stableDigest(observations);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.renameSync(temporary, target);
  const provenance = provenanceLedger({ ledger, measuredObservations, corpus });
  const provenanceTarget = path.join(path.dirname(target), path.basename(PROVENANCE_TARGET));
  const provenanceTemporary = `${provenanceTarget}.${process.pid}.tmp`;
  fs.writeFileSync(provenanceTemporary, `${JSON.stringify(provenance, null, 2)}\n`);
  fs.renameSync(provenanceTemporary, provenanceTarget);
  return { target, provenanceTarget, ledger, provenance };
}

function nativeProvenanceEntry(observation) {
  const provenance = observation?.provenance;
  const sourceAddresses = provenance?.sourceAddresses == null ? [] : [...provenance.sourceAddresses];
  const irProvenance = provenance?.irProvenance == null ? [] : [...provenance.irProvenance];
  return {
    id:observation.id,
    architectureId:observation.architectureId,
    observationMethod:observation.observationMethod ?? null,
    available:provenance != null,
    sourceAddresses,
    sourceAddressesDigest:stableDigest(sourceAddresses),
    irProvenance,
    irProvenanceDigest:stableDigest(irProvenance),
    irProvenanceCount:irProvenance.length,
  };
}

function atomicJson(target, value) {
  const temporary = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive:true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, target);
}

/**
 * Persist the additive native paired authority produced from the historical
 * product. The legacy baseline is never read as an observation substitute;
 * this function only reuses its product/corpus identity as a binding floor.
 */
export function captureNativeBaseline({ source, target = NATIVE_TARGET, provenanceTarget = NATIVE_PROVENANCE_TARGET, corpus = loadCorpus(), frozenBaseline = loadFrozenBaseline() } = {}) {
  const input = typeof source === 'string' ? JSON.parse(fs.readFileSync(source, 'utf8')) : source;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('phase8 native baseline source must be an object');
  const reference = {
    ...input.reference,
    mode:PHASE8_REFERENCE_MODES.NATIVE_PAIRED,
  };
  const observations = Array.isArray(input.observations) ? input.observations : [];
  const ledger = {
    schemaVersion:1,
    kind:'phase8-native-paired-baseline',
    note:'Additive native ARM64 paired reference captured from the exact historical pre-Phase-8 product with the reviewed byte-backed adapter overlay. The frozen legacy baseline remains immutable and is not relabelled.',
    baseCommit:reference.baseProductSha,
    corpusId:reference.corpus?.corpusId,
    corpusVersion:reference.corpus?.corpusVersion,
    corpusDigest:reference.corpus?.corpusDigest,
    sourceDigest:reference.corpus?.sourceDigest,
    functionCount:reference.corpus?.functionCount,
    functionIdsDigest:reference.corpus?.functionIdsDigest,
    toolchain:reference.corpus?.toolchain,
    reference,
    observations,
  };
  ledger.observationsDigest = stableDigest(ledger.observations);
  ledger.referenceDigest = stableDigest(ledger.reference);
  ledger.digest = stableDigest({
    schemaVersion:ledger.schemaVersion,
    referenceDigest:ledger.referenceDigest,
    observationsDigest:ledger.observationsDigest,
  });
  const provenanceObservations = observations.map(nativeProvenanceEntry);
  const provenance = {
    schemaVersion:1,
    kind:'phase8-native-paired-provenance',
    note:'Identity-bearing source/IR provenance for the additive native ARM64 paired authority. It is bound to the native baseline and adapter/capture identity; it does not alter the frozen legacy provenance sidecar.',
    baseCommit:ledger.baseCommit,
    referenceDigest:ledger.referenceDigest,
    baselineObservationsDigest:ledger.observationsDigest,
    reference:ledger.reference,
    observations:provenanceObservations,
  };
  provenance.observationsDigest = stableDigest(provenance.observations);
  provenance.provenanceDigest = stableDigest({
    schemaVersion:provenance.schemaVersion,
    referenceDigest:provenance.referenceDigest,
    baselineObservationsDigest:provenance.baselineObservationsDigest,
    observationsDigest:provenance.observationsDigest,
  });
  const baselineErrors = validateNativeBaseline(ledger, { corpus, frozenBaseline });
  if (baselineErrors.length) throw new TypeError(`phase8 native baseline rejected: ${baselineErrors.join('; ')}`);
  const provenanceErrors = validateNativeProvenance(provenance, ledger, { corpus });
  if (provenanceErrors.length) throw new TypeError(`phase8 native provenance rejected: ${provenanceErrors.join('; ')}`);
  atomicJson(target, ledger);
  atomicJson(provenanceTarget, provenance);
  return { target, provenanceTarget, ledger, provenance };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--native')) {
    const inputIndex = argv.indexOf('--input');
    const input = inputIndex >= 0 ? argv[inputIndex + 1] : null;
    if (!input) {
      console.error('phase8 baseline: --native requires --input <historical-native-ledger.json>');
      process.exitCode = 2;
    } else {
      try {
        const result = captureNativeBaseline({ source:input });
        console.log(`phase8 native baseline written: ${path.relative(ROOT, result.target)}`);
        console.log(`phase8 native provenance written: ${path.relative(ROOT, result.provenanceTarget)}`);
        console.log(`native corpus digest: ${result.ledger.corpusDigest}`);
        console.log(`native observations digest: ${result.ledger.observationsDigest} (${result.ledger.observations.length} functions)`);
      } catch (error) {
        console.error(error?.stack || error?.message || String(error));
        process.exitCode = 1;
      }
    }
  } else if (fs.existsSync(TARGET) && !argv.includes('--force')) {
    console.error('phase8 baseline: a frozen baseline already exists. Re-capturing it invalidates every Phase 8 comparison derived from it; pass --force if that is genuinely intended.');
    process.exitCode = 2;
  } else {
    const { target, provenanceTarget, ledger, provenance } = captureBaseline();
    console.log(`phase8 baseline written: ${path.relative(ROOT, target)}`);
    console.log(`phase8 provenance written: ${path.relative(ROOT, provenanceTarget)}`);
    console.log(`corpus digest: ${ledger.corpusDigest}`);
    console.log(`observations digest: ${ledger.observationsDigest} (${ledger.observations.length} functions, ${ledger.observations.filter((observation) => observation.semantic).length} on the semantic path)`);
    console.log(`provenance digest: ${provenance.observationsDigest} (${provenance.observations.filter((observation) => observation.available).length} with source maps)`);
  }
}
