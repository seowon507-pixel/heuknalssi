import assert from 'node:assert/strict';
import test from 'node:test';

import { currentDayPeriod } from '../public/day-period.js';

test('dashboard scene follows night, dawn, day, and dusk boundaries', () => {
  const at = (hour) => new Date(2026, 7, 5, hour, 0, 0);
  assert.equal(currentDayPeriod(at(0)), 'night');
  assert.equal(currentDayPeriod(at(4)), 'night');
  assert.equal(currentDayPeriod(at(5)), 'dawn');
  assert.equal(currentDayPeriod(at(7)), 'dawn');
  assert.equal(currentDayPeriod(at(8)), 'day');
  assert.equal(currentDayPeriod(at(17)), 'day');
  assert.equal(currentDayPeriod(at(18)), 'dusk');
  assert.equal(currentDayPeriod(at(20)), 'dusk');
  assert.equal(currentDayPeriod(at(21)), 'night');
});
