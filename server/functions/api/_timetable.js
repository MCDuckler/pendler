// ─── Shared timetable logic: HIC/LSF iCal fetch + parse ──────────────
// Used by both the Cloudflare Pages Function (functions/api/timetable.js) and
// the local Node dev server (server.js). Keeping a single implementation is
// what prevents the two backends from drifting (recurring lectures, EXDATE,
// semester end were previously only handled correctly in one of them).

// Only these hosts may be fetched through the timetable proxy. Without this the
// endpoint is an open proxy / SSRF: any caller could make our server fetch
// arbitrary URLs (internal services, cloud metadata, traffic laundering).
const ALLOWED_TIMETABLE_HOSTS = ['hs-pforzheim.de'];

export function assertAllowedTimetableUrl(rawUrl) {
  let host;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad scheme');
    host = u.hostname.toLowerCase();
  } catch {
    throw new Error('Ungültige Stundenplan-URL');
  }
  const ok = ALLOWED_TIMETABLE_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
  if (!ok) throw new Error('Stundenplan-URL nicht erlaubt');
}

// Fetch the HIC timetable page, follow it to the iCal export, and parse all
// events (including their RRULE/EXDATE/UNTIL recurrence metadata).
export async function fetchTimetableEvents(timetableUrl) {
  assertAllowedTimetableUrl(timetableUrl);
  // Use HTTP — the HIC server's HTTPS port is unreliable.
  const httpUrl = timetableUrl.replace(/^https:/, 'http:');

  // Step 1: Fetch timetable HTML page to extract iCal link
  const html = await fetchText(httpUrl, {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
  });

  // Extract iCal export link (contains termine= with event IDs)
  const icalMatch = html.match(/href="([^"]*moduleCall=iCalendarPlan[^"]*)"/);
  if (!icalMatch) throw new Error('iCal-Link nicht im Stundenplan gefunden');

  let icalUrl = icalMatch[1].replace(/&amp;/g, '&');
  if (icalUrl.startsWith('/')) {
    const base = new URL(httpUrl);
    icalUrl = `${base.protocol}//${base.host}${icalUrl}`;
  }
  icalUrl = icalUrl.replace(/^https:/, 'http:');
  assertAllowedTimetableUrl(icalUrl); // the link came from fetched HTML — re-check host

  // Step 2: Fetch iCal data
  const icsText = await fetchText(icalUrl, { 'User-Agent': 'Mozilla/5.0' });

  // Step 3: Parse iCal
  return parseIcal(icsText);
}

async function fetchText(url, headers) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers, redirect: 'follow' });
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

export function parseIcal(icsText) {
  const events = [];
  const blocks = icsText.split('BEGIN:VEVENT');

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split('END:VEVENT')[0];
    const ev = {};

    ev.summary = icalProp(block, 'SUMMARY') || '';
    ev.location = icalProp(block, 'LOCATION') || '';
    ev.categories = icalProp(block, 'CATEGORIES') || '';

    const dtstart = icalDateTime(block, 'DTSTART');
    const dtend = icalDateTime(block, 'DTEND');
    if (!dtstart || !dtend) continue;
    // Skip bogus events (e.g., DTSTART=00:00, DTEND=00:00)
    if (dtstart.hour === 0 && dtstart.minute === 0 && dtend.hour === 0 && dtend.minute === 0) continue;

    ev.startTime = `${String(dtstart.hour).padStart(2, '0')}:${String(dtstart.minute).padStart(2, '0')}`;
    ev.endTime = `${String(dtend.hour).padStart(2, '0')}:${String(dtend.minute).padStart(2, '0')}`;
    ev.startDate = dtstart.date; // YYYYMMDD

    // Parse RRULE
    const rrule = icalProp(block, 'RRULE');
    if (rrule) {
      const parts = Object.fromEntries(rrule.split(';').map(p => p.split('=')));
      ev.freq = parts.FREQ;
      ev.interval = parseInt(parts.INTERVAL || '1', 10);
      ev.until = parts.UNTIL; // e.g. 20260624T235900Z
      ev.byDay = parts.BYDAY; // e.g. WE, TH
    } else {
      // Single event — derive day from DTSTART
      const dayMap = { 0: 'SU', 1: 'MO', 2: 'TU', 3: 'WE', 4: 'TH', 5: 'FR', 6: 'SA' };
      const d = new Date(dtstart.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'));
      ev.byDay = dayMap[d.getUTCDay()];
      ev.singleDate = dtstart.date;
    }

    // Parse EXDATE
    const exdateLines = block.split('\n').filter(l => l.trim().startsWith('EXDATE'));
    const exdates = new Set();
    for (const line of exdateLines) {
      const val = line.split(':').pop().trim();
      for (const d of val.split(',')) {
        const dateStr = d.trim().replace(/T.*/, '');
        if (dateStr.length === 8) exdates.add(dateStr);
      }
    }
    ev.exdates = [...exdates];

    events.push(ev);
  }
  return events;
}

function icalProp(block, name) {
  // Handle both "NAME:value" and "NAME;params:value"
  const regex = new RegExp(`^${name}[;:](.*)`, 'm');
  const m = block.match(regex);
  if (!m) return null;
  const val = m[1];
  // If it has params (;), get everything after the last ':'
  if (m[0].includes(';') && val.includes(':')) {
    return val.split(':').pop().trim();
  }
  return val.trim();
}

function icalDateTime(block, name) {
  const regex = new RegExp(`${name}[^:]*:(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})`);
  const m = block.match(regex);
  if (!m) return null;
  return {
    date: m[1] + m[2] + m[3],
    hour: parseInt(m[4], 10),
    minute: parseInt(m[5], 10),
  };
}

// Expand parsed events into a single target week (weekStart = Monday Date).
// Returns { dayNum(0-6) → [event, …] }, sorted by start time.
export function getEventsForWeek(events, weekStart) {
  const result = {};
  const DAY_MAP = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };

  for (const ev of events) {
    const dayNum = DAY_MAP[ev.byDay];
    if (dayNum === undefined) continue;

    // Compute the target date for this day in the requested week
    const daysFromMonday = dayNum === 0 ? 6 : dayNum - 1;
    const targetDate = new Date(weekStart);
    targetDate.setDate(targetDate.getDate() + daysFromMonday);
    const targetStr = `${targetDate.getFullYear()}${String(targetDate.getMonth() + 1).padStart(2, '0')}${String(targetDate.getDate()).padStart(2, '0')}`;

    // Single event: check if date matches
    if (ev.singleDate) {
      if (ev.singleDate !== targetStr) continue;
    } else if (ev.freq === 'WEEKLY') {
      // Check date range
      if (targetStr < ev.startDate) continue;
      if (ev.until) {
        const untilDate = ev.until.replace(/T.*/, '');
        if (targetStr > untilDate) continue;
      }
      // Check EXDATE (cancelled occurrences)
      if (ev.exdates && ev.exdates.includes(targetStr)) continue;
    } else {
      continue;
    }

    if (!result[dayNum]) result[dayNum] = [];
    result[dayNum].push({
      name: ev.summary,
      startTime: ev.startTime,
      endTime: ev.endTime,
      location: ev.location,
      category: ev.categories,
    });
  }

  // Sort events within each day by start time
  for (const day of Object.keys(result)) {
    result[day].sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  return result;
}

export function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}
