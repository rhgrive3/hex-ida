#!/usr/bin/env node
/* Fresh real-binary focused probe audit. This never calls Jev or changes Pinpoint. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { openBinary } from '../tests/harness.mjs';
import { pinpointField, pickMethodsToRead } from '../js/pinpoint.js';
import { parseGoal } from '../js/goals.js';
import { assessJevEligibility } from '../js/pinpoint-jev-eligibility.js';
import { evidence, groupOf } from '../js/evidence.js';
import { verifyAccessor, verifyFunctionHandlesField } from '../js/verify.js';
import { productionReplay, assertBaselineParity, queryId, strong } from './pinpoint-probe-scheduler.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, 'reports/investigations/pinpoint-jev-probe-audit-20260923');
const FIXTURES = process.env.HEX_PINPOINT_FIXTURE_ROOT;
if (!FIXTURES) throw new Error('HEX_PINPOINT_FIXTURE_ROOT must name verified real-binary cache');
const binaryPath = (name) => path.join(FIXTURES, 'tests', name);
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const expectedHashes = {
  battlecats: '567234909b2a33d62548257c4148290d9215d7edf414fa17c6b06fcf8c7cdf13',
  TsumTsum: '4f877bb1d4e1503b439ce07c601a1fddd6a38a6f32395bfd3071b056f77839b3',
  YWP: 'cd1c72a30ba29f423a670f9e534c8865689ca09890769a95822869c162d240a6',
};
for (const [name, digest] of Object.entries(expectedHashes)) {
  if (sha256(binaryPath(name)) !== digest) throw new Error(`fixture mismatch: ${name}`);
}
const baselinePath = path.join(OUT, 'baseline', 'rows.jsonl');
const baseline = fs.readFileSync(baselinePath, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.kind === 'field');
if (baseline.length !== 426 || baseline.some((r) => r.error || r.replayFidelity !== 'match')) {
  throw new Error('fresh 426-row production baseline incomplete');
}
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'baseline', 'measurement.json'), 'utf8'));
if (manifest.fieldRows !== 426 || Object.entries(expectedHashes).some(([n, h]) => manifest.fixtures[n]?.sha256 !== h)) {
  throw new Error('baseline manifest does not bind the real binaries');
}
const tokens = (c) => new Set((c?.evidence || []).filter((e) => e.applied > 0)
  .map((e) => `${e.code}|${e.group || ''}|${e.kind || ''}|${e.identifying ? 'id' : ''}`));
const sameSignature = (a, b) => {
  const x = tokens(a), y = tokens(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};
const eligibility = baseline.map((r) => {
  const deterministicEvidence = r.candidates[0] && r.candidates[1]
    && sameSignature(r.candidates[0], r.candidates[1]) ? 'unresolved' : 'decisive';
  return {
    row: r,
    decision: assessJevEligibility({
      queryMode: r.mode, candidateLattice: r.candidatePresent ? 'complete' : 'truncated',
      parserFailure: !!r.error, lifterFailure: false, functionExtentFailure: false,
      candidateCount: r.candidateCount, localVerdict: r.currentVerdict,
      deterministicEvidence, highImpact: true,
    }),
  };
});
const eligible = eligibility.filter((x) => x.decision.eligible);
if (!eligible.length) throw new Error('no eligible queries');
const fixtureQueries = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/pinpoint-confidence-queries.json'), 'utf8'));
const queryById = new Map(fixtureQueries.map((q) => [`${q.binary}|${q.mode}|${q.label}`, q]));
const serializable = (value) => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));
const worlds = new Map();
async function worldFor(binary) {
  if (!worlds.has(binary)) worlds.set(binary, await openBinary(binaryPath(binary), { log: () => {} }));
  return worlds.get(binary);
}
function snapshotCandidate(c) {
  return {
    key: c.key, className: c.className, fieldName: c.field?.name,
    recallLane: !!c.recallLane, askedByName: !!c.askedByName,
    askedBySequence: !!c.askedBySequence, askedByWords: !!c.askedByWords,
    offset: String(c.offset), size: c.size,
    evidence: c.evidence.map((e) => serializable(e)),
    fusion: { logOdds: c.fusion.logOdds, probability: c.fusion.probability,
      verified: c.fusion.verified, identifying: c.fusion.identifying,
      independentGroups: c.fusion.independentGroups, groups: c.fusion.groups,
      byGroup: c.fusion.byGroup, byFamily: c.fusion.byFamily },
  };
}
function focusedRow(q, res, calls, latencyMs, baselineAddresses, baselineScanOffsets) {
  const ranked = res.candidates || [];
  const truthRank = ranked.findIndex((c) => c.className === q.class && c.field?.name === q.ivar) + 1;
  return {
    schema: 'hex-pinpoint-focused-eligible/v2', queryId: `${q.binary}|${q.mode}|${q.label}`,
    binary: q.binary, label: q.label, mode: q.mode, expectedClass: q.class, expectedField: q.ivar,
    candidateCount: ranked.length, universe: res.universe, priorCandidates: res.priorCandidates,
    topCandidate: ranked[0]?.key, runnerUp: ranked[1]?.key, truthRank,
    localVerdict: res.verdict, margin: res.margin, topFusion: snapshotCandidate(ranked[0]).fusion,
    runnerFusion: snapshotCandidate(ranked[1]).fusion,
    baselineAnalyzeFunctions: [...baselineAddresses],
    baselineScanOffsets: [...baselineScanOffsets],
    candidates: ranked.map((candidate) => ({
      ...snapshotCandidate(candidate),
      marginToTop: ranked[0].fusion.logOdds - candidate.fusion.logOdds,
    })), baselineAnalyzeCalls: calls, baselineLatencyMs: latencyMs,
    candidateLattice: 'complete', highImpactAssumedForMeasurement: true,
  };
}
function methodAddr(m) {
  try { return m?.addr != null ? BigInt(m.addr) : null; } catch { return null; }
}
function probePool(row, raw, w, goal, baselineAddresses, baselineScanOffsets) {
  const probes = [];
  for (const c of raw.candidates) {
    const id = c.key;
    const baselineFns = new Set([
      ...(c.verifications || []).map((x) => String(x.addr)),
      ...(c.sites || []).map((x) => String(x.addr)),
    ]);
    const add = (family, m, sourceKind) => {
      const addr = methodAddr(m);
      if (addr == null) return;
      const functionId = addr.toString();
      const sourceIdentity = `${row.binary}:function:${functionId}:field:${c.offset}`;
      if (probes.some((p) => p.candidateId === id && p.sourceIdentity === sourceIdentity)) return;
      probes.push({
        probeId: `${row.queryId}|${id}|${family}|${functionId}`,
        queryId: row.queryId, family, candidateId: id, sourceIdentity,
        evidenceProvenance: sourceKind, method: { addr: functionId, sel: m.sel || null },
        estimatedCost: 1,
        baselineCovered: baselineFns.has(functionId) || baselineAddresses.has(functionId),
        analysisCalls: 0,
        elapsedMs: 0, observations: [], failed: false, timedOut: false, unsupported: false,
      });
    };
    add('getter-verification', c.accessors?.getter, 'verifyAccessor');
    add('setter-verification', c.accessors?.setter, 'verifyAccessor');
    const methods = w.fields.classInfo(c.className)?.methods || [];
    for (const m of pickMethodsToRead(methods, goal, 3)) {
      add('class-local-method-inspection', m, 'verifyFunctionHandlesField');
    }
    const anchor = methodAddr(c.accessors?.getter || c.accessors?.setter);
    if (anchor != null) {
      const callers = w.program.callersOf(anchor, 1);
      for (const caller of callers.slice(0, 1)) if (caller.addr != null) add('caller-inspection', { addr: caller.addr }, 'call-graph+verifyFunctionHandlesField');
      const range = w.program.functionRange(anchor);
      if (range) {
        const callees = w.program.calleesOf(range.start, range.end, 1);
        for (const callee of callees.slice(0, 1)) add('callee-inspection', { addr: callee.addr }, 'call-graph+verifyFunctionHandlesField');
      }
    }
    probes.push({
      probeId: `${row.queryId}|${id}|scan-access`, queryId: row.queryId,
      family: 'scan-access', candidateId: id,
      sourceIdentity: `${row.binary}:access-index:offset:${c.offset}`,
      evidenceProvenance: 'scanAccess fieldAccessMany index', estimatedCost: 1,
      analysisCalls: 0, elapsedMs: 0, observations: [], failed: false,
      timedOut: false, unsupported: false, offset: c.offset, size: c.size,
      baselineCovered: baselineScanOffsets.has(String(c.offset)),
    });
  }
  return probes;
}
function observation(probe, code, strength, site, detail = null) {
  return {
    candidateId: probe.candidateId, code, strength,
    sourceIdentity: `${probe.sourceIdentity}:site:${site ?? 'function'}`,
    evidenceProvenance: probe.evidenceProvenance,
    detail: detail ? { primitive: probe.evidenceProvenance } : null,
  };
}
async function executeProbe(probe, raw, w) {
  if (probe.baselineCovered) {
    probe.actualCost = 0;
    probe.budgetConsumed = { analyzeCalls: 0, elapsedMs: 0, probes: 0 };
    return probe;
  }
  const c = raw.candidates.find((x) => x.key === probe.candidateId);
  const start = performance.now();
  try {
    if (probe.family === 'scan-access') {
      const sites = await w.scanAccess([{ offset: c.offset, size: c.size || 0 }]);
      const list = sites?.get?.(String(c.offset)) || [];
      probe.siteCount = list.length;
      probe.accessSites = list.slice(0, 20).map((site) => ({
        address: site.addr == null ? null : String(site.addr),
        kind: site.kind || null, size: site.size ?? null,
      }));
      // Index hits alone do not prove receiver identity; no score is minted.
      probe.evidenceProvenance = 'scanAccess:index-only-unscored';
    } else {
      const addr = BigInt(probe.method.addr);
      const range = w.program.functionRange(addr);
      probe.analysisCalls = 1;
      const model = await w.analyze(addr, range?.end ?? null);
      if (!model) { probe.failed = true; return probe; }
      if (probe.family === 'getter-verification' || probe.family === 'setter-verification') {
        const v = verifyAccessor(model, { offset: BigInt(c.offset), size: c.size });
        if (probe.family === 'getter-verification' && v.getter) {
          probe.observations.push(observation(probe, 'getter-verified', v.exclusive ? 1 : 0.75, v.address, v));
          // size-fits already comes from metadata; do not re-add it.
        }
        if (probe.family === 'setter-verification' && v.setter) {
          probe.observations.push(observation(probe, 'setter-verified', v.fromArgument ? 1 : 0.7, v.address, v));
        }
      } else {
        const owner = w.fields.ownerOf(addr);
        if (!owner || owner.className !== c.className) {
          probe.evidenceProvenance += ':receiver-owner-unproven';
          return probe;
        }
        const v = verifyFunctionHandlesField(model, BigInt(c.offset));
        if (v.touches) {
          const site = v.use.sites[0]?.address;
          probe.observations.push(observation(probe, 'access-verified', 1, site, v.use));
          if (v.rmw) probe.observations.push(observation(probe, 'rmw-verified', 1, v.use.rmw[0]?.store?.address, v.use.rmw[0]));
          if (v.guard) probe.observations.push(observation(probe, 'guard-verified', 0.8, v.use.compares[0]?.address, v.use.compares[0]));
          if (v.writes) probe.observations.push(observation(probe, 'written-in-class', 1, v.use.sites.find((x) => x.kind === 'store')?.address, v.use));
        }
      }
    }
  } catch (err) {
    probe.failed = true; probe.error = String(err?.message || err).slice(0, 200);
    probe.observations = [];
  } finally {
    probe.elapsedMs = Math.round((performance.now() - start) * 100) / 100;
    if (probe.elapsedMs > 2000) { probe.timedOut = true; probe.observations = []; }
    probe.actualCost = probe.analysisCalls || (probe.family === 'scan-access' ? 1 : 0);
    probe.budgetConsumed = { analyzeCalls: probe.analysisCalls, elapsedMs: probe.elapsedMs, probes: 1 };
  }
  return probe;
}
function transition(row, probe) {
  const before = productionReplay(row);
  const after = productionReplay(row, [probe]);
  const beforeCandidate = before.candidates.find((x) => x.key === probe.candidateId);
  const afterCandidate = after.candidates.find((x) => x.key === probe.candidateId);
  const beforeCodes = new Set(beforeCandidate.evidence.map((x) => x.code));
  const evidenceAdded = after.evidenceAdded[probe.candidateId] || [];
  const differential = evidenceAdded.some((code) => !before.candidates.slice(0, 2)
    .every((c) => c.evidence.some((e) => e.code === code)));
  const competitorDemoted = !before.topCorrect && after.candidates.findIndex((c) => c.key === before.top)
    > before.candidates.findIndex((c) => c.key === before.top);
  const truthImproved = after.truthRank > 0 && after.truthRank < before.truthRank;
  const marginImproved = before.topCorrect && after.topCorrect && after.margin - before.margin >= Math.log(2);
  const falseStrongPrevented = !before.topCorrect && strong(before.verdict) && !strong(after.verdict);
  const correctPromoted = after.topCorrect && !strong(before.verdict) && strong(after.verdict);
  const useful = evidenceAdded.length > 0 && (truthImproved || competitorDemoted
    || marginImproved || falseStrongPrevented || correctPromoted || differential);
  const decisive = (after.topCorrect && strong(after.verdict))
    || falseStrongPrevented;
  return {
    ...probe, evidenceBefore: [...beforeCodes], evidenceAdded,
    evidenceAfter: afterCandidate.evidence.map((x) => x.code).concat(evidenceAdded),
    rankBefore: before.truthRank, rankAfter: after.truthRank,
    topBefore: before.top, topAfter: after.top, marginBefore: before.margin, marginAfter: after.margin,
    verdictBefore: before.verdict, verdictAfter: after.verdict,
    truthImproved, competitorDemoted, useful, decisive,
  };
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const corpus = [], transitions = [];
  for (const { row: baselineRow } of eligible) {
    const q = queryById.get(queryId(baselineRow));
    if (!q) throw new Error('missing independent truth fixture');
    const w = await worldFor(q.binary);
    const goal = parseGoal(q.label);
    let calls = 0;
    const baselineAddresses = new Set();
    const baselineScanOffsets = new Set();
    const start = performance.now();
    const res = await pinpointField({
      goal, fields: w.fields, program: w.program, symbols: w.symbols,
      strings: w.strings, analyze: async (...args) => {
        calls++; baselineAddresses.add(String(args[0])); return w.analyze(...args);
      },
      scanAccess: async (list) => {
        for (const entry of list) baselineScanOffsets.add(String(entry.offset));
        return w.scanAccess(list);
      }, limit: 400,
    });
    const row = focusedRow(q, res, calls, Math.round((performance.now() - start) * 100) / 100,
      baselineAddresses, baselineScanOffsets);
    if (row.topCandidate !== baselineRow.candidates[0].key || row.truthRank !== baselineRow.truthRank
      || row.localVerdict !== baselineRow.currentVerdict || row.candidateCount !== baselineRow.candidateCount) {
      throw new Error(`fresh focused replay diverged: ${row.queryId}`);
    }
    assertBaselineParity(row);
    corpus.push(row);
    const probes = probePool(row, res, w, goal, baselineAddresses, baselineScanOffsets);
    for (const probe of probes) transitions.push(transition(row, await executeProbe(probe, res, w)));
    process.stdout.write(`focused ${corpus.length}/${eligible.length}: ${row.queryId} probes=${probes.length}\n`);
  }
  const writeJsonl = (name, rows) => {
    const target = path.join(OUT, name), pending = target + '.partial';
    fs.writeFileSync(pending, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.renameSync(pending, target);
  };
  writeJsonl('focused-eligible-corpus.jsonl', corpus);
  writeJsonl('probe-transitions.jsonl', transitions);
  const catalog = {
    schema: 'hex-pinpoint-production-probe-catalog/v2',
    productionCommit: manifest.productCommit, baselineRows: baseline.length,
    eligibleRows: corpus.length, fixtureHashes: expectedHashes,
    families: [
      ['getter-verification', 'verifyAccessor', 'scored when novel'],
      ['setter-verification', 'verifyAccessor', 'scored when novel'],
      ['field-read-site-inspection', 'verifyFunctionHandlesField/fieldUse', 'inside class method probe'],
      ['field-write-site-inspection', 'verifyFunctionHandlesField/fieldUse', 'inside class method probe'],
      ['class-local-method-inspection', 'verifyFunctionHandlesField', 'scored when novel'],
      ['caller-inspection', 'ProgramIndex.callersOf + verifyFunctionHandlesField', 'scored when self field proven'],
      ['callee-inspection', 'ProgramIndex.calleesOf + verifyFunctionHandlesField', 'scored when self field proven'],
      ['local-dataflow', 'findValueUpdates through fieldUse', 'inside class method probe'],
      ['read-modify-write-pattern', 'verifyFunctionHandlesField', 'inside class method probe'],
      ['compare-constant-behavior', 'constantComparisons through fieldUse', 'inside class method probe'],
      ['mutation-pattern', 'verifyFunctionHandlesField', 'inside class method probe'],
      ['scan-access', 'scanAccess/fieldAccessMany', 'index-only; unscored without receiver proof'],
      ['shape-evidence', 'valueShapes/shapeEvidenceFor', 'location primitive exists; no field scorer or receiver mapping, so no field score minted'],
      ['property-selector-evidence', 'buildFieldCandidate', 'already collected by baseline; no novel fact'],
      ['type-rtti-evidence', 'FieldIndex metadata', 'already collected by baseline; no novel fact'],
    ].map(([family, primitive, disposition]) => ({ family, primitive, disposition })),
    probeCount: transitions.length,
    deduplication: 'candidate/code and sourceIdentity; legacy baseline lacking instruction identity conservatively blocks same code',
  };
  fs.writeFileSync(path.join(OUT, 'probe-catalog-v2.json'), JSON.stringify(catalog, null, 2) + '\n');
  process.stdout.write(`complete: ${corpus.length} focused, ${transitions.length} probe records\n`);
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
