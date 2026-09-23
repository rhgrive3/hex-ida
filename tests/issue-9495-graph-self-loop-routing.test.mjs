import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutNodes, routeEdges } from '../js/graph-routing.js';

function crossesInterior(a, b, rect) {
  const left = rect.x, right = rect.x + rect.w, top = rect.y, bottom = rect.y + rect.h;
  if (a.x === b.x) {
    if (!(a.x > left && a.x < right)) return false;
    const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
    return Math.max(lo, top) < Math.min(hi, bottom);
  }
  if (a.y === b.y) {
    if (!(a.y > top && a.y < bottom)) return false;
    const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
    return Math.max(lo, left) < Math.min(hi, right);
  }
  return false;
}

test('#9495 call self-loop stays out of DAG rank propagation and node interior', () => {
  const nodes = [{ id: 'A', title: 'FuncA', lines: ['sub_1000'] }];
  const edges = [{ from: 'A', to: 'A', kind: 'call' }];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const layout = layoutNodes(nodes, edges, byId);
  const rect = layout.pos.get('A');
  assert.equal(rect.rank, 0);
  const route = routeEdges(edges, layout)[0];
  assert.equal(route.external, true);
  for (let i = 1; i < route.points.length; i++) {
    assert.equal(crossesInterior(route.points[i - 1], route.points[i], rect), false,
      `segment ${i - 1} crosses self node interior`);
  }
});
