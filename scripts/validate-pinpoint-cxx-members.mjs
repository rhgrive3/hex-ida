#!/usr/bin/env node
// Focused validation of the production path, with matched baseline sampling.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const rounded = (n) => Math.round(n * 1000) / 1000;
const sha = (repo) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const load = (repo, name) => import(pathToFileURL(path.join(repo, name)).href);

function optionsFor(args) {
  const options = { repo: ROOT, sample: 30, query: 'health' };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--binary', '--output', '--repo', '--compare-repo', '--sample', '--query'].includes(key)) throw new Error(`unknown argument: ${key}`);
    if (args[i + 1] == null) throw new Error(`missing value: ${key}`);
    options[key.slice(2).replace('-repo', 'Repo')] = args[++i];
  }
  options.sample = Number(options.sample);
  if (!options.binary || !options.output || !Number.isSafeInteger(options.sample) || options.sample < 1 || options.sample > 256) {
    throw new Error('usage: --binary PATH --output PATH [--sample 30] [--repo PATH] [--compare-repo PATH] [--query health]');
  }
  return options;
}

async function persistentDirectory(destination) {
  const absolute = path.resolve(destination);
  // CI evidence lives in its checked-out workspace until uploaded as artifacts.
  const roots = ['/mnt/workspace', process.env.GITHUB_WORKSPACE].filter(Boolean);
  const inside = (value) => roots.some((root) => value === root || value.startsWith(`${root}/`));
  if (!inside(absolute)) throw new Error(`output outside persistent workspace: ${absolute}`);
  let existing = absolute;
  for (;;) {
    try {
      if (!inside(await fs.realpath(existing))) throw new Error('output resolves outside persistent workspace');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      existing = path.dirname(existing);
    }
  }
  await fs.mkdir(absolute, { recursive: true });
  if (!inside(await fs.realpath(absolute))) throw new Error('output resolves outside persistent workspace');
  return absolute;
}

function stats(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (p) => sorted.length ? rounded(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]) : null;
  return { count: values.length, totalMs: rounded(values.reduce((n, v) => n + v, 0)), medianMs: at(0.5), p95Ms: at(0.95) };
}

function selectSamples(report, app, count, analyzeFunctionSymbol) {
  const owners = new Map();
  const starts = new Set(Array.from(app.symbols.funcs || [], String));
  for (const cls of report?.classes || []) {
    if (!cls.className) continue;
    for (const slot of cls.slots || []) {
      if (slot.address == null || slot.unresolved || !starts.has(String(slot.address))) continue;
      const key = String(slot.address);
      const names = owners.get(key) || new Set();
      names.add(cls.className);
      owners.set(key, names);
    }
  }
  // Partial RTTI can still have canonical constructor/destructor/const member
  // proof. Reuse that existing symbol classifier for sample selection only.
  for (let i = 0; i < app.symbols.names.length; i++) {
    const address = app.symbols.addrs[i];
    if (address == null || !starts.has(String(address)) || owners.has(String(address))) continue;
    const info = analyzeFunctionSymbol(app.symbols.names[i]);
    if (info.className && (info.isConstructor || info.isDestructor || info.isConstMember) && !info.isAdjustedThunk) {
      owners.set(String(address), new Set([info.className]));
    }
  }
  const candidates = [...owners].filter(([, names]) => names.size === 1)
    .map(([address, names]) => ({ address: BigInt(address), className: [...names][0] }))
    .filter((s) => app.executableRegionFor(s.address))
    .sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  const size = Math.min(count, candidates.length);
  const samples = Array.from({ length: size }, (_, i) => candidates[Math.floor(i * candidates.length / size)]);
  return { total: candidates.length, samples };
}

