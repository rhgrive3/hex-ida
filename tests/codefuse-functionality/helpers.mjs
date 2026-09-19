import { EventEmitter } from 'node:events';

// Minimal stand-in for a spawned child process. `onSpawn(child, command, args)`
// decides what the child does; nothing touches the real filesystem or network.
export function makeChild({ onSpawn } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
    return true;
  };
  child.once('close', () => {});
  queueMicrotask(() => onSpawn?.(child));
  return child;
}

// Child that emits bounded stderr and exits with a code.
export function failingChild({ stderr = 'x.c:1:1: error: boom\n', code = 1 } = {}) {
  return makeChild({
    onSpawn: (child) => queueMicrotask(() => {
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code, null);
    }),
  });
}

export function passingChild({ stdout = '', stderr = '' } = {}) {
  return makeChild({
    onSpawn: (child) => queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', 0, null);
    }),
  });
}

// Child that streams output but never exits, so a finite timeout must kill it.
export function hangingChild({ stdout = '' } = {}) {
  return makeChild({
    onSpawn: (child) => {
      if (stdout) queueMicrotask(() => child.stdout.emit('data', Buffer.from(stdout)));
    },
  });
}

// Program runner fake: returns a scripted run result without executing anything.
export function scriptedRun(results) {
  const queue = [...results];
  const calls = [];
  const impl = (binary, args) => {
    calls.push({ binary, args });
    const next = queue.shift() ?? { stdout: '', stderr: '', exitCode: 0, signal: null };
    return makeChild({
      onSpawn: (child) => queueMicrotask(() => {
        if (next.stdout) child.stdout.emit('data', Buffer.from(next.stdout));
        if (next.stderr) child.stderr.emit('data', Buffer.from(next.stderr));
        if (next.hang) return; // never closes
        child.emit('close', next.exitCode ?? 0, next.signal ?? null);
      }),
    });
  };
  impl.calls = calls;
  return impl;
}

export function jsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

export function toolCallResponse(name, args, { id = 'call_1' } = {}) {
  return jsonResponse({
    choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}
