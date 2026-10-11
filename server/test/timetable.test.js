import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAllowedTimetableUrl, parseIcal, getEventsForWeek, getMonday,
} from '../src/timetable.js';

// ─── SSRF hardening ─────────────────────────────────────────────────
// Any public domain is allowed (user pastes any uni's .ics/LSF link); the guard
// only blocks internal/loopback/link-local/metadata targets and raw IPs.
test('assertAllowedTimetableUrl: allows public university domains', () => {
  assert.doesNotThrow(() => assertAllowedTimetableUrl('http://hic.hs-pforzheim.de/lsf/rds?x=1'));
  assert.doesNotThrow(() => assertAllowedTimetableUrl('https://lsf.hhu.de/qisserver/rds'));
  assert.doesNotThrow(() => assertAllowedTimetableUrl('https://rapla.dhbw.de/rapla?page=ical'));
});

test('assertAllowedTimetableUrl: blocks internal targets, IPs, bad schemes', () => {
  for (const bad of [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1/x',
    'http://10.0.0.5/x',
    'http://localhost:8080/',
    'http://intranet/x',       // no dot → not a public domain
    'https://1.2.3.4/x',       // raw IP literal
    'file:///etc/passwd',
  ]) {
    assert.throws(() => assertAllowedTimetableUrl(bad), /nicht erlaubt|Ung/, `should block ${bad}`);
  }
});

// ─── getMonday ──────────────────────────────────────────────────────
test('getMonday returns Monday for any weekday', () => {
  // Format in local components — getMonday returns a local-midnight Date, same
  // as the app; toISOString() would shift it into the previous UTC day.
  const p = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  assert.equal(fmt(getMonday(new Date('2026-06-24T12:00:00'))), '2026-06-22'); // Wed
  assert.equal(fmt(getMonday(new Date('2026-06-22T00:00:00'))), '2026-06-22'); // Mon
  assert.equal(fmt(getMonday(new Date('2026-06-28T23:00:00'))), '2026-06-22'); // Sun
});

// ─── parseIcal ──────────────────────────────────────────────────────
const ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:INF101 - Programmieren 1
LOCATION:W2.1.05
CATEGORIES:Vorlesung
DTSTART:20260408T100000
DTEND:20260408T113000
RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=WE;UNTIL=20260624T235900Z
EXDATE:20260617T100000
END:VEVENT
BEGIN:VEVENT
SUMMARY:Bogus all-day
DTSTART:20260408T000000
DTEND:20260408T000000
END:VEVENT
BEGIN:VEVENT
SUMMARY:Einzeltermin Klausur
LOCATION:Audimax
DTSTART:20260610T140000
DTEND:20260610T160000
END:VEVENT
END:VCALENDAR`;

test('parseIcal: recurring event keeps RRULE/EXDATE metadata', () => {
  const events = parseIcal(ICS);
  // bogus 00:00–00:00 event is skipped → 2 events
  assert.equal(events.length, 2);

  const rec = events[0];
  assert.equal(rec.summary, 'INF101 - Programmieren 1');
  assert.equal(rec.location, 'W2.1.05');
  assert.equal(rec.startTime, '10:00');
  assert.equal(rec.endTime, '11:30');
  assert.equal(rec.freq, 'WEEKLY');
  assert.equal(rec.byDay, 'WE');
  assert.equal(rec.until, '20260624T235900Z');
  assert.deepEqual(rec.exdates, ['20260617']);
  assert.equal(rec.startDate, '20260408');
});

test('parseIcal: single event derives weekday from DTSTART', () => {
  const single = parseIcal(ICS)[1];
  assert.equal(single.singleDate, '20260610'); // a Wednesday
  assert.equal(single.byDay, 'WE');
  assert.equal(single.summary, 'Einzeltermin Klausur');
});

// ─── getEventsForWeek: the core prod-timetable expansion ────────────
const events = parseIcal(ICS);
const mondayOf = s => getMonday(new Date(s + 'T00:00:00'));

test('weekly event appears in an in-range week', () => {
  const days = getEventsForWeek(events, mondayOf('2026-06-08')); // Wed = 2026-06-10
  assert.ok(days[3], 'Wednesday should have events');
  assert.equal(days[3][0].name, 'INF101 - Programmieren 1');
});

test('EXDATE removes the cancelled occurrence', () => {
  const days = getEventsForWeek(events, mondayOf('2026-06-15')); // Wed = 2026-06-17 (EXDATE)
  assert.equal(days[3], undefined, 'cancelled Wednesday should be empty');
});

test('UNTIL is inclusive on its own day, exclusive after', () => {
  const onUntil = getEventsForWeek(events, mondayOf('2026-06-22')); // Wed 2026-06-24 == UNTIL date
  assert.ok(onUntil[3], 'occurrence on UNTIL date is included');

  const afterUntil = getEventsForWeek(events, mondayOf('2026-06-29')); // Wed 2026-07-01 > UNTIL
  assert.equal(afterUntil[3], undefined, 'after UNTIL excluded');
});

test('weekly event excluded before its start date', () => {
  const days = getEventsForWeek(events, mondayOf('2026-03-30')); // Wed 2026-04-01 < 20260408
  assert.equal(days[3], undefined);
});

test('single event only shows in its own week', () => {
  const hit = getEventsForWeek(events, mondayOf('2026-06-08')); // Wed 2026-06-10
  assert.equal(hit[3].some(e => e.name === 'Einzeltermin Klausur'), true);

  const miss = getEventsForWeek(events, mondayOf('2026-06-15')); // different week
  assert.equal((miss[3] || []).some(e => e.name === 'Einzeltermin Klausur'), false);
});

test('events within a day are sorted by start time', () => {
  const two = parseIcal(`BEGIN:VEVENT
SUMMARY:Late
DTSTART:20260610T140000
DTEND:20260610T150000
END:VEVENT
BEGIN:VEVENT
SUMMARY:Early
DTSTART:20260610T080000
DTEND:20260610T090000
END:VEVENT`);
  const days = getEventsForWeek(two, mondayOf('2026-06-08'));
  assert.deepEqual(days[3].map(e => e.name), ['Early', 'Late']);
});
