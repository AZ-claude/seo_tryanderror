import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toOperationalDateString } from '../src/core/date.js';

test('toOperationalDateString: 2026-09-21T16:30:00Z (= 2026-09-22 01:30 JST) resolves to the JST calendar date', () => {
  assert.equal(toOperationalDateString(new Date('2026-09-21T16:30:00Z')), '2026-09-22');
});

test('toOperationalDateString: JST midnight boundary (UTC 15:00 = JST 00:00, UTC+9)', () => {
  assert.equal(toOperationalDateString(new Date('2026-09-21T14:59:59Z')), '2026-09-21');
  assert.equal(toOperationalDateString(new Date('2026-09-21T15:00:00Z')), '2026-09-22');
});

test('toOperationalDateString: well inside the JST day, no boundary ambiguity', () => {
  assert.equal(toOperationalDateString(new Date('2026-09-21T03:00:00Z')), '2026-09-21'); // 12:00 JST
});
