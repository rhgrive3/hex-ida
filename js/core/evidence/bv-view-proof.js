/** A small proof checker, NOT an AST optimizer or a machine-semantic owner.
 * Checks typed bit-view identities and congruence of unchanged total operators.
 * It deliberately imports neither the production AST nor its rewrite rules.
 * Results concern an expression under the SAME symbolic inputs, never its
 * reachability, C rendering, an ISA instruction, or an entire function.
 */
import { stableStringify, lossyTypeWitness, deepFreeze } from '../identity/index.js';
import { snapshotContractData } from '../identity/structured.js';

export const BV_VIEW_PROOF_RULE = 'typed-bv-view-congruence';
export const BV_VIEW_PROOF_VERSION = '1.1.0';
const LIMITS = Object.freeze({ maxNodes: 4096, maxDepth: 48, maxBytes: 1048576, allowBigInt: true });
const EXTRA = new Set(['source', 'phase8Proof', 'phase8ValueId']);
const typed = value => stableStringify([value, lossyTypeWitness(value)]);
class Unhandled extends Error {}
function requireThat(condition, reason) { if (!condition) throw new Unhandled(reason); }
function fields(node, allowed) {
  requireThat(Object.keys(node).every(key => allowed.includes(key) || EXTRA.has(key)), 'unhandled-expression-field');
}
function width(node) {
  requireThat(Number.isSafeInteger(node.bits) && node.bits > 0 && node.bits <= 128, 'unsupported-bit-width');
  requireThat(node.signed === null || typeof node.signed === 'boolean', 'unbound-signed-view');
  return node.bits;
}
function shape(root, work, atoms, events, algebra) {
  const reserve = bytes => {
    requireThat(algebra.allocatedBytes + bytes <= 8 * 1024 * 1024, 'expression-normal-form-budget');
    algebra.allocatedBytes += bytes; work?.charge('residentBytes', bytes);
  };
  const internBit = (op, terms) => {
    const key = typed(['bit-algebra', op, terms]);
    if (!atoms.has(key)) { reserve(key.length * 2 + terms.length * 32 + 128); atoms.set(key, atoms.size); }
    const token = `b${atoms.get(key)}`; algebra.bits.set(token, { op, terms }); return token;
  };
  const combineBit = (op, a, b) => {
    const expand = x => algebra.bits.get(x)?.op === op ? algebra.bits.get(x).terms : [x];
    let terms = [...expand(a), ...expand(b)];
    requireThat(terms.length <= 2048, 'bit-algebra-budget'); reserve(terms.length * 32 + 64); work?.charge('workUnits', terms.length);
    if (op === 'and' && terms.includes('0')) return '0';
    if (op === 'or' && terms.includes('1')) return '1';
    const neutral = op === 'and' ? '1' : '0'; terms = terms.filter(v => v !== neutral);
    if (op === 'xor') {
      const odd = new Set(); for (const t of terms) odd.has(t) ? odd.delete(t) : odd.add(t);
      terms = [...odd];
    } else terms = [...new Set(terms)];
    terms.sort(); return !terms.length ? neutral : terms.length === 1 ? terms[0] : internBit(op, terms);
  };
  const affineForm = (vector, bits) => {
    const key = typed(vector); reserve(key.length * 2 + 128); if (algebra.affine.has(key)) return algebra.affine.get(key);
    if (vector.every(v => v === '0' || v === '1')) return { constant: BigInt('0b' + [...vector].reverse().join('')), terms: new Map() };
    return { constant: 0n, terms: new Map([[key, { coefficient: 1n, vector }]]) };
  };
  const affine = (left, right, bits, subtract, atom) => {
    const a = affineForm(left, bits), b = affineForm(right, bits), modulus = 1n << BigInt(bits), mod = n => ((n % modulus) + modulus) % modulus;
    const sign = subtract ? -1n : 1n, constant = mod(a.constant + sign * b.constant), terms = new Map(a.terms);
    for (const [key, term] of b.terms) { const coefficient = mod((terms.get(key)?.coefficient ?? 0n) + sign * term.coefficient);
      if (coefficient) terms.set(key, { coefficient, vector: term.vector }); else terms.delete(key); }
    requireThat(terms.size <= 128, 'affine-proof-budget'); work?.charge('workUnits', terms.size + 1);
    let out;
    if (!terms.size) out = Array.from({length:bits}, (_, i) => (constant >> BigInt(i)) & 1n ? '1' : '0');
    else if (terms.size === 1 && constant === 0n && [...terms.values()][0].coefficient === 1n) out = [...terms.values()][0].vector;
    else out = atom(typed(['modular-affine', bits, constant.toString(), [...terms].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => [k,v.coefficient.toString()])]));
    const outKey = typed(out); reserve(outKey.length * 2 + terms.size * 128 + 128);
    algebra.affine.set(outKey, { constant, terms }); return out;
  };
  let count = 0;
  function visit(node, depth = 0) {
    work?.checkpoint(); work?.charge('workUnits');
    requireThat(++count <= 1024 && depth <= 32, 'expression-proof-budget');
    requireThat(node && typeof node === 'object' && !Array.isArray(node), 'expression-required');
    const bits = width(node), base = ['kind', 'bits', 'signed', 'effect'];
    const child = value => visit(value, depth + 1);
    const atom = key => {
      requireThat(key.length <= 262144, 'expression-normal-form-budget');
      if (!atoms.has(key)) { reserve(key.length * 2 + 128); atoms.set(key, atoms.size); }
      reserve(bits * 32 + 64);
      return Array.from({ length: bits }, (_, bit) => `a${atoms.get(key)}:${bit}`);
    };
    if (node.kind === 'load') {
      // Full owner payload is an opaque event, INCLUDING fault/atomic/volatile,
      // memory version, location, address, width and origins. Never collapse two
      // occurrences to one just because they access the same address.
      requireThat(['read', 'volatile'].includes(node.effect), 'load-effect-unbound');
      const event = typed(node);
      events.push(event);
      requireThat(events.length <= 64, 'load-event-budget');
      return atom(typed(['load-occurrence', events.length - 1, event]));
    }
    requireThat(node.effect === 'pure' || node.effect === 'read' || node.effect === 'volatile', 'non-view-effect');
    if (node.kind === 'const') {
      fields(node, [...base, 'value']);
      requireThat(node.effect === 'pure' && typeof node.value === 'bigint', 'constant-contract');
      const n = BigInt.asUintN(bits, node.value);
      return Array.from({ length: bits }, (_, bit) => ((n >> BigInt(bit)) & 1n) ? '1' : '0');
    }
    if (node.kind === 'var') {
      fields(node, [...base, 'name', 'ssaId', 'range']);
      requireThat(node.effect === 'pure' && typeof node.name === 'string' && node.name.length > 0 && node.name.length <= 256, 'variable-contract');
      // Names are symbolic input bindings in this expression-only domain. The
      // owner/source checks outside this kernel bind their actual interpretation.
      return atom(typed(['input', node.name, bits, node.signed, node.ssaId ?? null, node.source?.ssaDefs ?? [], node.range ?? null]));
    }
    if (node.kind === 'unary') {
      fields(node, [...base, 'op', 'arg', 'fromBits']);
      requireThat(['trunc', 'zext', 'sext'].includes(node.op), 'unhandled-unary-rule');
      requireThat(node.effect === node.arg?.effect, 'cast-effect-mismatch');
      const arg = child(node.arg);
      requireThat(node.fromBits === undefined || node.fromBits === arg.length, 'cast-source-width-mismatch');
      if (node.op === 'trunc') { requireThat(bits <= arg.length, 'truncation-widens'); return arg.slice(0, bits); }
      requireThat(bits >= arg.length, 'extension-narrows');
      return [...arg, ...Array(bits - arg.length).fill(node.op === 'zext' ? '0' : arg.at(-1))];
    }
    if (node.kind === 'compare') {
      fields(node, [...base, 'op', 'left', 'right', 'compareSigned', 'comparisonDomain']);
      requireThat(node.comparisonDomain === 'integer' && bits === 1 && node.signed === false
        && (node.compareSigned === null || typeof node.compareSigned === 'boolean'), 'comparison-domain-unbound');
      requireThat(['==', '!=', '<', '<=', '>', '>='].includes(node.op), 'comparison-rule-unhandled');
      requireThat(['==', '!='].includes(node.op) || typeof node.compareSigned === 'boolean', 'ordered-comparison-signedness-unbound');
      const rank = { pure: 0, read: 1, volatile: 2 };
      requireThat(node.effect === (rank[node.left?.effect] >= rank[node.right?.effect] ? node.left?.effect : node.right?.effect), 'operator-effect-mismatch');
      const left = child(node.left), right = child(node.right);
      requireThat(left.length === right.length, 'comparison-width-mismatch');
      const operands = ['==', '!='].includes(node.op) ? [left, right].sort((a,b) => typed(a) < typed(b) ? -1 : typed(a) > typed(b) ? 1 : 0) : [left, right];
      return atom(typed(['compare', node.op, node.compareSigned, ...operands]));
    }
    if (node.kind === 'binary') {
      fields(node, [...base, 'op', 'left', 'right']);
      // Independent total modular affine and per-bit Boolean identities.
      // No C signed-overflow, trapping arithmetic or alias assumptions.
      requireThat(['add', 'sub', 'and', 'or', 'xor', '+', '-', '&', '|', '^'].includes(node.op), 'binary-rule-unhandled');
      const rank = { pure: 0, read: 1, volatile: 2 };
      requireThat(node.effect === (rank[node.left?.effect] >= rank[node.right?.effect] ? node.left?.effect : node.right?.effect), 'operator-effect-mismatch');
      const left = child(node.left), right = child(node.right);
      requireThat(left.length === bits && right.length === bits, 'binary-width-mismatch');
      const op = ({'+':'add','-':'sub','&':'and','|':'or','^':'xor'})[node.op] ?? node.op;
      if (op === 'add' || op === 'sub') return affine(left, right, bits, op === 'sub', atom);
      return left.map((v,i) => combineBit(op,v,right[i]));
    }
    throw new Unhandled('expression-kind-unhandled');
  }
  return visit(root);
}

