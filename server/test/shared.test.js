import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatLocalTime, buildHaltId, parseLocation, transformJourney,
} from '../functions/api/_shared.js';

// ─── formatLocalTime: regression test for the prod timezone bug ──────
// The client sends an absolute UTC instant; bahn.de wants German wall-clock.
// On Cloudflare Workers (UTC host) getHours() was wrong — this must hold
// regardless of the host timezone.
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
test('buildHaltId: bare station id string', () => {
  assert.equal(buildHaltId('8000299'), 'A=1@L=8000299@');
});

test('buildHaltId: address/location object', () => {
  const loc = { type: 'location', name: 'Hauptstr 1', latitude: 48.770075, longitude: 9.186131 };
  assert.equal(buildHaltId(loc), 'A=2@O=Hauptstr 1@X=9186131@Y=48770075@');
});

test('buildHaltId: object with id', () => {
  assert.equal(buildHaltId({ id: '561215' }), 'A=1@L=561215@');
});

// ─── parseLocation ──────────────────────────────────────────────────
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
test('transformJourney normalizes train + walk legs', () => {
  const verbindung = {
    verbindungsAbschnitte: [
      {
        verkehrsmittel: { typ: 'ZUG', produktGattung: 'REGIONAL', mittelText: 'RB 17', richtung: 'Pforzheim' },
        abfahrt: { sollzeit: '2026-06-25T08:00:00', istzeit: '2026-06-25T08:03:00' },
        ankunft: { sollzeit: '2026-06-25T08:40:00', istzeit: '2026-06-25T08:41:00' },
        startHalt: { name: 'Stuttgart Hbf', abfahrt: { gleis: '4' } },
        zielHalt: { name: 'Pforzheim Hbf', ankunft: { gleis: '2' } },
      },
      {
        verkehrsmittel: { typ: 'WALK' },
        abfahrt: { sollzeit: '2026-06-25T08:40:00' },
        ankunft: { sollzeit: '2026-06-25T08:48:00' },
        startHalt: { name: 'Pforzheim Hbf' },
        zielHalt: { name: 'Hochschule' },
        entfernung: 600,
      },
    ],
  };

  const { legs } = transformJourney(verbindung);
  assert.equal(legs.length, 2);

  const train = legs[0];
  assert.equal(train.line.name, 'RB 17');
  assert.equal(train.line.product, 'regional');
  assert.equal(train.departureDelay, 180); // 3 min in seconds
  assert.equal(train.arrivalDelay, 60);
  assert.equal(train.departurePlatform, '4');
  assert.equal(train.arrivalPlatform, '2');
  assert.equal(train.departure, '2026-06-25T08:03:00'); // istzeit preferred
  assert.equal(train.walking, false);

  const walk = legs[1];
  assert.equal(walk.walking, true);
  assert.equal(walk.line, null);
  assert.equal(walk.distance, 600);
});

test('transformJourney: missing realtime → zero delay, planned time used', () => {
  const { legs } = transformJourney({
    verbindungsAbschnitte: [{
      verkehrsmittel: { typ: 'ZUG', produktGattung: 'SBAHN', mittelText: 'S6' },
      abfahrt: { sollzeit: '2026-06-25T08:00:00' },
      ankunft: { sollzeit: '2026-06-25T08:20:00' },
      startHalt: { name: 'A' },
      zielHalt: { name: 'B' },
    }],
  });
  assert.equal(legs[0].departureDelay, 0);
  assert.equal(legs[0].arrivalDelay, 0);
  assert.equal(legs[0].departure, '2026-06-25T08:00:00');
  assert.equal(legs[0].departurePlatform, null);
  assert.equal(legs[0].line.product, 'suburban');
});
