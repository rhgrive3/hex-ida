#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSubjectOutput, SUBJECT_RESULT_SCHEMA } from './outcome.mjs';

const SUBJECT_PATH = fileURLToPath(new URL('./subject.mjs', import.meta.url));
const HARD_STATES = new Set(['CRASH', 'TIMEOUT', 'ERROR']);

export function normalizeSubjectCompletion({ stdout, code, signal, timed = false, error = null, stderr = '' }) {
  let row;
  if (timed) {
    row = { schema: SUBJECT_RESULT_SCHEMA, state: 'TIMEOUT', reason: 'subject-timeout', functions: [] };
  } else if (error) {
    row = {
      schema: SUBJECT_RESULT_SCHEMA,
      state: 'ERROR',
      reason: `subject-spawn-error:${error.code || error.name || 'unknown'}`,
      functions: [],
    };
  } else if (signal) {
    row = {
      schema: SUBJECT_RESULT_SCHEMA,
      state: 'CRASH',
      reason: `subject-signal:${signal}`,
      functions: [],
    };
  } else {
    const parsed = parseSubjectOutput(stdout);
    if (parsed.error) {
      row = { schema: SUBJECT_RESULT_SCHEMA, state: 'ERROR', reason: parsed.error, functions: [] };
    } else {
      row = parsed.result;
      const reportedState = parsed.reportedState;
      const expectedExitCode = reportedState === 'UNSUPPORTED' ? 2
        : reportedState === 'PASS' ? 0
          : 1;
      const functionFailurePromoted = reportedState === 'PASS'
        && (row.state === 'CRASH' || row.state === 'TIMEOUT');
      if (code !== expectedExitCode && !(functionFailurePromoted && code === 1)) {
        row = {
          ...row,
          state: 'ERROR',
          reason: `subject-exit-status-mismatch:${String(code)}`,
          subjectReportedState: reportedState,
        };
      }
    }
  }

  return {
    ...row,
    subjectExitCode: code ?? null,
    subjectSignal: signal ?? null,
    stderr: String(stderr).slice(-4000),
  };
}

export function runCase({ binary, out, timeout = 120000, spawnChild = spawn, subjectPath = SUBJECT_PATH } = {}) {
  if (!binary || !out) throw new Error('run-case requires binary and output');
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 900000) throw new Error('invalid timeout');

  const output = path.resolve(out);
  const temporary = `${output}.tmp-${process.pid}-${randomUUID()}`;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.rmSync(output, { force: true });

  return new Promise((resolve, reject) => {
    let child;
    let stdout = '';
    let stderr = '';
    let timed = false;
    let settled = false;
    let timer = null;
    const cap = 8 * 1024 * 1024;
    const append = (current, chunk) => {
      const next = current + chunk.toString();
      return next.length > cap ? next.slice(-cap) : next;
    };

    const finish = (completion) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const row = normalizeSubjectCompletion({ ...completion, stdout, stderr });
      try {
        fs.writeFileSync(temporary, `${JSON.stringify(row, null, 2)}\n`, { flag: 'wx' });
        fs.renameSync(temporary, output);
        resolve({ row, exitCode: HARD_STATES.has(row.state) ? 1 : 0 });
      } catch (writeError) {
        fs.rmSync(temporary, { force: true });
        reject(writeError);
      }
    };

    try {
      child = spawnChild(process.execPath, [subjectPath, binary], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HEX_PUBLIC_BENCH_OFFLINE: '1' },
      });
    } catch (error) {
      finish({ error });
      return;
    }

    if (!child?.stdout?.on || !child?.stderr?.on || !child?.once) {
      finish({ error: Object.assign(new Error('invalid-child-process'), { code: 'INVALID_CHILD_PROCESS' }) });
      return;
    }

    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.once('error', error => finish({ error }));
    child.once('close', (code, signal) => finish({ code, signal, timed }));
    timer = setTimeout(() => {
      timed = true;
      try { child.kill('SIGKILL'); } catch {}
      finish({ timed: true });
    }, timeout);
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [, , binary, out, timeoutRaw = '120000'] = process.argv;
  try {
    const result = await runCase({ binary, out, timeout: Number(timeoutRaw) });
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = !binary || !out || String(error?.message).includes('timeout') ? 2 : 1;
  }
}