async function measure(repo, options, binaryBytes) {
  const modules = await Promise.all([
    load(repo, 'tools/validation/public-benchmark/product-host.mjs'),
    load(repo, 'js/analysis/query/app-adapter.js'), load(repo, 'js/analysis/cxx/project.js'),
    load(repo, 'js/binary/index.js'), load(repo, 'js/pinpoint.js'), load(repo, 'js/goals.js'),
    load(repo, 'js/analysis/cxx/object-evidence.js'), load(repo, 'js/ir.js'),
  ]);
  const [host, adapter, cxx, binary, pinpoint, goals, canonical, irModule] = modules;
  const supported = typeof adapter.cxxMemberIndexForApp === 'function';
  const getIndex = (app) => supported ? adapter.cxxMemberIndexForApp(app) : null;
  const run = { repo, sha: sha(repo), publicationSupported: supported, failures: [], samples: [], timings: {} };
  const product = await host.openProduct(options.binary);
  if (product.unsupported) {
    return { ...run, status: 'insufficient-recovery', reason: product.reason };
  }
  let restorePublication = () => {};
  try {
    run.architecture = product.architecture;
    run.timings.setup = product.profile;
    const image = binary.openBinary(binaryBytes);
    const read = (address, length) => {
      const offset = image.addressToOffset?.(address);
      if (offset == null) return null;
      const start = Number(offset);
      return Number.isSafeInteger(start) && start >= 0 && start < binaryBytes.length
        ? binaryBytes.subarray(start, Math.min(start + length, binaryBytes.length)) : null;
    };
    const selector = cxx.createCxxEvidenceProvider({ symbols: product.app.symbols, read,
      pointerBytes: product.architecture === 'arm64_32' ? 4 : 8, architecture: product.architecture,
      maxClasses: 2500, maxSlots: 128, maxReads: 8192 });
    const selectionStart = performance.now();
    await selector.build();
    const classifier = (await load(ROOT, 'js/analysis/cxx/object-evidence.js')).analyzeFunctionSymbol;
    const selection = selectSamples(selector.classEvidence(), product.app, options.sample, classifier);
    run.selection = { total: selection.total, addresses: selection.samples.map((s) => String(s.address)), classes: selector.stats() };
    run.timings.selectionMs = rounded(performance.now() - selectionStart);
    await product.app.ensureObjc(product.sliceIndex);
    const snapshot = await product.query.snapshot();
    const pin = () => pinpoint.pinpointField({ goal: goals.parseGoal(options.query),
      fields: product.app.fields, cxxFields: getIndex(product.app), limit: 400 });
    const before = await pin();
    run.before = { candidateCount: before.candidates.length, universe: before.universe, verdict: before.verdict, missing: before.missing };
    const publicationTimes = [];
    if (supported) {
      const { CxxMemberIndex } = await load(repo, 'js/analysis/cxx/member-index.js');
      const original = CxxMemberIndex.prototype.publish;
      CxxMemberIndex.prototype.publish = function (...args) {
        const start = performance.now();
        try { return original.apply(this, args); } finally {
          if (this === getIndex(product.app)) publicationTimes.push(performance.now() - start);
        }
      };
      restorePublication = () => { CxxMemberIndex.prototype.publish = original; };
    }
    for (const sample of selection.samples) {
      const row = { address: String(sample.address), expectedClass: sample.className,
        receiverProven: false, recoveredMembers: 0, pseudocode: false, error: null };
      const started = performance.now();
      try {
        const result = await product.query.decompile(snapshot, sample.address, { profile: 'fast' });
        row.pseudocode = Boolean(result?.value?.pseudocode);
      } catch (error) { row.error = error.message; }
      row.decompileMs = rounded(performance.now() - started);
      // Diagnose recovery from the same already-analyzed model, outside the
      // timed production route. No new disassembly or full-binary sweep.
      try {
        const fn = await product.query.function(snapshot, sample.address, { profile: 'fast', texts: false });
        const model = fn?.value?.model;
        if (model) {
          const projection = selector.projectForFunction({ functionAddress: sample.address,
            functionName: product.app.symbols.nameAt(sample.address), ir: irModule.irFor(model) });
          row.receiverProven = Boolean(projection?.receiver);
          row.recoveredMembers = projection?.members.length || 0;
          row.unsupportedMembers = (projection?.members || []).filter((m) => m.mixedWidths || m.indexed || !m.sizeBytes).length;
        }
      } catch (error) { row.recoveryError = error.message; }
      run.samples.push(row);
    }
    run.timings.fastDecompile = stats(run.samples.map((s) => s.decompileMs));
    run.timings.publication = stats(publicationTimes);
    const index = getIndex(product.app);
    const classEntries = [...(index?.classes.values() || [])];
    const entries = classEntries.flatMap((cls) => cls.ivars.map((iv) => ({ cls, iv })));
    const keys = new Set();
    let named = 0, truncated = 0;
    const expectedByAddress = new Map(selection.samples.map((s) => [String(s.address), s.className]));
    for (const { cls, iv } of entries) {
      if (keys.has(iv.key)) run.failures.push(`duplicate-key:${iv.key}`);
      keys.add(iv.key);
      if (!iv.anonymous) named++;
      if (iv.provenanceTruncated) truncated++;
      if (!Array.isArray(iv.provenance) || !iv.provenance.length) {
        run.failures.push(`missing-provenance:${iv.key}`);
        continue;
      }
      for (const { receiver, member } of iv.provenance) {
        const expectedClass = expectedByAddress.get(String(receiver.functionAddress));
        const identity = receiver.classIdentity;
        const ownerMatches = identity.kind === 'named'
          ? cls.name === identity.className && (!expectedClass || expectedClass === cls.name)
          : cls.classIdentity.kind === 'anonymous' && cls.classIdentity.vtableAddress === identity.vtableAddress
            && cls.classIdentity.typeinfoAddress === identity.typeinfoAddress;
        if (!canonical.isCanonicalCppReceiverEvidence(receiver) || !canonical.isCanonicalCppMemberEvidence(member)
          || member.receiverDigest !== receiver.digest || member.functionId !== receiver.functionId
          || member.snapshotId !== receiver.snapshotId || member.snapshotId !== index.snapshotId
          || member.offsetBytes !== BigInt(iv.offset) || member.sizeBytes !== iv.size
          || member.category !== iv.recoveredType.category || member.typeLabel !== iv.recoveredType.label
          || !ownerMatches) {
          run.failures.push(`wrong-binding-or-ownership:${iv.key}`);
        }
      }
    }
    const pinStart = performance.now();
    const result = await pin();
    run.timings.pinpointMs = rounded(performance.now() - pinStart);
    for (const c of result.candidates) {
      if (c.source === 'cxx' && (!keys.has(c.key) || !entries.some(({ iv }) => iv === c.field)
        || !Number.isFinite(c.fusion.logOdds))) run.failures.push(`candidate-not-in-lattice:${c.key}`);
    }
    run.after = { candidateCount: result.candidates.length, cxxCandidateCount: result.candidates.filter((c) => c.source === 'cxx').length,
      universe: result.universe, verdict: result.verdict, top: result.top?.key ?? null,
      classCount: index?.classCount || 0, memberCount: entries.length,
      named, unnamed: entries.length - named, truncatedProvenanceMembers: truncated,
      keyCollisions: entries.length - keys.size,
      candidatesTruncated: entries.length > result.candidates.length };
    if (supported && entries.length && !run.after.cxxCandidateCount) run.failures.push('publication-not-reachable');
    run.status = run.failures.length ? 'fail' : supported
      ? (run.after.cxxCandidateCount ? 'pass' : 'insufficient-recovery') : 'baseline';
    return run;
  } finally { restorePublication(); await product.close(); }
}

