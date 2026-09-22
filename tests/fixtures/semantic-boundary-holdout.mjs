/* Synthetic, labelled shape-boundary fixture.
 *
 * It exercises the real location verifier and is deliberately marked
 * synthetic: it validates the instrumentation/rollout machinery but is not a
 * substitute for a labelled game-binary holdout before promotion.
 */
import { buildSemanticModel } from '../../js/blocks.js';
import { goalFromPreset } from '../../js/goals.js';
import { pinpointLocation } from '../../js/pinpoint.js';
import { AMOUNT, SHAPE, foldShapes } from '../../js/shapes.js';
import {
  SEMANTIC_BOUNDARY_ADMISSION_SCHEMA,
  SEMANTIC_BOUNDARY_AMBIGUITY_SCHEMA,
} from '../../js/semantic-boundary-referee.js';

const BASE = 0x100000000n;
const OFFSETS = Object.freeze([0x20, 0x30, 0x40, 0x50, 0x60]);
export const TRUE_OFFSET = 0x60n;
export const HOLDOUT_AMBIGUITY_POLICY = Object.freeze({
  schema: SEMANTIC_BOUNDARY_AMBIGUITY_SCHEMA,
  // Derived from this checked-in synthetic boundary fixture only.  Production
  // remains policy-unset until a real labelled game holdout is accepted.
  maxD4D5Gap: 0.02,
  minD4Score: 0,
});
export const HOLDOUT_ADMISSION_POLICY = Object.freeze({
  schema: SEMANTIC_BOUNDARY_ADMISSION_SCHEMA,
  minProbability: 0.8,
  minMargin: 0.2,
});

function modelOf(start, lines) {
  const rows = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return {
      row,
      address: start + BigInt(row * 4),
      mn: split < 0 ? line : line.slice(0, split),
      ops: split < 0 ? '' : line.slice(split + 1),
    };
  });
  return buildSemanticModel(rows, {
    startRow: 0,
    endRow: rows.length - 1,
    rowOfAddress(address) {
      const delta = address - start;
      return delta >= 0n && delta < BigInt(lines.length * 4) ? Number(delta / 4n) : null;
    },
  });
}

function modelChanging(start, offset) {
  return modelOf(start, [
    'mov x19, x0',
    'mov x20, x1',
    'ldr w9, [x20, #0x10]',
    `ldr w8, [x19, #0x${offset.toString(16)}]`,
    'sub w8, w8, w9',
    `str w8, [x19, #0x${offset.toString(16)}]`,
    'ret',
  ]);
}

function unrelatedModel(start) {
  return modelChanging(start, 0x7f0n);
}

function profiles(clearBoundary) {
  if (clearBoundary) return [[6, 4], [5, 3], [4, 2], [3, 1], [1, 0]];
  // D4 narrowly leads D5 on deterministic shape facts, while the labelled
  // gameplay value is D5.  D1..D4 lack a confirming instruction change.
  return [[6, 4], [5, 3], [4, 2], [4, 1], [3, 1]];
}

