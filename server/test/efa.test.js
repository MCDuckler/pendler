import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  transformJourney, transformLocation, transformStopEvent, efaPoint,
} from '../src/efa.js';

// Fixtures are real EFA-BW answers recorded 2026-10-11 (trimmed).
const fx = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

test('stop finder: stops keep their EFA id and products', () => {
  const [hbf] = fx('efa-stopfinder-stop.json').locations.map(transformLocation);
  assert.equal(hbf.type, 'stop');
  assert.equal(hbf.id, 'de:08231:50');
  assert.equal(hbf.name, 'Pforzheim, Hauptbahnhof');
  assert.ok(hbf.products.regional);
  assert.equal(typeof hbf.latitude, 'number');
});

test('stop finder: addresses become id-less locations with coordinates', () => {
  const [addr] = fx('efa-stopfinder-address.json').locations.map(transformLocation);
  assert.equal(addr.type, 'location');
  assert.equal(addr.id, undefined);
  assert.match(addr.address, /Tiefenbronner Straße 65/);
  assert.ok(addr.latitude > 48 && addr.longitude > 8);
});

test('efaPoint: EFA id, legacy bahn.de EVA id, address', () => {
  assert.deepEqual(efaPoint('de:08231:50'), { type: 'any', name: 'de:08231:50' });
  assert.deepEqual(efaPoint({ id: '8000299', latitude: 48.89, longitude: 8.70 }),
    { type: 'coord', name: '8.7:48.89:WGS84[dd.ddddd]' });
  assert.deepEqual(efaPoint({ type: 'location', latitude: 48.87, longitude: 8.71, address: 'x' }),
    { type: 'coord', name: '8.71:48.87:WGS84[dd.ddddd]' });
});

test('trip: walk + bus + walk + train legs in the v1 shape', () => {
  const j = transformJourney(fx('efa-trip.json').journeys[0]);
  assert.equal(j.legs.length, 4);
  const [walk, bus, walk2, train] = j.legs;
  assert.equal(walk.walking, true);
  assert.equal(walk.line, null);
  assert.equal(walk.distance, 440);
  assert.deepEqual(bus.line, { name: 'Bus 5', product: 'bus' });
  assert.equal(bus.direction, 'Hauptbahnhof/ZOB');
  assert.equal(walk2.walking, true);
  assert.deepEqual(train.line, { name: 'RE 1', product: 'regional' });
  assert.equal(train.departurePlatform, '3');
  assert.equal(train.realtime, true);
  assert.equal(train.plannedDeparture, '2026-10-12T05:54:00Z');
  assert.equal(train.departureDelay, 0);
});

test('trip: platform change and arrival platform come from platformName', () => {
  const train = transformJourney(fx('efa-trip.json').journeys[0]).legs[3];
  assert.equal(train.arrivalPlatform, '13');
  assert.equal(train.platformChanged, true);
});

test('departure monitor: delay in seconds from planned vs estimated', () => {
  const evs = fx('efa-dm.json').stopEvents.map(transformStopEvent);
  const late = evs.find(e => e.delay > 0);
  assert.ok(late, 'fixture has a late departure');
  assert.equal(late.delay, 600);
  assert.equal(late.line.product, 'bus');
  assert.equal(evs[0].platform, 'Bstg. 13');
});
