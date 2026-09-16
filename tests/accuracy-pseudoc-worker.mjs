import { NodeBackend, openBinary } from './harness.mjs';
import { evaluatePseudocSample } from './accuracy-pseudoc-eval.mjs';

const target = process.argv[2];
if (!target || typeof process.send !== 'function') {
  throw new Error('accuracy-pseudoc-worker must be started with IPC and a target path');
}

const bootStart = Date.now();
// Pseudoc scoring consumes per-function analysis, region geometry and symbol
// lookup only. Skip the expensive global program/string indexes in this
// process-local worker boot, then restore the prototype before serving tasks.
const originalScanProgram = NodeBackend.prototype.scanProgram;
NodeBackend.prototype.scanProgram = async () => null;
let world;
try {
  world = await openBinary(target, { strings: false });
} finally {
  NodeBackend.prototype.scanProgram = originalScanProgram;
}
process.send({ type: 'ready', bootMs: Date.now() - bootStart });

process.on('message', async (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'stop') {
    process.disconnect();
    return;
  }
  if (message.type !== 'task') return;

  const { index, a, end } = message;
  const started = Date.now();
  try {
    const result = await evaluatePseudocSample(world, [Number(a), Number(end)]);
    process.send({
      type: 'result',
      index,
      a,
      end,
      ...result,
      elapsedMs: Date.now() - started,
    });
  } catch (error) {
    process.send({
      type: 'fatal',
      index,
      message: error?.stack || error?.message || String(error),
    });
  }
});
