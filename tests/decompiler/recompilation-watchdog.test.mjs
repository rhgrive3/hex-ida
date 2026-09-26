import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCaseWithWatchdog } from '../../reports/investigations/current-main-weakness-20260923/harness/measure-functions.mjs';
import { readJson, receiptFileName } from '../../reports/investigations/current-main-weakness-20260923/harness/lib.mjs';

test('hard watchdog timeout receipt keeps run identity so restart retains TIMEOUT and advances', { timeout: 6000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-recompilation-watchdog-test-'));
  try {
    const outDir = root;
    const receiptDir = path.join(root, 'receipts');
    fs.mkdirSync(receiptDir, { recursive:true });
    const fakeWorkerPath = path.join(root, 'fake-case-worker.mjs');
    const attemptsPath = path.join(root, 'stuck-attempts');
    fs.writeFileSync(fakeWorkerPath, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { createHash } from 'node:crypto';",
      'const args = process.argv.slice(2);',
      "const arg = name => args[args.indexOf(name) + 1];",
      "const caseId = arg('--case-id');",
      "const outDir = arg('--out');",
      "const receiptDir = arg('--receipt-dir');",
      "const inflight = arg('--inflight');",
      "const sourceIdentity = arg('--source-id');",
      "const configHash = arg('--config-hash');",
      "const headSha = arg('--head');",
      `const attemptsPath = ${JSON.stringify(attemptsPath)};`,
      "const schema = 'hex-current-main-harness-function/v1';",
      "const receiptName = address => createHash('sha256').update(String(address)).digest('hex').slice(0, 24) + '.json';",
      "const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };",
      "const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file, JSON.stringify(value)); };",
      "const functions = [{ address:'1000', name:'quick_a' }, { address:'2000', name:'busy_once' }, { address:'3000', name:'quick_b' }];",
      'const rows = [];',
      'for (let index = 0; index < functions.length; index++) {',
      '  const fn = functions[index];',
      '  const receiptPath = path.join(receiptDir, receiptName(fn.address));',
      '  const prior = read(receiptPath);',
      '  if (prior?.schema === schema && prior.caseId === caseId && prior.sourceIdentity === sourceIdentity',
      '    && prior.configHash === configHash && prior.headSha === headSha) { rows.push(prior); continue; }',
      '  const startedAt = new Date().toISOString();',
      '  write(inflight, { caseId, address:fn.address, index, name:fn.name, startedAt });',
      "  if (process.send) process.send({ type:'function-start', address:fn.address, index, startedAt });",
      "  process.stdout.write(JSON.stringify({ type:'function-start', address:fn.address, index, startedAt }) + '\\n');",
      "  if (fn.address === '2000') {",
      "    const attempts = (fs.existsSync(attemptsPath) ? Number(fs.readFileSync(attemptsPath, 'utf8')) : 0) + 1;",
      '    fs.writeFileSync(attemptsPath, String(attempts));',
      '    if (attempts === 1) while (true) {}',
      '  }',
      "  const row = { schema, caseId, address:fn.address, index, name:fn.name, state:'PASS', elapsedMs:1, sourceIdentity, configHash, headSha };",
      '  write(receiptPath, row);',
      '  fs.rmSync(inflight, { force:true });',
      '  rows.push(row);',
      "  if (process.send) process.send({ type:'function-end', address:fn.address, index, elapsedMs:1, state:'PASS' });",
      "  process.stdout.write(JSON.stringify({ type:'function-end', address:fn.address, index, elapsedMs:1, state:'PASS' }) + '\\n');",
      '}',
      "const caseRecord = { schema:'hex-current-main-harness-case/v1', caseId, state:'MEASURED', functionCount:3, functions:rows, functionStates:{ PASS:2, TIMEOUT:1 } };",
      "write(path.join(outDir, 'cases', Buffer.from(caseId).toString('hex') + '.json'), caseRecord);",
    ].join('\n'));

    const sourceIdentity = 'source-identity';
    const configHash = 'config-hash';
    const headSha = '0123456789abcdef0123456789abcdef01234567';
    const started = performance.now();
    const result = await runCaseWithWatchdog({
      binary:'unused.bin', caseId:'watchdog-resume', outDir, receiptDir,
      sourceIdentity, configHash, headSha, functionTimeoutMs:150, functionTimeoutGraceMs:100,
      structure:'none', structureThresholdMs:250, workerPath:fakeWorkerPath,
    });

    const elapsedMs = performance.now() - started;
    const timedOut = readJson(path.join(receiptDir, receiptFileName('2000')));
    const completedAfterTimeout = readJson(path.join(receiptDir, receiptFileName('3000')));
    assert.equal(result.code, 0);
    assert.ok(elapsedMs < 4000, `watchdog restart took ${elapsedMs}ms`);
    assert.equal(Number(fs.readFileSync(attemptsPath, 'utf8')), 1, 'timed-out function must not be retried');
    assert.equal(timedOut.state, 'TIMEOUT');
    assert.equal(timedOut.hard, true);
    assert.equal(timedOut.name, 'busy_once');
    assert.equal(timedOut.sourceIdentity, sourceIdentity);
    assert.equal(timedOut.configHash, configHash);
    assert.equal(timedOut.headSha, headSha);
    assert.equal(completedAfterTimeout.state, 'PASS', 'worker must resume after the timeout');
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});