export function checkBitvectorViewRelation(before, after, { work = null, allowMemory = false } = {}) {
  const base = { ruleId: BV_VIEW_PROOF_RULE, ruleVersion: BV_VIEW_PROOF_VERSION,
    scope: 'typed-expression-under-identical-inputs', exact: false, machineEquivalence: 'unproved',
    renderingEquivalence: 'unproved', semanticCounterexample: false };
  try {
    const a = snapshotContractData(before, LIMITS), b = snapshotContractData(after, LIMITS);
    const atoms = new Map(), beforeEvents = [], afterEvents = [], algebra = { bits: new Map(), affine: new Map(), allocatedBytes: 0 };
    work?.charge('residentBytes', (typed(a).length + typed(b).length) * 2);
    const left = shape(a, work, atoms, beforeEvents, algebra), right = shape(b, work, atoms, afterEvents, algebra);
    if (beforeEvents.length || afterEvents.length) {
      if (allowMemory !== true) return deepFreeze({ ...base, status: 'unknown', reason: 'memory-frame-required' });
      if (typed(beforeEvents) !== typed(afterEvents)) return deepFreeze({ ...base, status: 'rejected', reason: 'load-event-sequence-changed' });
    }
    if (a.bits !== b.bits || a.signed !== b.signed) return deepFreeze({ ...base, status: 'rejected', reason: 'output-view-changed' });
    if (typed(left) !== typed(right)) return deepFreeze({ ...base, status: 'unknown', reason: 'view-rule-does-not-establish-equivalence' });
    return deepFreeze({ ...base, status: 'verified', reason: null, loadsPreserved: beforeEvents.length,
      supportedInputAtoms: atoms.size, faultScope: beforeEvents.length ? 'identical-opaque-load-events' : 'no-memory-events' });
  } catch (error) {
    if (!(error instanceof Unhandled)) throw error;
    return deepFreeze({ ...base, status: 'unknown', reason: error.message });
  }
}
