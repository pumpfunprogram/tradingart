import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDrawing, project, FIB_LEVELS } from './drawings';

test('hline projects to a horizontal segment', () => {
  const d = makeDrawing('hline', [{ time: 100, price: 50 }]);
  const sh = project(d, {
    xOf: (t) => t,
    yOf: (p) => p * 2,
  });
  assert.equal(sh.segs.length, 1);
  assert.equal(sh.segs[0].y1, 100);
  assert.equal(sh.segs[0].y2, 100);
});

test('fib emits one segment per level', () => {
  const d = makeDrawing('fib', [{ time: 0, price: 100 }, { time: 10, price: 50 }]);
  const sh = project(d, {
    xOf: (t) => t * 10,
    yOf: (p) => 200 - p,
  });
  assert.equal(sh.segs.length, FIB_LEVELS.length);
  assert.equal(sh.labels.length, FIB_LEVELS.length);
});

test('trend needs two points', () => {
  const d = makeDrawing('trend', [{ time: 1, price: 10 }, { time: 5, price: 20 }]);
  const sh = project(d, { xOf: (t) => t, yOf: (p) => p });
  assert.equal(sh.segs.length, 1);
  assert.equal(sh.segs[0].x1, 1);
  assert.equal(sh.segs[0].x2, 5);
});
