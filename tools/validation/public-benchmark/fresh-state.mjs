import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const FRESH_RECEIPT_SCHEMA = 'hex-public-benchmark-function-receipt/v1';
export const FRESH_SESSION_SCHEMA = 'hex-public-benchmark-fresh-session/v1';
export const FRESH_CONFIG_SCHEMA = 'hex-public-benchmark-fresh-config/v1';
export const TERMINAL_FUNCTION_STATES = new Set(['PASS', 'PARTIAL', 'TRUNCATED', 'UNSUPPORTED', 'TIMEOUT', 'CRASH']);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

export function stableJson(value) {
  return JSON.stringify(stable(value));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function configDigest(config) {
  return sha256(stableJson({ schema:FRESH_CONFIG_SCHEMA, ...config }));
}

export function receiptIdentity({ caseId, binarySha256, sourceIdentity, configHash, architecture, endianness }) {
  return Object.freeze({
    schema:FRESH_RECEIPT_SCHEMA,
    caseId:String(caseId),
    binarySha256:String(binarySha256),
    sourceIdentity:String(sourceIdentity),
    configHash:String(configHash),
    architecture:String(architecture || 'unknown').toLowerCase(),
    endianness:String(endianness || 'unknown').toLowerCase(),
  });
}

export function sameReceiptIdentity(receipt, identity) {
  return receipt?.schema === FRESH_RECEIPT_SCHEMA
    && receipt.caseId === identity.caseId
    && receipt.binarySha256 === identity.binarySha256
    && receipt.sourceIdentity === identity.sourceIdentity
    && receipt.configHash === identity.configHash
    && receipt.architecture === identity.architecture
    && receipt.endianness === identity.endianness;
}

export function receiptFileName(address) {
  const canonical = String(address);
  return `${sha256(canonical).slice(0, 24)}.json`;
}

export function atomicWriteJson(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive:true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag:'wx' });
  fs.renameSync(temporary, target);
}

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

export function writeReceipt(receiptDir, identity, fn, result) {
  const address = String(fn.address);
  const file = path.join(receiptDir, receiptFileName(address));
  const row = {
    ...identity,
    functionAddress:address,
    functionIndex:Number(fn.index),
    functionName:fn.name ?? null,
    functionEnd:fn.end == null ? null : String(fn.end),
    state:String(result.state),
    hard:result.hard === true ? true : undefined,
    completeness:result.completeness ?? null,
    reason:result.reason ?? null,
    elapsedMs:Number(result.elapsedMs ?? 0),
    resultDigest:String(result.resultDigest),
    result:result.functionResult,
    completedAt:new Date().toISOString(),
  };
  atomicWriteJson(file, row);
  return row;
}

export function loadReceipt(receiptDir, identity, address) {
  const row = readJson(path.join(receiptDir, receiptFileName(address)));
  if (!row || !sameReceiptIdentity(row, identity)) return null;
  if (row.functionAddress !== String(address) || !TERMINAL_FUNCTION_STATES.has(row.state)) return null;
  if (!row.result || typeof row.result !== 'object' || String(row.result.address) !== String(address)) return null;
  const digest = sha256(stableJson(row.result));
  if (digest !== row.resultDigest) return null;
  return row;
}

export function shouldReuseReceipt(receipt, retryStates = new Set()) {
  return !!receipt && TERMINAL_FUNCTION_STATES.has(receipt.state) && !retryStates.has(receipt.state);
}

export function semanticFunctionDigest(fn) {
  const semantic = {
    address:String(fn.address),
    name:fn.name ?? null,
    end:fn.end == null ? null : String(fn.end),
    state:fn.state,
    completeness:fn.completeness ?? null,
    reason:fn.reason ?? null,
    pseudocode:fn.pseudocode ?? null,
    translationUnit:fn.translationUnit ?? null,
    provenance:fn.provenance ?? null,
  };
  return sha256(stableJson(semantic));
}

export function semanticSubjectDigest(subject) {
  const semantic = {
    schema:subject.schema,
    state:subject.state,
    reason:subject.reason ?? null,
    inputSha256:subject.inputSha256 ?? null,
    productRoute:subject.productRoute ?? null,
    functionDiscoveryComplete:subject.functionDiscoveryComplete === true,
    functions:(subject.functions || []).map(fn => ({
      address:String(fn.address),
      name:fn.name ?? null,
      end:fn.end == null ? null : String(fn.end),
      state:fn.state,
      completeness:fn.completeness ?? null,
      reason:fn.reason ?? null,
      pseudocode:fn.pseudocode ?? null,
      translationUnit:fn.translationUnit ?? null,
      provenance:fn.provenance ?? null,
    })),
  };
  return sha256(stableJson(semantic));
}


export function captureSourceIdentity({ repoRoot = process.cwd(), gitExec = execFileSync } = {}) {
  const root = path.resolve(repoRoot);
  try {
    const options = { cwd:root, encoding:'utf8', stdio:['ignore', 'pipe', 'pipe'], timeout:10000 };
    const head = gitExec('git', ['rev-parse', 'HEAD'], options).trim();
    if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error('source-head-invalid');
    const status = String(gitExec('git', [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--',
      'js', 'tools/validation/public-benchmark', 'package.json', 'package-lock.json',
      'capstone.js', 'capstone.wasm', 'worker-entry.js', 'worker.js',
    ], options));
    const dirty = [];
    for (const entry of status.split('\0').filter(Boolean)) {
      const state = entry.slice(0, 2);
      const relative = entry.slice(3);
      const file = path.join(root, relative);
      let digest = 'missing';
      try { if (fs.statSync(file).isFile()) digest = sha256(fs.readFileSync(file)); }
      catch {}
      dirty.push([state, relative.split(path.sep).join('/'), digest]);
    }
    return { kind:'git-worktree', head, dirty, identity:sha256(stableJson({ head, dirty })) };
  } catch {
    const roots = ['js', 'tools/validation/public-benchmark'];
    const files = ['package.json'];
    for (const relativeRoot of roots) {
      const absoluteRoot = path.join(root, relativeRoot);
      if (!fs.existsSync(absoluteRoot)) continue;
      const stack = [absoluteRoot];
      while (stack.length) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes:true })) {
          const absolute = path.join(current, entry.name);
          if (entry.isDirectory()) stack.push(absolute);
          else if (entry.isFile() && /\.(?:js|mjs|json)$/.test(entry.name)) files.push(path.relative(root, absolute));
        }
      }
    }
    const rows = [...new Set(files)].sort().map(relative => {
      const absolute = path.join(root, relative);
      return [relative.split(path.sep).join('/'), fs.existsSync(absolute) ? sha256(fs.readFileSync(absolute)) : 'missing'];
    });
    return { kind:'content-fallback', head:null, dirty:[], identity:sha256(stableJson(rows)) };
  }
}

export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).slice().sort((a,b)=>a-b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}
