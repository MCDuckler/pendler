import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBest, scheduleFor, planDay, planToday } from '../src/plan.js';

process.env.TZ = 'Europe/Berlin';

const J = (dep, arr, extra = {}) => ({
  legs: [{ departure: dep, arrival: arr, line: { name: 'RE 1' }, departureDelay: 0, ...extra }],
  cancelled: !!extra.cancelled,
});

test('pickBest arrival: latest departure that still arrives in time', () => {
  const js = [J('2026-10-12T06:00Z', '2026-10-12T06:40Z'), J('2026-10-12T06:30Z', '2026-10-12T07:10Z'), J('2026-10-12T07:00Z', '2026-10-12T07:40Z')];
  assert.equal(pickBest(js, 'arrival', new Date('2026-10-12T07:15Z'), new Date('2026-10-12T05:00Z')), 1);
});

test('pickBest arrival: skips cancelled trips', () => {
  const js = [J('2026-10-12T06:00Z', '2026-10-12T06:40Z'), J('2026-10-12T06:30Z', '2026-10-12T07:10Z', { cancelled: true })];
  assert.equal(pickBest(js, 'arrival', new Date('2026-10-12T07:15Z'), new Date('2026-10-12T05:00Z')), 0);
});

test('pickBest arrival: nothing in time → earliest arrival', () => {
  const js = [J('2026-10-12T07:00Z', '2026-10-12T07:40Z'), J('2026-10-12T07:30Z', '2026-10-12T08:10Z')];
  assert.equal(pickBest(js, 'arrival', new Date('2026-10-12T07:15Z'), new Date('2026-10-12T05:00Z')), 0);
});

test('pickBest departure: first one at or after the target', () => {
  const js = [J('2026-10-12T14:58Z', '2026-10-12T15:57Z'), J('2026-10-12T15:27Z', '2026-10-12T16:30Z')];
  assert.equal(pickBest(js, 'departure', new Date('2026-10-12T15:00Z'), new Date('2026-10-12T05:00Z')), 1);
});

const profile = {
  homeLocation: { type: 'stop', id: 'A' }, workLocation: { type: 'stop', id: 'B' },
  scheduleMode: 'manual', outboundMode: 'arrival', returnMode: 'departure',
  days: { 1: { enabled: true, outboundTime: '08:00', returnTime: '17:00' }, 2: { enabled: false } },
};

test('scheduleFor manual: enabled Monday, disabled Tuesday', () => {
  assert.equal(scheduleFor(profile, '2026-10-12', null).outbound.time, '08:00');
  assert.equal(scheduleFor(profile, '2026-10-13', null).commute, false);
});

test('scheduleFor timetable: first lecture minus lead, last lecture end', () => {
  const events = [
    { summary: 'A', startTime: '09:45', endTime: '11:15', startDate: '20261005', freq: 'WEEKLY', byDay: 'MO', exdates: [] },
    { summary: 'B', startTime: '13:30', endTime: '15:00', startDate: '20261005', freq: 'WEEKLY', byDay: 'MO', exdates: [] },
  ];
  const s = scheduleFor({ scheduleMode: 'timetable', timetableLeadMin: 15 }, '2026-10-12', events);
  assert.equal(s.outbound.time, '09:30');
  assert.equal(s.return.time, '15:00');
  assert.equal(s.lectures.length, 2);
});

test('planDay: searches arrival for the outbound and departure for the return', async () => {
  const calls = [];
  const search = async o => { calls.push(o); return [J('2026-10-12T05:00Z', '2026-10-12T05:50Z')]; };
  const day = await planDay(profile, '2026-10-12', { search, timetableEvents: async () => [] }, new Date('2026-10-12T03:00Z'));
  assert.equal(calls[0].arrival, '2026-10-12T06:00:00.000Z'); // 08:00 CEST
  assert.equal(calls[1].departure, '2026-10-12T15:00:00.000Z'); // 17:00 CEST
  assert.equal(day.outbound.leaveAt, '2026-10-12T05:00Z');
});

test('planToday: after the return trip has left, plans the next commute day', async () => {
  const search = async () => [J('2026-10-12T15:05Z', '2026-10-12T16:00Z')];
  const res = await planToday({ ...profile, days: { ...profile.days, 3: { enabled: true, outboundTime: '08:00', returnTime: '17:00' } } },
    { search, timetableEvents: async () => [] }, new Date('2026-10-12T19:00Z'));
  assert.equal(res.today.date, '2026-10-12');
  assert.equal(res.next.date, '2026-10-14'); // Tue disabled, Wed enabled
});

test('planDay without a home/work location says setup is missing', async () => {
  const day = await planDay({}, '2026-10-12', {});
  assert.equal(day.setup, false);
});
