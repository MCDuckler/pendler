import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLocalTime, parseLocation, berlinInstant, berlinDateStr } from '../src/util.js';

// ─── formatLocalTime: regression test for the prod timezone bug ──────
// The client sends an absolute UTC instant; upstreams want German wall-clock.
// On a UTC host getHours() is wrong — this must hold regardless of host timezone.
test('formatLocalTime renders UTC instant in Europe/Berlin (summer, CEST +2)', () => {
  const instant = new Date('2026-06-25T06:00:00.000Z'); // 08:00 Berlin
  assert.equal(formatLocalTime(instant), '2026-06-25T08:00:00');
});

test('formatLocalTime renders UTC instant in Europe/Berlin (winter, CET +1)', () => {
  const instant = new Date('2026-01-15T07:00:00.000Z'); // 08:00 Berlin
  assert.equal(formatLocalTime(instant), '2026-01-15T08:00:00');
});

test('formatLocalTime rolls the date across midnight correctly', () => {
  const instant = new Date('2026-06-25T22:30:00.000Z'); // 00:30 next day Berlin
  assert.equal(formatLocalTime(instant), '2026-06-26T00:30:00');
});

// ─── buildHaltId ────────────────────────────────────────────────────
test('parseLocation: JSON object string', () => {
  assert.deepEqual(parseLocation('{"id":"5","name":"X"}'), { id: '5', name: 'X' });
});

test('parseLocation: bare id string passes through', () => {
  assert.equal(parseLocation('8000299'), '8000299');
});

test('parseLocation: null/empty', () => {
  assert.equal(parseLocation(null), null);
  assert.equal(parseLocation(''), null);
});

test('parseLocation: malformed JSON falls back to raw string', () => {
  assert.equal(parseLocation('{not json'), '{not json');
});

// ─── transformJourney: bahn.de → normalized leg contract ────────────

test('berlinInstant: wall clock → instant, summer and winter', () => {
  assert.equal(berlinInstant('2026-06-25', '08:00').toISOString(), '2026-06-25T06:00:00.000Z');
  assert.equal(berlinInstant('2026-01-15', '08:00').toISOString(), '2026-01-15T07:00:00.000Z');
});

test('berlinDateStr: date in Berlin, not UTC', () => {
  assert.equal(berlinDateStr(new Date('2026-06-25T22:30:00Z')), '2026-06-26');
});
