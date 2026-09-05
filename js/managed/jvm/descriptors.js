const BASE_TYPES = new Set(['B', 'C', 'D', 'F', 'I', 'J', 'S', 'Z']);

function fail(code) { throw new TypeError(code); }

function parseFieldType(descriptor, start, code) {
  if (typeof descriptor !== 'string' || start >= descriptor.length) fail(code);
  const tag = descriptor[start];
  if (BASE_TYPES.has(tag)) return { next: start + 1, type: Object.freeze({ kind: 'base', tag }) };
  if (tag === 'L') {
    const end = descriptor.indexOf(';', start + 1);
    if (end <= start + 1) fail(code);
    return {
      next: end + 1,
      type: Object.freeze({ kind: 'object', className: descriptor.slice(start + 1, end) }),
    };
  }
  if (tag === '[') {
    let dimensions = 0;
    let pos = start;
    while (descriptor[pos] === '[') {
      dimensions++;
      if (dimensions > 255) fail(code);
      pos++;
    }
    const component = parseFieldType(descriptor, pos, code);
    return {
      next: component.next,
      type: Object.freeze({ kind: 'array', dimensions, component: component.type }),
    };
  }
  fail(code);
}

export function parseJvmFieldDescriptor(descriptor) {
  const code = 'jvm-invalid-field-descriptor';
  if (typeof descriptor !== 'string' || descriptor.length === 0) fail(code);
  const parsed = parseFieldType(descriptor, 0, code);
  if (parsed.next !== descriptor.length) fail(code);
  return Object.freeze({ kind: 'field', descriptor, type: parsed.type });
}

export function parseJvmMethodDescriptor(descriptor) {
  const code = 'jvm-invalid-method-descriptor';
  if (typeof descriptor !== 'string' || descriptor[0] !== '(') fail(code);
  let pos = 1;
  const parameters = [];
  while (pos < descriptor.length && descriptor[pos] !== ')') {
    const parsed = parseFieldType(descriptor, pos, code);
    parameters.push(parsed.type);
    pos = parsed.next;
  }
  if (pos >= descriptor.length || descriptor[pos] !== ')') fail(code);
  pos++;
  if (pos >= descriptor.length) fail(code);
  let returnType = null;
  if (descriptor[pos] === 'V') pos++;
  else {
    const parsed = parseFieldType(descriptor, pos, code);
    returnType = parsed.type;
    pos = parsed.next;
  }
  if (pos !== descriptor.length) fail(code);
  return Object.freeze({ kind: 'method', descriptor, parameters: Object.freeze(parameters), returnType });
}