async function main() {
  const options = optionsFor(process.argv.slice(2));
  const directory = await persistentDirectory(path.dirname(options.output));
  const bytes = await fs.readFile(options.binary);
  const report = { schema: 'hex-pinpoint-cxx-member-validation/v1', node: process.version,
    command: process.argv.slice(2), verifierSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
    binary: { sha256: hash(bytes), bytes: bytes.length }, query: options.query };
  if (options.compareRepo) report.baseline = await measure(path.resolve(options.compareRepo), options, bytes);
  report.current = await measure(path.resolve(options.repo), options, bytes);
  if (report.baseline) {
    report.sameSamples = JSON.stringify(report.baseline.selection?.addresses) === JSON.stringify(report.current.selection?.addresses);
    if (!report.sameSamples) report.current.failures.push('baseline-sample-mismatch');
    const successful = new Set(report.baseline.samples.filter((s) => s.pseudocode).map((s) => s.address));
    for (const row of report.current.samples) {
      if (!row.pseudocode && successful.has(row.address)) report.current.failures.push(`decompile-regression:${row.address}`);
    }
  }
  report.status = report.current.status === 'pass' && !report.current.failures.length ? 'pass' : report.current.status;
  if (report.current.failures.length) report.status = 'fail';
  const output = path.join(directory, path.basename(options.output));
  const pending = `${output}.pending-${process.pid}`;
  await fs.writeFile(pending, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  await fs.rename(pending, output);
  console.log(JSON.stringify({ status: report.status, sha: report.current.sha,
    binarySha256: report.binary.sha256, before: report.current.before, after: report.current.after,
    timings: report.current.timings, failures: report.current.failures }));
  if (!['pass', 'baseline'].includes(report.status)) process.exitCode = 1;
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
