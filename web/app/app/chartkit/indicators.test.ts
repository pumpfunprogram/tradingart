import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi } from './indicators';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

test('sma: first values are NaN, then average', () => {
  const r = sma([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(r[0]));
  assert.ok(Number.isNaN(r[1]));
  assert.ok(near(r[2], 2));
  assert.ok(near(r[3], 3));
  assert.ok(near(r[4], 4));
});

test('ema: seeds with sma then smooths', () => {
  const r = ema([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(r[0]));
  assert.ok(Number.isNaN(r[1]));
  assert.ok(near(r[2], 2));
  assert.ok(r[4] > r[2]);
});

test('rsi: flat series is 100 or NaN', () => {
  const r = rsi([10, 10, 10, 10, 10], 3);
  assert.ok(Number.isNaN(r[0]) || r[0] === 100);
});