export function syntheticShapeFixture({ count = 5, clearBoundary = false, complete = true, capped = false } = {}) {
  const profile = profiles(clearBoundary).slice(0, count);
  const events = [];
  const addressToOffset = new Map();
  for (let index = 0; index < profile.length; index++) {
    const [decreases, increases] = profile[index];
    const offset = OFFSETS[index];
    const start = BASE + BigInt(0x100 + index * 0x100);
    for (let event = 0; event < decreases; event++) {
      // Most observations deliberately share one function: this keeps the
      // fixture focused on the D4/D5 choice rather than paying three opens per
      // candidate.  D4 has two functions and the labelled D5 has three, so a
      // successful probe still exercises the one-extra-analysis boundary.
      const uniqueProbeSite = (index === 3 && event === 1) || (index === 4 && event > 0);
      const addr = start + BigInt(uniqueProbeSite ? event * 4 : 0);
      addressToOffset.set(addr.toString(), BigInt(offset));
      events.push({
        addr,
        disp: offset,
        size: 4,
        flags: SHAPE.DECREASE | SHAPE.CLAMP | SHAPE.CROSS,
        amtKind: AMOUNT.FIELD,
        amtDisp: 0x700 + index * 8,
      });
    }
    for (let event = 0; event < increases; event++) {
      const addr = start;
      addressToOffset.set(addr.toString(), BigInt(offset));
      events.push({ addr, disp: offset, size: 4, flags: SHAPE.INCREASE, amtKind: AMOUNT.NONE, amtDisp: 0 });
    }
  }
  const length = events.length;
  const scan = {
    count: length,
    capped,
    complete,
    addr: new BigUint64Array(length),
    disp: new Int32Array(length),
    size: new Uint8Array(length),
    flags: new Uint8Array(length),
    amtKind: new Uint8Array(length),
    amtDisp: new Int32Array(length),
    span: new Int32Array(length),
    amtSize: new Uint8Array(length),
    amtSpan: new Int32Array(length),
  };
  events.forEach((event, index) => {
    scan.addr[index] = event.addr;
    scan.disp[index] = event.disp;
    scan.size[index] = event.size;
    scan.flags[index] = event.flags;
    scan.amtKind[index] = event.amtKind;
    scan.amtDisp[index] = event.amtDisp;
    scan.span[index] = 0x100;
    scan.amtSize[index] = 4;
    scan.amtSpan[index] = 0x100;
  });
  return { shapes: foldShapes(scan), addressToOffset };
}

export function acceptedChoice(challengerId = 'c1') {
  return {
    model: 'openjev',
    method: 'choice',
    challengerId,
    probabilities: { c0: challengerId === 'c0' ? 0.92 : 0.04, c1: challengerId === 'c1' ? 0.92 : 0.04, none: 0.02 },
    abstain: false,
  };
}

export function acceptedNoul(challengerId = 'c1') {
  return {
    model: 'openjev',
    method: 'noul',
    challengerId,
    probabilities: { c0: challengerId === 'c0' ? 0.92 : 0.04, c1: challengerId === 'c1' ? 0.92 : 0.04, none: 0.02 },
    abstain: false,
  };
}

export async function runSyntheticBoundaryCase(options = {}) {
  const fixture = syntheticShapeFixture(options);
  const events = [];
  let analyzeCalls = 0;
  // `probeBarrenSites` models a candidate whose first scanned update site is
  // not the window that shows the change; the probe must stay bounded but keep
  // looking instead of giving up after one unhelpful window.
  let trueOffsetObservations = 0;
  const barren = Number.isFinite(options.probeBarrenSites) ? Math.max(0, Math.floor(options.probeBarrenSites)) : 0;
  const analyze = async (start) => {
    analyzeCalls++;
    const offset = fixture.addressToOffset.get(start.toString());
    if (offset === TRUE_OFFSET) {
      if (options.probeFails === true) return unrelatedModel(start);
      if (trueOffsetObservations++ < barren) return unrelatedModel(start);
      return modelChanging(start, offset);
    }
    if (offset === 0x50n) return modelChanging(start, offset);
    return unrelatedModel(start);
  };
  const pinpointOptions = {
    goal: options.goal || goalFromPreset(options.goalId || 'hp'),
    ranked: [],
    shapes: fixture.shapes,
    program: { functionRange: (addr) => ({ start: addr, end: addr + 0x20n }) },
    analyze,
    isCancelled: options.cancelled === true ? () => true : undefined,
    budget: { left: options.budget ?? 48 },
    limit: 10,
  };
  if (options.legacyPath !== true) {
    Object.assign(pinpointOptions, {
      semanticBoundaryInteractive: options.interactive !== false,
      semanticBoundaryAmbiguityPolicy: options.ambiguityPolicy === undefined
        ? HOLDOUT_AMBIGUITY_POLICY
        : options.ambiguityPolicy,
      semanticBoundaryAdmissionPolicy: options.admissionPolicy === undefined
        ? HOLDOUT_ADMISSION_POLICY
        : options.admissionPolicy,
      semanticBoundaryMode: options.mode || 'shadow',
      semanticBoundaryReferee: options.referee,
      semanticBoundaryInstrumentation: (event) => events.push(event),
    });
  }
  const result = await pinpointLocation(pinpointOptions);
  return { result, trace: events.at(-1) || null, analyzeCalls, fixture };
}
