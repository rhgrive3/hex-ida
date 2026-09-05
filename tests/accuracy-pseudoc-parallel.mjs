import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const HERE = path.dirname(THIS_FILE);

function option(argv, name, fallback) {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function workerCount(raw, name) {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) {
    throw new TypeError(`accuracy-pseudoc-${name}-invalid`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 4) {
    throw new RangeError(`accuracy-pseudoc-${name}-out-of-range`);
  }
  return value;
}

export function workerConfiguration(argv) {
  const initialWorkers = workerCount(option(argv, 'workers', '4'), 'workers');
  const maxWorkers = workerCount(option(argv, 'max-workers', String(initialWorkers)), 'max-workers');
  const scaleFile = option(argv, 'scale-file', null);
  if (maxWorkers < initialWorkers) {
    throw new RangeError('accuracy-pseudoc-max-workers-below-initial');
  }
  if (maxWorkers > initialWorkers && !scaleFile) {
    throw new TypeError('accuracy-pseudoc-scale-file-required');
  }
  return { initialWorkers, maxWorkers, scaleFile };
}

export function pseudocTaskOrder(samples) {
  return samples.map(([a, end], index) => ({ index, a, end }))
    .sort((left, right) => {
      const leftBytes = left.end - left.a;
      const rightBytes = right.end - right.a;
      return rightBytes - leftBytes || left.index - right.index;
    });
}

function selfTest() {
  assert.deepEqual(workerConfiguration([]), {
    initialWorkers: 4,
    maxWorkers: 4,
    scaleFile: null,
  });
  assert.deepEqual(workerConfiguration([
    '--workers=3',
    '--max-workers=4',
    '--scale-file=/tmp/nonpseudoc.done',
  ]), {
    initialWorkers: 3,
    maxWorkers: 4,
    scaleFile: '/tmp/nonpseudoc.done',
  });
  assert.throws(() => workerConfiguration(['--workers=0']), /workers-invalid/);
  assert.throws(() => workerConfiguration(['--workers=5']), /workers-out-of-range/);
  assert.throws(
    () => workerConfiguration(['--workers=3', '--max-workers=2']),
    /max-workers-below-initial/,
  );
  assert.throws(
    () => workerConfiguration(['--workers=3', '--max-workers=4']),
    /scale-file-required/,
  );
  assert.deepEqual(
    pseudocTaskOrder([[0, 4], [10, 30], [40, 52], [60, 80]]).map(({ index }) => index),
    [1, 3, 2, 0],
    'pseudoc tasks must be scheduled longest-span first with canonical index tie-breaks',
  );
  console.log('accuracy pseudoc elastic-worker configuration self-test passed');
}

async function run(argv) {
  if (argv.includes('--self-test')) {
    selfTest();
    return;
  }

  const target = option(argv, 'target', null);
  const oraclePath = option(argv, 'oracle', null);
  const { initialWorkers, maxWorkers, scaleFile } = workerConfiguration(argv);
  const json = argv.includes('--json');
  if (!target || !oraclePath) {
    const error = new TypeError(
      'usage: node tests/accuracy-pseudoc-parallel.mjs ' +
      '--target=<binary> --oracle=<oracle.json.gz> ' +
      '[--workers=4] [--max-workers=4 --scale-file=<path>] [--json]',
    );
    error.exitCode = 2;
    throw error;
  }

  const [{ pseudocSamples }, { pseudocResult }] = await Promise.all([
    import('./accuracy-pseudoc-shard-oracle.mjs'),
    import('./accuracy-pseudoc-eval.mjs'),
  ]);
  const zlib = await import('node:zlib');
  const oracle = JSON.parse(zlib.gunzipSync(fs.readFileSync(oraclePath)).toString('utf8'));
  if (!Array.isArray(oracle.functionStarts)) throw new Error('oracle.functionStarts is required');
  const samples = pseudocSamples(oracle.functionStarts);
  if (samples.length !== 120) {
    throw new Error(`expected the canonical 120 pseudoc samples, got ${samples.length}`);
  }

  const tasks = pseudocTaskOrder(samples);
  let next = 0;
  let finished = 0;
  let lines = 0;
  let asmLines = 0;
  let done = 0;
  let failed = null;
  let workerSequence = 0;
  let scaleTimer = null;
  const seen = new Set();
  const timings = [];
  const children = new Set();
  const started = Date.now();

  function assign(child, onError) {
    if (failed || next >= tasks.length) return false;
    const { index, a, end } = tasks[next++];
    try {
      child.send({ type: 'task', index, a, end }, (error) => {
        if (error && !failed && finished < samples.length) onError(error);
      });
    } catch (error) {
      onError(error);
      return false;
    }
    return true;
  }

  function disconnectChild(child) {
    if (!child.connected) return;
    try { child.disconnect(); } catch { /* channel may close between check and disconnect */ }
  }

  function disconnectAll() {
    for (const child of children) disconnectChild(child);
  }

  function shutdown() {
    for (const child of children) {
      try { child.kill('SIGTERM'); } catch { /* best effort */ }
    }
  }

  function clearScaleTimer() {
    if (scaleTimer == null) return;
    clearInterval(scaleTimer);
    scaleTimer = null;
  }

  const completion = new Promise((resolve, reject) => {
    const fail = (error) => {
      if (failed) return;
      failed = error instanceof Error ? error : new Error(String(error));
      clearScaleTimer();
      shutdown();
      reject(failed);
    };

    const finish = () => {
      clearScaleTimer();
      disconnectAll();
      resolve();
    };

    function spawnWorker() {
      if (failed || children.size >= maxWorkers || next >= tasks.length) return false;
      const worker = workerSequence++;
      let child;
      try {
        child = fork(path.join(HERE, 'accuracy-pseudoc-worker.mjs'), [target], {
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          execArgv: ['--max-old-space-size=2600'],
        });
      } catch (error) {
        fail(error);
        return false;
      }
      children.add(child);
      child.stderr.on('data', (chunk) => {
        process.stderr.write(`[pseudoc worker ${worker}] ${chunk}`);
      });

      child.on('error', (error) => {
        if (!failed && finished < samples.length) fail(error);
      });

      child.on('message', (message) => {
        if (!message || failed) return;
        if (message.type === 'ready') {
          process.stderr.write(`pseudoc worker ${worker} ready in ${message.bootMs}ms\n`);
          assign(child, fail);
          return;
        }
        if (message.type === 'fatal') {
          fail(new Error(`pseudoc worker ${worker} failed sample ${message.index}: ${message.message}`));
          return;
        }
        if (message.type !== 'result') return;

        const index = Number(message.index);
        if (!Number.isSafeInteger(index) || index < 0 || index >= samples.length) {
          fail(new Error(`out-of-range pseudoc result index: ${message.index}`));
          return;
        }
        const [expectedA, expectedEnd] = samples[index];
        if (Number(message.a) !== expectedA || Number(message.end) !== expectedEnd) {
          fail(new Error(`pseudoc sample identity mismatch at index ${index}`));
          return;
        }
        if (seen.has(index)) {
          fail(new Error(`duplicate pseudoc result for sample ${index}`));
          return;
        }
        seen.add(index);
        lines += Number(message.lines) || 0;
        asmLines += Number(message.asmLines) || 0;
        done += Number(message.done) || 0;
        finished++;
        timings.push({
          index,
          addr: `0x${expectedA.toString(16)}`,
          bytes: expectedEnd - expectedA,
          elapsedMs: Number(message.elapsedMs) || 0,
          analyzeMs: Number(message.analyzeMs) || 0,
          decompileMs: Number(message.decompileMs) || 0,
        });

        if (finished === samples.length) {
          // Workers that run out of queued tasks remain idle but connected until
          // the last in-flight function completes. Disconnect once, here, rather
          // than sending repeated stop messages to channels that may already be
          // closing (the old scheme caused ERR_IPC_CHANNEL_CLOSED on YWP).
          finish();
        } else {
          assign(child, fail);
        }
      });

      child.on('exit', (code, signal) => {
        children.delete(child);
        if (!failed && finished < samples.length) {
          fail(new Error(`pseudoc worker ${worker} exited early (${code ?? signal ?? 'unknown'})`));
        }
      });
      return true;
    }

    function scaleIfReady() {
      if (failed || finished >= samples.length || !scaleFile || !fs.existsSync(scaleFile)) return;
      while (children.size < maxWorkers && next < tasks.length) {
        if (!spawnWorker()) break;
      }
      if (children.size >= maxWorkers) clearScaleTimer();
    }

    for (let worker = 0; worker < initialWorkers; worker++) spawnWorker();
    if (scaleFile && maxWorkers > initialWorkers) {
      scaleIfReady();
      if (children.size < maxWorkers) scaleTimer = setInterval(scaleIfReady, 100);
    }
  });

  try {
    await completion;
  } catch (error) {
    throw error;
  }

  if (seen.size !== samples.length) {
    throw new Error(`pseudoc coverage mismatch: ${seen.size}/${samples.length}`);
  }
  for (let index = 0; index < samples.length; index++) {
    if (!seen.has(index)) throw new Error(`pseudoc coverage missing sample ${index}`);
  }

  const elapsed = Date.now() - started;
  const slowest = timings.slice().sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 8);
  for (const timing of slowest) {
    process.stderr.write(
      `pseudoc sample ${timing.index} ${timing.addr} ${timing.bytes}B: ${timing.elapsedMs}ms ` +
      `(analyze=${timing.analyzeMs}ms decompile=${timing.decompileMs}ms)\n`,
    );
  }

  const result = {
    id: 'pseudoc',
    label: '逆コンパイルで訳せない命令が残らない',
    ...pseudocResult(lines, asmLines, done, elapsed),
  };
  if (json) console.log(JSON.stringify([result], null, 2));
  else console.log(`${(result.score * 100).toFixed(1)}%  ${result.label}  ${result.detail}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(THIS_FILE)) {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  }
}
