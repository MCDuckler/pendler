// ─── "When do I have to leave?" ───────────────────────────────────────
// The PWA computes this in the browser; the app, the widgets and the push
// watcher need the same answer without a browser, so it lives here too.
//
// A profile is the PWA's config object (homeLocation, workLocation, scheduleMode,
// timetableUrl, timetableLeadMin, days, outboundMode, returnMode, viaStops,
// excludedProducts) — the app sends exactly what the PWA stores.

import { berlinInstant, berlinDateStr } from './util.js';
import { getEventsForWeek, getMonday } from './timetable.js';

const pad2 = n => String(n).padStart(2, '0');

function minusMinutes(hhmm, min) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = Math.max(0, h * 60 + m - min);
  return `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

function dowOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Lectures of one day (timetable mode). `events` = parsed iCal events.
export function lecturesOn(events, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // getEventsForWeek/getMonday work in the host's local time; the server runs with
  // TZ=Europe/Berlin, and a local-midnight Date of that day is what they expect.
  const monday = getMonday(new Date(y, m - 1, d));
  return getEventsForWeek(events, monday)[dowOf(dateStr)] || [];
}

// When should each leg of the day happen? Null when there is no commute that day.
export function scheduleFor(profile, dateStr, events) {
  const dow = dowOf(dateStr);
  if (profile.scheduleMode === 'timetable') {
    const lectures = events ? lecturesOn(events, dateStr) : [];
    if (!lectures.length) return { source: 'timetable', lectures, commute: false };
    const lead = profile.timetableLeadMin ?? 15;
    return {
      source: 'timetable',
      lectures,
      commute: true,
      outbound: { time: minusMinutes(lectures[0].startTime, lead), mode: 'arrival' },
      return: { time: lectures[lectures.length - 1].endTime, mode: 'departure' },
    };
  }
  const day = profile.days?.[dow];
  if (!day?.enabled) return { source: 'manual', lectures: [], commute: false };
  return {
    source: 'manual',
    lectures: [],
    commute: true,
    outbound: { time: day.outboundTime, mode: profile.outboundMode || 'arrival' },
    return: { time: day.returnTime, mode: profile.returnMode || 'departure' },
  };
}

const firstDep = j => Date.parse(j.legs[0]?.departure);
const lastArr = j => Date.parse(j.legs[j.legs.length - 1]?.arrival);

// The connection to recommend. Arrival mode: the latest departure that still
// arrives in time (realtime-aware). Departure mode: the first one not yet gone.
export function pickBest(journeys, mode, target, now) {
  const live = journeys.filter(j => !j.cancelled && j.legs.length);
  if (!live.length) return -1;
  let best;
  if (mode === 'arrival') {
    const inTime = live.filter(j => lastArr(j) <= target.getTime());
    best = inTime.length
      ? inTime.reduce((a, b) => (firstDep(b) > firstDep(a) ? b : a))
      : live.reduce((a, b) => (lastArr(b) < lastArr(a) ? b : a));
  } else {
    const ahead = live.filter(j => firstDep(j) >= Math.max(target.getTime(), now.getTime() - 60e3));
    best = ahead[0] || live[live.length - 1];
  }
  return journeys.indexOf(best);
}

async function planLeg(search, profile, from, to, dateStr, leg, now) {
  const target = berlinInstant(dateStr, leg.time);
  // A target already in the past today: search from now instead (same as the PWA).
  const past = target < now;
  const useArrival = leg.mode === 'arrival' && !past;
  const when = (past ? now : target).toISOString();
  const out = { target: leg.time, targetAt: target.toISOString(), mode: leg.mode, journeys: [], best: -1 };
  try {
    out.journeys = await search({
      from, to,
      [useArrival ? 'arrival' : 'departure']: when,
      results: Math.max(3, profile.results || 4),
      via: profile.viaStops || [],
      excludeProducts: profile.excludedProducts || [],
    });
    out.best = pickBest(out.journeys, useArrival ? 'arrival' : 'departure', past ? now : target, now);
    const b = out.journeys[out.best];
    if (b) {
      out.leaveAt = b.legs[0].departure;
      out.arriveAt = b.legs[b.legs.length - 1].arrival;
      out.delay = Math.max(0, ...b.legs.map(l => l.departureDelay || 0));
    }
  } catch (e) {
    out.error = e.message || 'Verbindungen konnten nicht geladen werden';
  }
  return out;
}

/**
 * Plan one day. deps = { search(opts) → journeys, timetableEvents(url) → events }.
 * Returns { date, dow, source, lectures, commute, outbound?, return? }.
 */
export async function planDay(profile, dateStr, deps, now = new Date()) {
  if (!profile?.homeLocation || !profile?.workLocation) {
    return { date: dateStr, dow: dowOf(dateStr), commute: false, setup: false };
  }
  let events = null;
  let timetableError;
  if (profile.scheduleMode === 'timetable' && profile.timetableUrl) {
    try { events = await deps.timetableEvents(profile.timetableUrl); } catch (e) { timetableError = e.message; }
  }
  const s = scheduleFor(profile, dateStr, events);
  const day = { date: dateStr, dow: dowOf(dateStr), setup: true, ...s };
  if (timetableError) day.timetableError = timetableError;
  delete day.outbound; delete day.return;
  if (!s.commute) return day;
  const [ob, rt] = await Promise.all([
    planLeg(deps.search, profile, profile.homeLocation, profile.workLocation, dateStr, s.outbound, now),
    planLeg(deps.search, profile, profile.workLocation, profile.homeLocation, dateStr, s.return, now),
  ]);
  day.outbound = ob;
  day.return = rt;
  return day;
}

// Is anything of this day still ahead of `now`?
function dayIsOver(day, now) {
  if (!day.commute) return true;
  const ret = day.return?.journeys?.[day.return.best];
  const end = ret ? firstDep(ret) : Date.parse(day.return?.targetAt);
  return Number.isFinite(end) && end < now.getTime();
}

/**
 * Today, plus — once today has nothing left — the next commute day (≤ 7 days out),
 * so a widget at 20:00 can already say "Morgen: los 07:12".
 */
export async function planToday(profile, deps, now = new Date()) {
  const today = berlinDateStr(now);
  const day = await planDay(profile, today, deps, now);
  const res = { generatedAt: now.toISOString(), today: day, next: null };
  if (!day.setup || !dayIsOver(day, now)) return res;
  let events = null;
  if (profile.scheduleMode === 'timetable' && profile.timetableUrl) {
    events = await deps.timetableEvents(profile.timetableUrl).catch(() => null);
  }
  for (let i = 1; i <= 7; i++) {
    const date = addDays(today, i);
    // Cheap check first: only plan journeys for a day that has a commute at all.
    if (!scheduleFor(profile, date, events).commute) continue;
    res.next = await planDay(profile, date, deps, now);
    break;
  }
  return res;
}

