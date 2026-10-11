// ─── Constants ───────────────────────────────────────
const STORAGE_KEY = 'commute-pwa-config';
const REFRESH_MS = 60000;
const DAY_NAMES = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const DAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

// ─── State ───────────────────────────────────────────
let config = null;
let selectedDay = new Date().getDay();
let searchTarget = null; // 'home' | 'work'
let searchAbort = null;
let refreshTimer = null;
let outboundJourneys = null;
let returnJourneys = null;
let outboundError = null;
let returnError = null;
let isLoading = false;
let lastUpdated = null;
let expandedCard = null;
let weekOffset = 0; // 0 = current week, +1 = next, -1 = previous
let timetableData = null; // { week, days: { dayNum: [events] }, cachedAt }
let timetableError = null;
let timetableLoading = false;

// ─── Navigator (ad-hoc routing) state ────────────────
let activeTab = 'dashboard';   // 'dashboard' | 'fahrplan' | 'navigator'
let navFrom = null;            // location object
let navTo = null;
let navTimeMode = 'departure'; // 'departure' | 'arrival'
let navWhen = null;            // null = now, else a Date (manual override)
let navJourneys = null;
let navError = null;
let navLoading = false;
let navLastUpdated = null;
let navLocating = false;
let navInitialized = false;

// ─── Config ──────────────────────────────────────────
function defaultConfig() {
  return {
    homeLocation: null,   // { type, id, name, latitude, longitude, address }
    workLocation: null,
    outboundMode: 'arrival',   // 'departure' | 'arrival'
    returnMode: 'departure',   // 'departure' | 'arrival'
    results: 4,
    viaStops: [],              // [{ id, name, type, latitude, longitude }]
    excludedProducts: [],      // e.g. ['BUS'] — transport types to exclude
    scheduleMode: 'manual',    // 'manual' | 'timetable'
    // Timetable is concept-hardwired to HS Pforzheim · Visuelle Kommunikation.
    // The onboarding picks uni + course for display only; this URL is always used.
    timetableUrl: 'https://hic.hs-pforzheim.de/lsf/rds?state=wplan&act=stg&pool=stg&show=plan&P.vx=mittel&r_zuordabstgv.semvonint=3&r_zuordabstgv.sembisint=3&k_abstgv.abstgvnr=1011',
    timetableLeadMin: 15,      // minutes before first class to arrive
    universityId: 'pforzheim',
    university: 'Hochschule Pforzheim',
    source: 'lsf',             // 'lsf' native picker | 'ics' pasted iCal link
    icsUrl: '',                // the pasted .ics link (kept separate from LSF url)
    courseId: 1011,            // LSF abstgvnr (1011 = Visuelle Kommunikation)
    coursePu: null,            // StarPlan planning unit of the picked group (multi-campus)
    course: 'Visuelle Kommunikation',
    semester: 3,               // semvonint/sembisint
    onboarded: false,          // first-run onboarding completed?
    days: {
      0: { enabled: false, outboundTime: '09:00', returnTime: '14:00' },
      1: { enabled: true,  outboundTime: '08:00', returnTime: '17:00' },
      2: { enabled: true,  outboundTime: '08:00', returnTime: '17:00' },
      3: { enabled: true,  outboundTime: '08:00', returnTime: '17:00' },
      4: { enabled: true,  outboundTime: '08:00', returnTime: '17:00' },
      5: { enabled: true,  outboundTime: '08:00', returnTime: '17:00' },
      6: { enabled: false, outboundTime: '09:00', returnTime: '14:00' },
    }
  };
}

function loadConfig() {
  const def = defaultConfig();
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (!s) return def;
    const c = JSON.parse(s);
    // Migrate old config field names
    if (c.homeStation && !c.homeLocation) { c.homeLocation = c.homeStation; delete c.homeStation; }
    if (c.workStation && !c.workLocation) { c.workLocation = c.workStation; delete c.workStation; }
    if (!c.outboundMode) c.outboundMode = def.outboundMode;
    if (!c.returnMode) c.returnMode = def.returnMode;
    if (!c.scheduleMode) c.scheduleMode = def.scheduleMode;
    if (c.timetableLeadMin === undefined) c.timetableLeadMin = def.timetableLeadMin;
    if (c.courseId === undefined) c.courseId = def.courseId;
    if (c.semester === undefined) c.semester = def.semester;
    if (c.source === undefined) c.source = def.source;
    if (c.icsUrl === undefined) c.icsUrl = def.icsUrl;
    // Existing users (pre-onboarding) with a full setup skip the intro.
    if (c.onboarded === undefined) c.onboarded = !!(c.homeLocation && c.workLocation);
    if (c.days) {
      for (const d of Object.values(c.days)) {
        if (d.departureTime && !d.outboundTime) { d.outboundTime = d.departureTime; delete d.departureTime; }
        if (!d.outboundTime) d.outboundTime = '08:00';
        if (!d.returnTime) d.returnTime = '17:00';
      }
    }
    return { ...def, ...c, days: { ...def.days, ...c.days } };
  } catch (e) { return def; }
}

function saveConfig() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch (e) { /* ignore */ }
}

// ─── API ─────────────────────────────────────────────
// Own backend on the WetOwl box (/api/*, same origin). It asks EFA-BW, which has
// live data Germany-wide; bahn.de blocks server IPs (OPS_BLOCKED) since 2026.
const API = '/api';

async function fetchJson(url, signal) {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function searchLocations(query) {
  if (!query || query.length < 2) return [];
  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();
  return fetchJson(`${API}/locations?query=${encodeURIComponent(query)}`, searchAbort.signal);
}

function normalizeJourneys(data) {
  return (data.journeys || []).map(j => ({
    cancelled: !!j.cancelled,
    legs: j.legs.map(leg => ({
      origin: { name: leg.origin?.name || '' },
      destination: { name: leg.destination?.name || '' },
      plannedDeparture: leg.plannedDeparture,
      departure: leg.departure || leg.plannedDeparture,
      plannedArrival: leg.plannedArrival,
      arrival: leg.arrival || leg.plannedArrival,
      departureDelay: leg.departureDelay || 0,
      arrivalDelay: leg.arrivalDelay || 0,
      departurePlatform: leg.departurePlatform || null,
      arrivalPlatform: leg.arrivalPlatform || null,
      line: leg.line ? { name: leg.line.name, product: leg.line.product } : null,
      direction: leg.direction || null,
      walking: leg.walking || false,
      transfer: leg.transfer || false,
      distance: leg.distance || null,
      cancelled: leg.cancelled || false,
    })),
  }));
}

// opts lets callers override the commute config (the ad-hoc Navigator passes
// empty via/exclude so it isn't constrained by the saved commute route).
async function fetchJourneys(fromLoc, toLoc, timeStr, forDate, mode, opts = {}) {
  const [h, m] = timeStr.split(':').map(Number);
  const timeDate = new Date(forDate.getFullYear(), forDate.getMonth(), forDate.getDate(), h, m);
  const now = new Date();
  const isToday = forDate.toDateString() === now.toDateString();

  const excludedProducts = opts.excludedProducts ?? config.excludedProducts ?? [];
  const viaStops = opts.viaStops ?? config.viaStops ?? [];

  const useArrival = mode === 'arrival' && !(isToday && timeDate < now);
  const timeKey = useArrival ? 'arrival' : 'departure';
  const timeVal = (useArrival ? timeDate : (isToday && timeDate < now ? now : timeDate)).toISOString();
  const results = String(opts.results ?? config.results ?? 4);

  // from/to = stop id string, or the JSON-encoded location (addresses: coordinates).
  const encodeLoc = loc => (loc.type === 'location' && !loc.id) ? JSON.stringify(loc) : loc.id;
  const apiParams = new URLSearchParams({
    from: encodeLoc(fromLoc), to: encodeLoc(toLoc), results, [timeKey]: timeVal,
  });
  if (excludedProducts.length > 0) apiParams.set('excludeProducts', excludedProducts.join(','));
  if (viaStops.length > 0) apiParams.set('via', JSON.stringify(viaStops));

  return normalizeJourneys(await fetchJson(`${API}/journeys?${apiParams}`));
}

// ─── Timetable API ───────────────────────────────────
const TIMETABLE_CACHE_PREFIX = 'commute-pwa-tt-';
const TIMETABLE_MAX_AGE = 60 * 60 * 1000; // 1 hour

function getISOWeekStr(monday) {
  // Proper ISO-8601 week: the week's Thursday decides the week number and year
  // (handles year-boundary weeks correctly). Used as a per-week cache key.
  const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate());
  const thursday = new Date(d);
  thursday.setDate(d.getDate() + 3); // Monday + 3 = Thursday
  const isoYear = thursday.getFullYear();
  const jan1 = new Date(isoYear, 0, 1);
  const days = Math.round((thursday - jan1) / 86400000); // round → no DST hour drift
  const weekNum = Math.floor(days / 7) + 1;
  return `${weekNum}_${isoYear}`;
}

function getTimetableCacheKey() {
  return TIMETABLE_CACHE_PREFIX + getISOWeekStr(getWeekMonday());
}

function loadCachedTimetable() {
  try {
    const key = getTimetableCacheKey();
    const s = localStorage.getItem(key);
    if (s) {
      const cached = JSON.parse(s);
      if (Date.now() - cached.ts < TIMETABLE_MAX_AGE) {
        timetableData = { days: cached.days };
        return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

function saveTimetableCache() {
  try {
    if (timetableData?.days) {
      const key = getTimetableCacheKey();
      localStorage.setItem(key, JSON.stringify({ days: timetableData.days, ts: Date.now() }));
    }
  } catch { /* ignore */ }
}

async function fetchTimetable() {
  if (!config.timetableUrl) return;
  timetableLoading = true;
  timetableError = null;

  const monday = getWeekMonday();
  const pad2 = n => String(n).padStart(2, '0');
  const mondayStr = `${monday.getFullYear()}-${pad2(monday.getMonth() + 1)}-${pad2(monday.getDate())}`;
  const url = `/api/timetable?url=${encodeURIComponent(config.timetableUrl)}&week=${encodeURIComponent(mondayStr)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const result = await res.json();
    timetableData = { days: result.days };
    saveTimetableCache();
  } catch (e) {
    timetableError = e.message || 'Stundenplan konnte nicht geladen werden';
    if (!timetableData && loadCachedTimetable()) {
      timetableError += ' (verwende gespeicherte Daten)';
    }
  }
  timetableLoading = false;
}

function getTimetableDay(dayNum) {
  if (!timetableData?.days) return null;
  return timetableData.days[dayNum] || null;
}

function getTimetableTimes(dayNum) {
  const events = getTimetableDay(dayNum);
  if (!events || events.length === 0) return null;
  const firstStart = events[0].startTime;
  const lastEnd = events[events.length - 1].endTime;
  // Subtract lead time from first start for outbound arrival target
  const [h, m] = firstStart.split(':').map(Number);
  const totalMin = h * 60 + m - (config.timetableLeadMin || 15);
  const outH = Math.floor(Math.max(0, totalMin) / 60);
  const outM = Math.max(0, totalMin) % 60;
  const outboundTime = `${String(outH).padStart(2, '0')}:${String(outM).padStart(2, '0')}`;
  return { outboundTime, returnTime: lastEnd };
}

// ─── Data loading ────────────────────────────────────
async function refreshJourneys() {
  if (!config.homeLocation || !config.workLocation) return;

  // In timetable mode, load timetable first if needed
  if (config.scheduleMode === 'timetable') {
    if (!timetableData && config.timetableUrl) await fetchTimetable();
    const times = getTimetableTimes(selectedDay);
    if (!times) {
      resetJourneys();
      renderDashboard();
      return;
    }
    // Use timetable-derived times
    isLoading = true;
    outboundError = null;
    returnError = null;
    renderDashboard();

    const forDate = getDateForDay(selectedDay);
    const [outRes, retRes] = await Promise.allSettled([
      fetchJourneys(config.homeLocation, config.workLocation, times.outboundTime, forDate, 'arrival'),
      fetchJourneys(config.workLocation, config.homeLocation, times.returnTime, forDate, 'departure'),
    ]);

    outboundJourneys = outRes.status === 'fulfilled' ? outRes.value : null;
    outboundError = outRes.status === 'rejected' ? (outRes.reason?.message || 'Laden fehlgeschlagen') : null;
    returnJourneys = retRes.status === 'fulfilled' ? retRes.value : null;
    returnError = retRes.status === 'rejected' ? (retRes.reason?.message || 'Laden fehlgeschlagen') : null;

    isLoading = false;
    lastUpdated = new Date();
    expandedCard = null;
    renderDashboard();
    return;
  }

  // Manual mode
  const dayConf = config.days[selectedDay];
  if (!dayConf || !dayConf.enabled) {
    resetJourneys();
    renderDashboard();
    return;
  }

  isLoading = true;
  outboundError = null;
  returnError = null;
  renderDashboard();

  const forDate = getDateForDay(selectedDay);

  const [outRes, retRes] = await Promise.allSettled([
    fetchJourneys(config.homeLocation, config.workLocation, dayConf.outboundTime, forDate, config.outboundMode),
    fetchJourneys(config.workLocation, config.homeLocation, dayConf.returnTime, forDate, config.returnMode),
  ]);

  outboundJourneys = outRes.status === 'fulfilled' ? outRes.value : null;
  outboundError = outRes.status === 'rejected' ? (outRes.reason?.message || 'Laden fehlgeschlagen') : null;
  returnJourneys = retRes.status === 'fulfilled' ? retRes.value : null;
  returnError = retRes.status === 'rejected' ? (retRes.reason?.message || 'Laden fehlgeschlagen') : null;

  isLoading = false;
  lastUpdated = new Date();
  expandedCard = null;
  renderDashboard();
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    // Skip while the tab is backgrounded — no point burning API calls/battery
    // on data the user can't see; we refresh again on return to foreground.
    if (document.visibilityState !== 'visible') return;
    if (activeTab === 'navigator') {
      if (!navWhen && navFrom && navTo) refreshNavigator(); // only auto-refresh "now"
    } else if (selectedDay === new Date().getDay()) {
      refreshJourneys();
    }
  }, REFRESH_MS);
}

function stopAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

function getDateForDay(day) {
  // Start from Monday of the target week, then add days to reach the requested day
  const monday = getWeekMonday();
  const daysFromMonday = day === 0 ? 6 : day - 1; // Sunday = 6 days after Monday
  const d = new Date(monday);
  d.setDate(d.getDate() + daysFromMonday);
  // For today in the current week, return now (preserves current time for "is past?" checks)
  const now = new Date();
  if (weekOffset === 0 && d.toDateString() === now.toDateString()) return now;
  d.setHours(0, 0, 0, 0);
  return d;
}

function getWeekMonday() {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(monday.getDate() + diff + weekOffset * 7);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

async function changeWeek(delta) {
  weekOffset += delta;
  expandedCard = null;
  resetJourneys();
  timetableData = null;
  // Try loading from per-week cache first
  loadCachedTimetable();
  renderActiveTab();
  await refreshJourneys();
  renderActiveTab();
}

// ─── Mode labels ─────────────────────────────────────
function outboundTimeLabel() {
  return config.outboundMode === 'arrival' ? 'Ankunft' : 'Abfahrt';
}
function returnTimeLabel() {
  return config.returnMode === 'departure' ? 'Feierabend' : 'Ankunft';
}
function sectionTimePrefix(dir) {
  if (config.scheduleMode === 'timetable') {
    return dir === 'outbound' ? 'Ank.' : 'ab';
  }
  if (dir === 'outbound') return config.outboundMode === 'arrival' ? 'Ank.' : 'Abf.';
  return config.returnMode === 'departure' ? 'ab' : 'Ank.';
}

// ─── Rendering: Dashboard ────────────────────────────
function renderDashboard() {
  const el = document.getElementById('view-dashboard');
  document.getElementById('header-date').textContent = formatDateShort(getDateForDay(selectedDay));

  if (!config.homeLocation || !config.workLocation) {
    el.innerHTML = renderSetupPrompt();
    return;
  }

  let html = renderDayBar();

  const isTimetable = config.scheduleMode === 'timetable';

  // Determine if this day has commute
  let dayActive, outTime, retTime;
  if (isTimetable) {
    const times = getTimetableTimes(selectedDay);
    dayActive = !!times;
    outTime = times?.outboundTime;
    retTime = times?.returnTime;
  } else {
    const dayConf = config.days[selectedDay];
    dayActive = dayConf?.enabled;
    outTime = dayConf?.outboundTime;
    retTime = dayConf?.returnTime;
  }

  if (!dayActive) {
    if (isTimetable) {
      html += renderNoLectures();
    } else {
      html += renderNoCommute();
    }
    el.innerHTML = html;
    return;
  }

  // Show timetable events if in timetable mode
  if (isTimetable) {
    const events = getTimetableDay(selectedDay);
    if (events && events.length > 0) {
      html += renderTimetableEvents(events);
    }
  }

  if (isLoading && !outboundJourneys && !returnJourneys) {
    html += renderLoadingSkeleton();
    el.innerHTML = html;
    return;
  }

  if (lastUpdated) {
    html += `<div class="last-updated">
      <span>Aktualisiert ${formatTimeAgo(lastUpdated)}</span>
      <button class="refresh-btn${isLoading ? ' spinning' : ''}" onclick="refreshJourneys()" aria-label="Aktualisieren">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
      </button>
    </div>`;
  }

  const outLabel = isTimetable ? 'Zur Hochschule' : 'Zur Arbeit';
  const retLabel = 'Nach Hause';
  html += renderSection('outbound', outLabel, config.homeLocation.name, config.workLocation.name, outTime, outboundJourneys, outboundError);
  html += renderSection('return', retLabel, config.workLocation.name, config.homeLocation.name, retTime, returnJourneys, returnError);

  el.innerHTML = html;

  if (expandedCard) {
    const card = el.querySelector(`[data-card-id="${expandedCard}"]`);
    if (card) { card.classList.add('expanded'); card.setAttribute('aria-expanded', 'true'); }
  }
}

function renderTimetableEvents(events) {
  let html = '<div class="timetable-events">';
  html += '<div class="timetable-events-title">Vorlesungen</div>';
  html += '<div class="timetable-events-list">';
  for (const ev of events) {
    const nameParts = ev.name.split(' - ');
    const code = nameParts.length > 1 ? nameParts[0] : '';
    const name = nameParts.length > 1 ? nameParts.slice(1).join(' - ') : ev.name;
    html += `<div class="timetable-event">
      <div class="timetable-event-time">${ev.startTime}\u2009\u2013\u2009${ev.endTime}</div>
      <div class="timetable-event-info">
        <div class="timetable-event-name">${escHtml(name)}</div>
        <div class="timetable-event-meta">${code ? `<span class="timetable-event-code">${escHtml(code)}</span>` : ''}${ev.location ? `<span class="timetable-event-room">${escHtml(ev.location)}</span>` : ''}</div>
      </div>
    </div>`;
  }
  html += '</div></div>';
  return html;
}

function renderNoLectures() {
  return `<div class="no-commute">
    <div class="no-commute-icon">\u{1F4DA}</div>
    <h3>Keine Vorlesungen am ${DAY_NAMES[selectedDay]}</h3>
    <p>Laut Stundenplan sind heute keine Veranstaltungen geplant.</p>
  </div>`;
}

function renderDayBar() {
  const today = new Date().getDay();
  const order = [1,2,3,4,5,6,0];
  const isTimetable = config.scheduleMode === 'timetable';

  const monday = getWeekMonday();
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const fmt = d => `${d.getDate()}.${d.getMonth() + 1}.`;
  const weekLabel = weekOffset === 0 ? 'Diese Woche' : `${fmt(monday)} \u2013 ${fmt(sunday)}`;

  let html = `<div class="week-nav">
    <button class="week-btn" onclick="changeWeek(-1)">\u2039</button>
    <span class="week-label">${weekLabel}</span>
    <button class="week-btn" onclick="changeWeek(1)">\u203A</button>
  </div>`;

  html += '<div class="day-bar">';
  for (const d of order) {
    const isToday = d === today && weekOffset === 0;
    const isActive = d === selectedDay;
    let disabled;
    if (isTimetable) {
      disabled = !getTimetableDay(d);
    } else {
      disabled = !config.days[d]?.enabled;
    }
    const cls = ['day-pill'];
    if (isActive) cls.push('active');
    if (isToday) cls.push('today');
    if (disabled && !isActive) cls.push('disabled');
    html += `<button class="${cls.join(' ')}" onclick="selectDay(${d})">${DAY_SHORT[d]}</button>`;
  }
  html += '</div>';
  return html;
}

function renderSection(dir, title, fromName, toName, time, journeys, error) {
  const iconCls = dir === 'outbound' ? 'outbound' : 'return';
  const icon = dir === 'outbound' ? '\u2192' : '\u2190';
  const prefix = sectionTimePrefix(dir);

  let html = `<div class="section">
    <div class="section-header">
      <div class="section-icon ${iconCls}">${icon}</div>
      <div>
        <div class="section-title">${title}</div>
        <div class="section-route">${truncate(fromName, 24)} \u2192 ${truncate(toName, 24)}</div>
      </div>
      <div class="section-meta"><span class="section-time">${prefix} ${time}</span></div>
    </div>`;

  if (error) {
    html += `<div class="error-card"><p>${escHtml(error)}</p><button class="error-retry" onclick="refreshJourneys()">Erneut versuchen</button></div>`;
  } else if (journeys && journeys.length > 0) {
    journeys.forEach((j, i) => { html += renderJourneyCard(j, dir, i); });
  } else if (journeys && journeys.length === 0) {
    html += `<div class="error-card"><p>Keine Verbindungen gefunden</p><button class="error-retry" onclick="refreshJourneys()">Erneut versuchen</button></div>`;
  } else if (isLoading) {
    html += renderLoadingSkeleton(1);
  }

  html += '</div>';
  return html;
}

function renderJourneyCard(journey, dir, idx) {
  const legs = journey.legs || [];
  const first = legs[0];
  const last = legs[legs.length - 1];
  if (!first || !last) return '';

  const depPlanned = first.plannedDeparture || first.departure;
  const depActual = first.departure;
  const arrPlanned = last.plannedArrival || last.arrival;
  const arrActual = last.arrival;
  const depDelay = first.departureDelay || 0;
  const arrDelay = last.arrivalDelay || 0;
  const maxDelay = Math.max(depDelay, arrDelay);

  const duration = (new Date(arrActual) - new Date(depActual)) / 1000;
  const transfers = legs.filter(l => !l.walking && !l.transfer).length - 1;

  const cardId = `${dir}-${idx}`;

  return `<div class="journey-card" data-card-id="${cardId}" role="button" tabindex="0" aria-expanded="false" onclick="toggleCard('${cardId}')" onkeydown="onCardKey(event,'${cardId}')">
    <div class="journey-summary">
      <div class="journey-times-row">
        <div class="journey-time">
          ${depDelay > 0 ? `<span class="journey-time-delayed">${fmtTime(depPlanned)}</span> <span class="journey-time-actual">${fmtTime(depActual)}</span>` : fmtTime(depPlanned)}
        </div>
        <div class="journey-arrow">
          <span class="journey-arrow-line"></span>
          <span class="journey-arrow-tip">\u25B8</span>
        </div>
        <span class="journey-duration">${fmtDuration(duration)}</span>
        <div class="journey-time" style="text-align:right">
          ${arrDelay > 0 ? `<span class="journey-time-delayed">${fmtTime(arrPlanned)}</span> <span class="journey-time-actual">${fmtTime(arrActual)}</span>` : fmtTime(arrPlanned)}
        </div>
      </div>
      <div class="journey-info">
        <div class="journey-lines">
          ${legs.filter(l => !l.walking && !l.transfer).map(l => {
            const color = productColor(l.line?.product);
            const name = l.line?.name || '?';
            return `<span class="line-badge" style="background:${color}">${escHtml(name)}</span>`;
          }).join('')}
        </div>
        <div class="journey-meta">
          <span class="journey-transfers">${transfers === 0 ? 'Direkt' : transfers + ' Umst.'}</span>
          ${renderDelayBadge(maxDelay)}
        </div>
      </div>
    </div>
    <div class="journey-details"><div class="journey-details-inner">
      ${renderLegs(legs)}
    </div></div>
  </div>`;
}

function renderDelayBadge(delaySec) {
  if (delaySec <= 0) return `<span class="delay-badge on-time">\u2713 P\u00fcnktlich</span>`;
  const min = Math.round(delaySec / 60);
  if (min <= 5) return `<span class="delay-badge delayed">+${min}\u2009Min.</span>`;
  return `<span class="delay-badge severe">+${min}\u2009Min.</span>`;
}

function renderLegs(legs) {
  let html = '';
  legs.forEach((leg, i) => {
    const isLast = i === legs.length - 1;
    const color = leg.walking ? 'var(--product-walk)' : productColor(leg.line?.product);

    if (leg.walking) {
      const walkMin = leg.departure && leg.arrival ? Math.round((new Date(leg.arrival) - new Date(leg.departure)) / 60000) : '?';
      html += `<div class="leg">
        <div class="leg-timeline">
          <div class="leg-dot" style="border-color:${color}"></div>
          ${isLast ? '' : `<div class="leg-line" style="background:${color}; opacity:0.4"></div>`}
        </div>
        <div class="leg-content">
          <div class="leg-station">${escHtml(leg.origin?.name || leg.origin?.address || '')}</div>
          <div class="leg-walk">Fu\u00dfweg ${walkMin} Min.${leg.distance ? ` (${leg.distance}\u2009m)` : ''}</div>
        </div>
      </div>`;
      return;
    }

    const depPlanned = leg.plannedDeparture || leg.departure;
    const depActual = leg.departure;
    const depDelay = leg.departureDelay || 0;
    const arrPlanned = leg.plannedArrival || leg.arrival;
    const arrActual = leg.arrival;
    const arrDelay = leg.arrivalDelay || 0;

    html += `<div class="leg">
      <div class="leg-timeline">
        <div class="leg-dot" style="border-color:${color}"></div>
        <div class="leg-line" style="background:${color}"></div>
      </div>
      <div class="leg-content">
        <div class="leg-time">
          ${depDelay > 0 ? `<span class="leg-time-delayed">${fmtTime(depPlanned)}</span> <span class="leg-time-actual">${fmtTime(depActual)}</span>` : fmtTime(depPlanned)}
        </div>
        <div class="leg-station">${escHtml(leg.origin?.name || '')}</div>
        ${leg.departurePlatform ? `<div class="leg-platform">Gleis ${escHtml(leg.departurePlatform)}</div>` : ''}
        <div class="leg-transport">
          <span class="line-badge" style="background:${color}">${escHtml(leg.line?.name || '?')}</span>
          <span class="leg-direction">\u2192 ${escHtml(leg.direction || '')}</span>
        </div>
      </div>
    </div>`;

    html += `<div class="leg">
      <div class="leg-timeline">
        <div class="leg-dot-end" style="background:${color}"></div>
        ${isLast ? '' : `<div class="leg-line" style="background:var(--product-walk); opacity:0.3"></div>`}
      </div>
      <div class="leg-content">
        <div class="leg-time">
          ${arrDelay > 0 ? `<span class="leg-time-delayed">${fmtTime(arrPlanned)}</span> <span class="leg-time-actual">${fmtTime(arrActual)}</span>` : fmtTime(arrPlanned)}
        </div>
        <div class="leg-station">${escHtml(leg.destination?.name || '')}</div>
        ${leg.arrivalPlatform ? `<div class="leg-platform">Gleis ${escHtml(leg.arrivalPlatform)}</div>` : ''}
      </div>
    </div>`;
  });
  return html;
}

function renderSetupPrompt() {
  return `<div class="setup-prompt">
    <div class="setup-icon">\u{1F686}</div>
    <div class="setup-title">Pendler einrichten</div>
    <div class="setup-text">Lege deine Heim- und Arbeitsadresse fest, um t\u00e4glich deine Verbindungen auf einen Blick zu sehen.</div>
    <button class="setup-btn" onclick="openSettings()">Einrichten</button>
  </div>`;
}

function renderNoCommute() {
  return `<div class="no-commute">
    <div class="no-commute-icon">\u{1F634}</div>
    <h3>Kein Pendeln am ${DAY_NAMES[selectedDay]}</h3>
    <p>Dieser Tag ist in deinem Wochenplan deaktiviert.</p>
  </div>`;
}

function renderLoadingSkeleton(count) {
  count = count || 2;
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `<div class="skeleton-card">
      <div class="skeleton-line tall w80"></div>
      <div class="skeleton-line w60"></div>
      <div class="skeleton-line w40"></div>
    </div>`;
  }
  return html;
}

// ─── Rendering: Schedule ─────────────────────────────
function renderSchedule() {
  const el = document.getElementById('settings-content');
  const order = [1,2,3,4,5,6,0];
  const isTimetable = config.scheduleMode === 'timetable';

  let html = `
    <div class="schedule-section">
      <div class="schedule-section-title">Standorte</div>
      <div class="station-card">
        <div class="station-row" role="button" tabindex="0" onclick="openSearch('home')" onkeydown="onKeyActivate(event)">
          <div class="station-icon home">\u{1F3E0}</div>
          <div>
            <div class="station-label">Zuhause</div>
            <div class="station-name${config.homeLocation ? '' : ' placeholder'}">${config.homeLocation ? escHtml(config.homeLocation.name || config.homeLocation.address) : 'Adresse oder Station w\u00e4hlen'}</div>
          </div>
          <div class="station-chevron">\u203A</div>
        </div>
        <div class="station-row" role="button" tabindex="0" onclick="openSearch('work')" onkeydown="onKeyActivate(event)">
          <div class="station-icon work">${isTimetable ? '\u{1F393}' : '\u{1F3E2}'}</div>
          <div>
            <div class="station-label">${isTimetable ? 'Hochschule' : 'Arbeit'}</div>
            <div class="station-name${config.workLocation ? '' : ' placeholder'}">${config.workLocation ? escHtml(config.workLocation.name || config.workLocation.address) : 'Adresse oder Station w\u00e4hlen'}</div>
          </div>
          <div class="station-chevron">\u203A</div>
        </div>
      </div>
    </div>

    <div class="schedule-section">
      <div class="schedule-section-title">Route</div>
      <div class="station-card">
        ${renderViaStops()}
        <div class="station-row via-add" role="button" tabindex="0" onclick="openSearch('via')" onkeydown="onKeyActivate(event)">
          <div class="station-icon via">+</div>
          <div>
            <div class="station-name placeholder">Zwischenhalt hinzuf\u00fcgen</div>
          </div>
          <div class="station-chevron">\u203A</div>
        </div>
        ${renderProductFilter()}
      </div>
    </div>

    <div class="schedule-section">
      <div class="schedule-section-title">Datenquelle</div>
      <div class="mode-card">
        <div class="mode-row">
          <span class="mode-label">Zeitplan</span>
          <div class="mode-toggle">
            <button class="mode-btn${!isTimetable ? ' active' : ''}" onclick="setScheduleMode('manual')">Manuell</button>
            <button class="mode-btn${isTimetable ? ' active' : ''}" onclick="setScheduleMode('timetable')">Stundenplan</button>
          </div>
        </div>
      </div>
    </div>`;

  if (isTimetable) {
    html += renderTimetableSettings();
  } else {
    html += `
    <div class="schedule-section">
      <div class="schedule-section-title">Zeitmodus</div>
      <div class="mode-card">
        <div class="mode-row">
          <span class="mode-label">Hinfahrt</span>
          <div class="mode-toggle">
            <button class="mode-btn${config.outboundMode === 'departure' ? ' active' : ''}" onclick="setMode('outbound','departure')">Abfahrt</button>
            <button class="mode-btn${config.outboundMode === 'arrival' ? ' active' : ''}" onclick="setMode('outbound','arrival')">Ankunft</button>
          </div>
        </div>
        <div class="mode-row">
          <span class="mode-label">R\u00fcckfahrt</span>
          <div class="mode-toggle">
            <button class="mode-btn${config.returnMode === 'departure' ? ' active' : ''}" onclick="setMode('return','departure')">Feierabend</button>
            <button class="mode-btn${config.returnMode === 'arrival' ? ' active' : ''}" onclick="setMode('return','arrival')">Ankunft</button>
          </div>
        </div>
      </div>
    </div>

    <div class="schedule-section">
      <div class="schedule-section-title">Wochenplan</div>
      ${order.map(d => renderDayCard(d)).join('')}
    </div>`;
  }

  html += `
    <div class="schedule-section">
      <button class="ob-restart-btn" onclick="restartOnboarding()">Einrichtung neu starten</button>
    </div>`;

  el.innerHTML = html;
}

const PRODUCT_LABELS = {
  BUS: 'Bus', TRAM: 'Stadtbahn', UBAHN: 'U-Bahn', SBAHN: 'S-Bahn',
  REGIONAL: 'Regionalbahn', IR: 'RegionalExpress', EC_IC: 'IC/EC', ICE: 'ICE',
};

function renderViaStops() {
  if (!config.viaStops?.length) return '';
  return config.viaStops.map((stop, i) => `
    <div class="station-row via-stop">
      <div class="station-icon via">\u{1F4CD}</div>
      <div>
        <div class="station-label">Zwischenhalt ${config.viaStops.length > 1 ? i + 1 : ''}</div>
        <div class="station-name">${escHtml(stop.name)}</div>
      </div>
      <button class="via-remove" onclick="removeViaStop(${i})" aria-label="Entfernen">\u00D7</button>
    </div>
  `).join('');
}

function renderProductFilter() {
  const excluded = new Set(config.excludedProducts || []);
  let html = '<div class="product-filter">';
  html += '<div class="product-filter-label">Verkehrsmittel</div>';
  html += '<div class="product-chips">';
  for (const [key, label] of Object.entries(PRODUCT_LABELS)) {
    const active = !excluded.has(key);
    html += `<button class="product-chip${active ? ' active' : ''}" onclick="toggleProduct('${key}')">${label}</button>`;
  }
  html += '</div></div>';
  return html;
}

function removeViaStop(idx) {
  config.viaStops.splice(idx, 1);
  saveConfig();
  renderSchedule();
  invalidateJourneys();
}

function toggleProduct(product) {
  if (!config.excludedProducts) config.excludedProducts = [];
  const idx = config.excludedProducts.indexOf(product);
  if (idx >= 0) config.excludedProducts.splice(idx, 1);
  else config.excludedProducts.push(product);
  saveConfig();
  renderSchedule();
  invalidateJourneys();
}

// Clear the dashboard's loaded commute journeys (e.g. after a config change).
function resetJourneys() {
  outboundJourneys = null;
  returnJourneys = null;
  lastUpdated = null;
}

function invalidateJourneys() {
  if (config.homeLocation && config.workLocation) {
    resetJourneys();
    refreshJourneys();
  }
}

function renderTimetableSettings() {
  let html = `
    <div class="schedule-section">
      <div class="schedule-section-title">Stundenplan</div>
      <div class="station-card">
        <div class="station-row" role="button" tabindex="0" onclick="editStundenplan()" onkeydown="onKeyActivate(event)">
          <div class="station-icon work">\u{1F393}</div>
          <div>
            <div class="station-label">Hochschule</div>
            <div class="station-name">${escHtml(config.university || 'Hochschule Pforzheim')}</div>
          </div>
          <div class="station-chevron">›</div>
        </div>
        ${config.source === 'ics' ? `
        <div class="station-row" role="button" tabindex="0" onclick="editStundenplan()" onkeydown="onKeyActivate(event)">
          <div class="station-icon via">\u{1F517}</div>
          <div>
            <div class="station-label">iCal-Link</div>
            <div class="station-name${config.timetableUrl ? '' : ' placeholder'}">${config.timetableUrl ? escHtml(config.timetableUrl.replace(/^https?:\/\//, '').slice(0, 42)) : 'Link hinzufügen'}</div>
          </div>
          <div class="station-chevron">›</div>
        </div>` : `
        <div class="station-row" role="button" tabindex="0" onclick="editStundenplan()" onkeydown="onKeyActivate(event)">
          <div class="station-icon via">\u{1F4DA}</div>
          <div>
            <div class="station-label">Studiengang</div>
            <div class="station-name">${escHtml(config.course || 'Visuelle Kommunikation')}</div>
          </div>
          <div class="station-chevron">›</div>
        </div>
        ${config.source === 'lsf' ? `
        <div class="station-row" role="button" tabindex="0" onclick="editStundenplan()" onkeydown="onKeyActivate(event)">
          <div class="station-icon home">\u{1F4C5}</div>
          <div>
            <div class="station-label">Semester</div>
            <div class="station-name">${config.semester || 3}. Semester</div>
          </div>
          <div class="station-chevron">›</div>
        </div>` : ''}`}
        <div class="timetable-url-row">
          <label class="timetable-label" for="timetable-lead">Vorlaufzeit (Min.)</label>
          <input type="number" id="timetable-lead" class="timetable-input short" min="0" max="120" value="${config.timetableLeadMin || 15}" onchange="setTimetableLead(this.value)">
          <span class="timetable-hint">vor erster Vorlesung ankommen</span>
        </div>
        <div class="timetable-actions">
          <button class="timetable-refresh-btn" onclick="reloadTimetable()" ${timetableLoading ? 'disabled' : ''}>
            ${timetableLoading ? 'Laden\u2026' : 'Stundenplan laden'}
          </button>
          ${timetableError ? `<div class="timetable-error">${escHtml(timetableError)}</div>` : ''}
          ${timetableData ? `<div class="timetable-status">Geladen \u2013 ${Object.keys(timetableData.days || {}).length} Tage mit Vorlesungen</div>` : ''}
        </div>
      </div>
    </div>`;

  // Show preview of loaded timetable
  if (timetableData?.days) {
    const order = [1,2,3,4,5,6,0];
    html += '<div class="schedule-section"><div class="schedule-section-title">Wochenplan (KW)</div>';
    for (const d of order) {
      const events = getTimetableDay(d);
      if (!events) {
        html += `<div class="day-card disabled"><div class="day-card-header"><span class="day-card-name">${DAY_NAMES[d]}</span><span class="day-card-off">Frei</span></div></div>`;
        continue;
      }
      const times = getTimetableTimes(d);
      html += `<div class="day-card">
        <div class="day-card-header"><span class="day-card-name">${DAY_NAMES[d]}</span><span class="day-card-count">${events.length} Veranstaltung${events.length > 1 ? 'en' : ''}</span></div>
        <div class="day-card-times">
          <div class="time-field">
            <div class="time-label">Erste</div>
            <div class="time-value">${events[0].startTime}</div>
          </div>
          <div class="time-field">
            <div class="time-label">Letzte bis</div>
            <div class="time-value">${events[events.length - 1].endTime}</div>
          </div>
          <div class="time-field">
            <div class="time-label">Ankunft</div>
            <div class="time-value">${times.outboundTime}</div>
          </div>
        </div>
      </div>`;
    }
    html += '</div>';
  }

  return html;
}

function renderDayCard(day) {
  const d = config.days[day];
  return `<div class="day-card${d.enabled ? '' : ' disabled'}">
    <div class="day-card-header">
      <span class="day-card-name">${DAY_NAMES[day]}</span>
      <label class="toggle">
        <input type="checkbox" ${d.enabled ? 'checked' : ''} onchange="toggleDay(${day}, this.checked)">
        <span class="toggle-track"></span>
        <span class="toggle-thumb"></span>
      </label>
    </div>
    ${d.enabled ? `<div class="day-card-times">
      <div class="time-field">
        <div class="time-label">${outboundTimeLabel()}</div>
        <input class="time-input" type="time" value="${d.outboundTime}" onchange="updateTime(${day},'outboundTime',this.value)">
      </div>
      <div class="time-field">
        <div class="time-label">${returnTimeLabel()}</div>
        <input class="time-input" type="time" value="${d.returnTime}" onchange="updateTime(${day},'returnTime',this.value)">
      </div>
    </div>` : ''}
  </div>`;
}

// ─── Station / address search ────────────────────────
let searchDebounce = null;

function openSearch(target) {
  searchTarget = target;
  const overlay = document.getElementById('search-overlay');
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  overlay.classList.remove('hidden');
  results.innerHTML = '<div class="search-empty">Station oder Adresse eingeben</div>';
  input.value = '';
  setTimeout(() => input.focus(), 100);
}

function closeSearch() {
  document.getElementById('search-overlay').classList.add('hidden');
  searchTarget = null;
}

function onSearchInput(query) {
  clearTimeout(searchDebounce);
  const results = document.getElementById('search-results');

  if (!query || query.length < 2) {
    results.innerHTML = '<div class="search-empty">Station oder Adresse eingeben</div>';
    return;
  }

  results.innerHTML = '<div class="search-loading">Suche\u2026</div>';

  searchDebounce = setTimeout(async () => {
    try {
      const locations = await searchLocations(query);
      if (!locations.length) {
        results.innerHTML = '<div class="search-empty">Keine Ergebnisse gefunden</div>';
        return;
      }
      results.innerHTML = locations.map(loc => {
        const isAddress = loc.type === 'location';
        const icon = isAddress ? '\u{1F4CD}' : '\u{1F689}';
        const typeLabel = isAddress ? 'Adresse' : '';
        const stored = {
          type: loc.type || 'stop',
          id: loc.id,
          name: loc.name || loc.address,
          latitude: loc.latitude ?? loc.location?.latitude,
          longitude: loc.longitude ?? loc.location?.longitude,
          address: loc.address,
        };
        const products = !isAddress && loc.products ? Object.entries(loc.products).filter(([,v]) => v).map(([k]) => k) : [];

        return `<div class="search-result" role="button" tabindex="0" onclick="selectLocation(${escAttr(JSON.stringify(stored))})" onkeydown="onKeyActivate(event)">
          <div class="search-result-icon">${icon}</div>
          <div>
            <div class="search-result-name">${escHtml(loc.name || loc.address || '')}</div>
            ${typeLabel ? `<div class="search-result-type">${typeLabel}</div>` : ''}
            ${products.length ? `<div class="search-result-products">${products.slice(0, 5).map(p => `<span class="search-result-product">${escHtml(p)}</span>`).join('')}</div>` : ''}
          </div>
        </div>`;
      }).join('');
    } catch (e) {
      if (e.name === 'AbortError') return;
      results.innerHTML = '<div class="search-empty">Suche fehlgeschlagen. Pr\u00fcfe deine Verbindung.</div>';
    }
  }, 300);
}

function selectLocation(locJson) {
  const loc = typeof locJson === 'string' ? JSON.parse(locJson) : locJson;

  // Navigator targets are transient (not saved to the commute config).
  if (searchTarget === 'nav-from' || searchTarget === 'nav-to') {
    if (searchTarget === 'nav-to') navTo = loc; else navFrom = loc;
    navJourneys = null; expandedCard = null;
    closeSearch();
    renderNavigator();
    refreshNavigator();
    return;
  }

  if (searchTarget === 'home') config.homeLocation = loc;
  else if (searchTarget === 'work') config.workLocation = loc;
  else if (searchTarget === 'via') {
    if (!config.viaStops) config.viaStops = [];
    config.viaStops.push(loc);
  }
  saveConfig();

  // During first-run onboarding the search returns to the onboarding step,
  // not the settings sheet.
  if (onboarding) { closeSearch(); renderOnboarding(); return; }

  closeSearch();
  renderSchedule();
  invalidateJourneys();
}

// ─── Settings sheet ─────────────────────────────────
function openSettings() {
  renderSchedule();
  document.getElementById('settings-overlay').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.add('hidden');
}

function selectDay(day) {
  selectedDay = day;
  expandedCard = null;
  resetJourneys();
  renderDashboard();
  refreshJourneys();
}

function toggleCard(cardId) {
  expandedCard = expandedCard === cardId ? null : cardId;
  document.querySelectorAll('.journey-card').forEach(c => {
    const on = c.dataset.cardId === expandedCard;
    c.classList.toggle('expanded', on);
    c.setAttribute('aria-expanded', on ? 'true' : 'false');
  });
}

// Space/Enter activate the card like a real button (it's a div with role=button).
function onCardKey(e, cardId) {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCard(cardId); }
}

// Generic keyboard activation for div[role=button] rows — fires their onclick.
function onKeyActivate(e) {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); }
}

function toggleDay(day, enabled) {
  config.days[day].enabled = enabled;
  saveConfig();
  renderSchedule();
}

function updateTime(day, field, value) {
  config.days[day][field] = value;
  saveConfig();
}

function setMode(direction, mode) {
  if (direction === 'outbound') config.outboundMode = mode;
  else config.returnMode = mode;
  saveConfig();
  renderSchedule();
  invalidateJourneys();
}

function setScheduleMode(mode) {
  config.scheduleMode = mode;
  saveConfig();
  resetJourneys();
  renderSchedule();
  if (mode === 'timetable' && config.timetableUrl && !timetableData) {
    reloadTimetable();
  }
}

function setTimetableLead(val) {
  config.timetableLeadMin = Math.max(0, parseInt(val, 10) || 15);
  saveConfig();
}

async function reloadTimetable() {
  if (!config.timetableUrl) return;
  timetableData = null;
  timetableError = null;
  renderSchedule();
  await fetchTimetable();
  renderSchedule();
  invalidateJourneys();
}

// ─── Onboarding (first-run setup) ────────────────────
// Concept flow: Welcome → Standorte → Hochschule/Studiengang → Fertig.
// The Stundenplan step is a dummy picker — any choice keeps the default LSF URL.
const OB_STEPS = 4;
let onboarding = false;
let onboardStep = 0;
let obPickerMode = null;  // full-screen picker: 'uni' | 'course' | null
let obPickerQuery = '';

// Universities: 'lsf' = native course picker (host/path + course catalog);
// 'ics' = generic fallback where the user pastes a timetable .ics link that the
// backend loads directly (works for any uni/system that exports iCal).
// Every LSF entry was verified end-to-end (catalog → wplan → iCalendarPlan →
// real events); instances without that export (e.g. Münster, Weimar) are
// deliberately absent — they fall back to 'Andere Hochschule'.
// Mirrored in unis/index.json (+ unis/pforzheim.json), which the iPhone app reads:
// change both together.
const UNIVERSITIES = [
  { id: 'pforzheim', name: 'Hochschule Pforzheim', system: 'lsf', host: 'hic.hs-pforzheim.de', path: '/lsf' },
  { id: 'uni-frankfurt', name: 'Goethe-Universität Frankfurt', system: 'lsf', host: 'qis.server.uni-frankfurt.de', path: '/qisserver', catalog: 'unis/uni-frankfurt.json' },
  { id: 'hhu', name: 'Heinrich-Heine-Universität Düsseldorf', system: 'lsf', host: 'lsf.hhu.de', path: '/qisserver', catalog: 'unis/hhu.json' },
  { id: 'hs-weingarten', name: 'Hochschule Ravensburg-Weingarten', system: 'lsf', host: 'lsf.hs-weingarten.de', path: '/qisserver', catalog: 'unis/hs-weingarten.json' },
  { id: 'hs-worms', name: 'Hochschule Worms', system: 'lsf', host: 'lsf.hs-worms.de', path: '/qisserver', catalog: 'unis/hs-worms.json' },
  // StarPlan: groups already encode program+semester; timetable = direct .ics.
  // pu = current planning unit — bump + re-run scrape-starplan each semester.
  // Catalog entries may carry their own pu (multi-campus instances like W-HS).
  { id: 'hdm-stuttgart', name: 'Hochschule der Medien Stuttgart', system: 'starplan', host: 'splan.hdm-stuttgart.de', base: '/splan', pu: 45, catalog: 'unis/hdm-stuttgart.json' },
  { id: 'hs-heilbronn', name: 'Hochschule Heilbronn', system: 'starplan', host: 'splan.hs-heilbronn.de', base: '/splan', pu: 47, catalog: 'unis/hs-heilbronn.json' },
  { id: 'hs-furtwangen', name: 'Hochschule Furtwangen', system: 'starplan', host: 'splan.hs-furtwangen.de', base: '/starplan', pu: 6, catalog: 'unis/hs-furtwangen.json' },
  { id: 'th-rosenheim', name: 'TH Rosenheim', system: 'starplan', host: 'splan.th-rosenheim.de', base: '/splan', pu: 44, catalog: 'unis/th-rosenheim.json' },
  { id: 'w-hs', name: 'Westfälische Hochschule', system: 'starplan', host: 'splan.w-hs.de', base: '/splan', pu: 100, catalog: 'unis/w-hs.json' },
  { id: 'htw-berlin', name: 'HTW Berlin', system: 'lsf', host: 'lsf.htw-berlin.de', path: '/qisserver', catalog: 'unis/htw-berlin.json' },
  { id: 'uni-saarland', name: 'Universität des Saarlandes', system: 'lsf', host: 'www.lsf.uni-saarland.de', path: '/qisserver', catalog: 'unis/uni-saarland.json' },
  { id: 'uni-hildesheim', name: 'Universität Hildesheim', system: 'lsf', host: 'lsf.uni-hildesheim.de', path: '/qisserver', catalog: 'unis/uni-hildesheim.json' },
  { id: 'other', name: 'Andere Hochschule', system: 'ics' },
];
function selectedUni() { return UNIVERSITIES.find(u => u.id === config.universityId) || UNIVERSITIES[0]; }

// Course catalogs: Pforzheim is baked in (default uni, works offline); the rest
// are static JSON fetched on demand. null = not loaded yet.
// (Pforzheim resolved inside coursesFor — HSPF_COURSES is declared below.)
const uniCatalogs = {};
const catalogFetching = new Set();
function coursesFor(uniId) {
  if (uniId === 'pforzheim') return HSPF_COURSES;
  return uniCatalogs[uniId] || null;
}
function loadCatalog(uni) {
  if (!uni.catalog || uniCatalogs[uni.id] || catalogFetching.has(uni.id)) return;
  catalogFetching.add(uni.id);
  fetch(uni.catalog)
    .then(r => { if (!r.ok) throw new Error(); return r.json(); })
    .then(list => { uniCatalogs[uni.id] = list; })
    .catch(() => { uniCatalogs[uni.id] = []; })
    .finally(() => {
      catalogFetching.delete(uni.id);
      if (obPickerMode) renderObPicker();
      else if (onboarding) renderOnboarding();
    });
}
// HS Pforzheim Studiengänge (abstgvnr → name), from LSF wplan tree.
const HSPF_COURSES = [{id:1004,a:"BAD",n:"Accessoire Design"},{id:1055,a:"MIT",n:"Advanced Information Technology"},{id:1049,a:"BAMB",n:"Allgemeiner Maschinenbau"},{id:1057,a:"BAI",n:"Angewandte Informatik"},{id:1053,a:"BAM",n:"Angewandte Mathematik"},{id:1029,a:"BNRE",n:"Bachelor Nachhaltigkeit und Ressourceneffizienz"},{id:1007,a:"BID",n:"BC Industrial Design"},{id:1008,a:"BMD",n:"BC Mode"},{id:323,a:"BREM",n:"BC Ressourceneffizienz-Management"},{id:1006,a:"BAS",n:"BC Schmuck"},{id:1009,a:"BSOA",n:"BC Schmuck u. Obj. d. ATK"},{id:1010,a:"BTD",n:"BC Transportation Design"},{id:1011,a:"BVK",n:"BC Visuelle Kommunikation"},{id:1048,a:"BBME",n:"Biomechanik und Engineering"},{id:1002,a:"BDEM",n:"BSBA/DigitalEnterpriseMan"},{id:1038,a:"BBA/BDBM",n:"Business Administration / Digital Business Managem"},{id:1035,a:"BBA/BIB",n:"Business Administration / International Business"},{id:1039,a:"BBA/BIM",n:"Business Administration / International Marketing"},{id:189,a:"BCR",n:"BW/Controlling"},{id:191,a:"BEL",n:"BW/EinkaufLogistik"},{id:145,a:"BIM",n:"BW/Intern. Marketing"},{id:169,a:"BIB",n:"BW/International Business"},{id:186,a:"BMA",n:"BW/Marketing"},{id:139,a:"BW/MA",n:"BW/Marketing"},{id:330,a:"BMKWE",n:"BW/MarketingKomm. u. Werbung"},{id:239,a:"BW/MF",n:"BW/Markt- u. Komm.forsch."},{id:328,a:"BMFKP",n:"BW/Marktforsch. KonsumPsy"},{id:187,a:"BMF",n:"BW/Marktforschung"},{id:192,a:"BPM",n:"BW/Personalmanagement"},{id:329,a:"BSWP",n:"BW/Steuern und Wirtsch.Pr"},{id:190,a:"BSR",n:"BW/SteuerRev"},{id:321,a:"BWE",n:"BW/Werbung"},{id:238,a:"BW/WE",n:"BW/Werbung (Mark.-Komm.)"},{id:331,a:"BWMI",n:"BW/WirtschaftsinfManageIT"},{id:236,a:"BW/WK",n:"BW/Wirtschaftsinformatik"},{id:193,a:"BWK",n:"BW/Wirtschaftsinformatik"},{id:1032,a:"BWL/BCAF",n:"BWL / Controlling Accounting und Finanzmanagement"},{id:1033,a:"BWL/BELS",n:"BWL / Einkauf Logistik und Supply Chain Managem."},{id:1044,a:"BWL/BKPM",n:"BWL / Konsumentenpsychologie und Marktforschung"},{id:1043,a:"BWL/BMA",n:"BWL / Marketing"},{id:1036,a:"BWL/BMKD",n:"BWL / Marketingkommunikation und Digital Marketing"},{id:1042,a:"BWL/BMMD",n:"BWL / Mediamanagement und Digital Media"},{id:1034,a:"BWL/BPM",n:"BWL / Personalmanagement"},{id:1037,a:"BWL/BSWP",n:"BWL / Steuern und Wirtschaftsprüfung"},{id:1040,a:"BWL/BNRE",n:"BWL/Nachhaltigkeit und Ressourceneffizienz"},{id:1041,a:"BWL/BWI",n:"BWL/Wirtschaftsinformatik"},{id:1047,a:"MDBM",n:"Digital Business Management"},{id:151,a:"BET",n:"Elektrotechnik"},{id:336,a:"MHRM",n:"Human Resources Manag."},{id:327,a:"MIDM",n:"Innovatives Dienstleistungsmarketing"},{id:1012,a:"BIMD",n:"Intermediales Design"},{id:172,a:"ISP",n:"International"},{id:1001,a:"IMEP",n:"International MEP"},{id:1027,a:"KGV",n:"KATAPULT - Gestalterischer Vorkurs"},{id:1054,a:"BKI",n:"Künstliche Intelligenz"},{id:1003,a:"MCCM",n:"M.Sc. Corp. Com. Managem."},{id:184,a:"MPE",n:"M.Sc. Produktentwicklung"},{id:210,a:"MAT",n:"MA Auditing and Taxation"},{id:215,a:"MCM",n:"MA Communication Manag."},{id:1013,a:"MCD",n:"MA Creative Direction"},{id:1019,a:"MDFM",n:"MA Design and Future Making"},{id:194,a:"MES",n:"MA Embedded Systems"},{id:1018,a:"MEM",n:"MA Engineering and Management"},{id:307,a:"MIS",n:"MA Information Systems"},{id:1000,a:"MLICS",n:"MA LifeCycle&Sustainabili"},{id:1022,a:"MMI",n:"MA Marketing Intelligence"},{id:1020,a:"MMS",n:"MA Mechatronische Systementwicklung"},{id:196,a:"MSM",n:"MA Service Marketing"},{id:1023,a:"MSI",n:"MA Strategisches Innovati"},{id:1028,a:"MTAL",n:"MA Taxation Auditing and Law"},{id:1014,a:"MTD",n:"MA Transp. Design"},{id:199,a:"BMBPE",n:"Maschinenbau Produktentwicklung"},{id:200,a:"BMBPTM",n:"Maschinenbau Produktionst. u. Management"},{id:322,a:"MABL",n:"Master of Arts in Auditing Business and Law"},{id:1045,a:"MAJ",n:"Master of Jewellery"},{id:1046,a:"MIM",n:"Master of Science in Industrial Management"},{id:211,a:"MBAE",n:"MBA and Engineering"},{id:185,a:"MBA IM",n:"MBA InternationalManagemt"},{id:198,a:"MACFA",n:"MControll. Finance + Acc"},{id:205,a:"BME",n:"Mechatronik"},{id:324,a:"BMMWP",n:"Media Management und Werbepsychologie"},{id:325,a:"BMT",n:"Medizintechnik"},{id:1056,a:"MMT",n:"Medizintechnik"},{id:1050,a:"BPTD",n:"Produktentwicklung und Technisches Design"},{id:107,a:"SIK",n:"Sozial- Methoden- und Interkulturelle Kompetenz"},{id:138,a:"BTI",n:"Technische Informatik"},{id:150,a:"BIN",n:"Wirtschaftsingenieurw."},{id:337,a:"BWING",n:"Wirtschaftsingenieurw."},{id:1052,a:"BWING CEE",n:"Wirtschaftsingenieurwesen / Circular Economy Engin"},{id:1025,a:"BWING ID",n:"Wirtschaftsingenieurwesen / Innovation u. Design"},{id:1051,a:"BWING IMO",n:"Wirtschaftsingenieurwesen / Intelligent Mobility"},{id:1058,a:"BWING MT",n:"Wirtschaftsingenieurwesen / Management und Technik"},{id:1026,a:"BWING IM",n:"Wirtschaftsingenieurwesen International Management"},{id:177,a:"BWR",n:"Wirtschaftsrecht"},{id:102,a:"",n:"ZERT | Zertifikatsprogramm PR-Referent"}];

function startOnboarding(step = 0) {
  onboarding = true;
  onboardStep = step;
  closeObPicker(true);
  const el = document.getElementById('onboarding');
  el.classList.remove('hidden');
  el.setAttribute('aria-hidden', 'false');
  renderOnboarding();
}

function closeOnboarding() {
  closeObPicker(true);
  const el = document.getElementById('onboarding');
  el.classList.add('hidden');
  el.setAttribute('aria-hidden', 'true');
  onboarding = false;
}

function onboardNext() { if (onboardStep < OB_STEPS - 1) { onboardStep++; renderOnboarding(); } }
function onboardBack() { if (onboardStep > 0) { onboardStep--; renderOnboarding(); } }

// Settings → edit Hochschule/Studiengang: close the sheet first so the
// onboarding overlay (lower z-index) isn't hidden behind it.
function editStundenplan() { closeSettings(); startOnboarding(2); }
function restartOnboarding() { closeSettings(); startOnboarding(0); }

function selectUniversity(id) {
  const u = UNIVERSITIES.find(x => x.id === id);
  if (!u) return;
  config.universityId = u.id;
  config.university = u.name;
  config.source = u.system;
  if (u.system !== 'ics') {
    const cs = coursesFor(u.id);
    if (!cs) {
      // catalog not loaded yet — no valid course until the user picks one
      config.courseId = null; config.course = null;
      loadCatalog(u);
    } else if (!cs.some(c => c.id === config.courseId)) {
      config.courseId = null; config.course = null;
    }
    rebuildTimetableUrl();
  } else {
    config.timetableUrl = config.icsUrl || '';   // restore any previously pasted link
  }
  saveConfig();
  renderOnboarding();
}

// Build the LSF wplan URL for the selected uni's course + semester. The backend
// follows this page to its iCal export (see functions/api/_timetable.js). For
// 'ics' unis the timetableUrl is the pasted link, so we leave it untouched.
function rebuildTimetableUrl() {
  const uni = selectedUni();
  if (!config.courseId) return;
  if (uni.system === 'lsf') {
    const sem = config.semester || 3;
    config.timetableUrl = `https://${uni.host}${uni.path}/rds?state=wplan&act=stg&pool=stg`
      + '&show=plan&P.vx=mittel'
      + `&r_zuordabstgv.semvonint=${sem}&r_zuordabstgv.sembisint=${sem}&k_abstgv.abstgvnr=${config.courseId}`;
  } else if (uni.system === 'starplan') {
    // direct .ics feed — the backend's VCALENDAR branch parses it as-is.
    // coursePu overrides for multi-campus instances (entry carried its own pu).
    const pu = config.coursePu || uni.pu;
    config.timetableUrl = `https://${uni.host}${uni.base}/ical?lan=de&puid=${pu}&type=pg&pgid=${config.courseId}`;
  }
}

// ─── Full-screen picker (Hochschule / Studiengang) ───────────────────
// Step 2 shows tappable rows (like the Standorte step); each opens this
// overlay with a search field + scrollable results — the pattern that scales
// to catalogs like Frankfurt's ~2700 programs.
function openObPicker(mode) {
  obPickerMode = mode;
  obPickerQuery = '';
  if (mode === 'course') loadCatalog(selectedUni());
  const el = document.getElementById('ob-picker');
  el.classList.remove('hidden');
  renderObPicker();
  setTimeout(() => document.getElementById('ob-picker-input')?.focus(), 80);
}

function closeObPicker(silent) {
  obPickerMode = null;
  obPickerQuery = '';
  const el = document.getElementById('ob-picker');
  if (el) el.classList.add('hidden');
  if (!silent) renderOnboarding();
}

function renderObPicker() {
  if (!obPickerMode) return;
  const el = document.getElementById('ob-picker');
  const title = obPickerMode === 'uni' ? 'Hochschule wählen' : 'Studiengang wählen';
  const ph = obPickerMode === 'uni' ? 'Hochschule suchen…' : 'Studiengang suchen…';
  el.innerHTML = `
    <div class="ob-picker-inner">
      <div class="ob-picker-head">
        <span class="ob-picker-title">${title}</span>
        <button class="ob-picker-cancel" onclick="closeObPicker()">Abbrechen</button>
      </div>
      <input id="ob-picker-input" class="ob-search" type="text" placeholder="${ph}"
             autocomplete="off" autocorrect="off" spellcheck="false"
             value="${escAttr(obPickerQuery)}" oninput="obPickerInput(this.value)">
      <div id="ob-picker-list" class="ob-picker-list">${obPickerListHtml()}</div>
    </div>`;
}

function obPickerInput(q) {
  obPickerQuery = q;
  const list = document.getElementById('ob-picker-list');
  if (list) list.innerHTML = obPickerListHtml();
}

function obPickerListHtml() {
  const tokens = obPickerQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const match = hay => tokens.every(t => hay.includes(t));

  if (obPickerMode === 'uni') {
    const uniBtn = u => {
      const tag = u.system === 'ics' ? ' <span class="ob-course-abbr">iCal-Link</span>' : '';
      return `<button class="ob-option${config.universityId === u.id ? ' active' : ''}" onclick="pickObUni('${u.id}')">
        <span class="ob-course-name">${escHtml(u.name)}${tag}</span><span class="ob-option-check">✓</span></button>`;
    };
    const items = UNIVERSITIES.filter(u => !tokens.length || match(u.name.toLowerCase()));
    if (!items.length)
      return uniBtn(UNIVERSITIES.find(u => u.id === 'other'))
        + '<div class="ob-course-empty">Nicht dabei? Wähle „Andere Hochschule“ und nutze deinen iCal-Link.</div>';
    return items.map(uniBtn).join('');
  }

  // course mode
  const list = coursesFor(config.universityId);
  if (!list) return '<div class="ob-course-empty">Studiengänge werden geladen…</div>';
  if (!list.length) return '<div class="ob-course-empty">Studiengänge konnten nicht geladen werden. Prüfe deine Verbindung.</div>';
  const items = tokens.length
    ? list.filter(c => match((c.a + ' ' + c.n).toLowerCase())).slice(0, 40)
    : list.slice(0, 25);
  if (!items.length) return '<div class="ob-course-empty">Keine Treffer</div>';
  const more = !tokens.length && list.length > items.length
    ? `<div class="ob-course-empty">${list.length} Studiengänge insgesamt — tippe, um zu filtern.</div>` : '';
  return items.map(c => `<button class="ob-option${c.id === config.courseId ? ' active' : ''}" onclick="pickObCourse(${c.id})">
      <span class="ob-course-name">${escHtml(c.n)}${c.a ? ` <span class="ob-course-abbr">${escHtml(c.a)}</span>` : ''}</span>
      <span class="ob-option-check">✓</span></button>`).join('') + more;
}

function pickObUni(id) {
  selectUniversity(id);
  if (selectedUni().system === 'ics') { closeObPicker(); return; }
  // flow straight into the course pick — the natural next step
  obPickerMode = 'course';
  obPickerQuery = '';
  loadCatalog(selectedUni());
  renderObPicker();
  setTimeout(() => document.getElementById('ob-picker-input')?.focus(), 80);
}

function pickObCourse(id) {
  selectCourse(id);
  closeObPicker();
}

function selectCourse(id) {
  const c = (coursesFor(config.universityId) || []).find(x => x.id === id);
  if (!c) return;
  config.courseId = c.id;
  config.course = c.n;
  config.coursePu = c.pu || null;   // multi-campus StarPlan entries carry a pu
  config.scheduleMode = 'timetable';
  rebuildTimetableUrl();
  saveConfig();
  renderOnboarding();   // refresh rows + footer (Weiter may have been disabled)
}

// Generic ICS: the pasted link is loaded verbatim by the backend.
function setIcsUrl(url) {
  config.icsUrl = url.trim();
  config.timetableUrl = config.icsUrl;
  config.source = 'ics';
  config.scheduleMode = 'timetable';
  saveConfig();
  const btn = document.querySelector('.ob-footer .ob-btn.primary');
  if (btn) btn.disabled = !/^https?:\/\/.+/i.test(config.timetableUrl);
}

function setSemester(n) {
  config.semester = Math.max(1, Math.min(8, n || 1));
  config.scheduleMode = 'timetable';
  rebuildTimetableUrl();
  saveConfig();
  const v = document.getElementById('ob-sem-val'); if (v) v.textContent = config.semester;
}

function finishOnboarding() {
  config.onboarded = true;
  config.scheduleMode = 'timetable';
  rebuildTimetableUrl();
  saveConfig();
  closeOnboarding();
  renderDashboard();
  if (config.homeLocation && config.workLocation) {
    if (config.timetableUrl) {
      fetchTimetable().then(() => { renderDashboard(); refreshJourneys(); });
    } else {
      refreshJourneys();
    }
  }
}

function renderOnboarding() {
  const el = document.getElementById('onboarding');
  el.innerHTML = `
    <div class="ob-inner">
      ${onboardStep > 0 && onboardStep < OB_STEPS - 1 ? obProgress() : '<div class="ob-progress-spacer"></div>'}
      <div class="ob-body">${obBody()}</div>
      <div class="ob-footer">${obFooter()}</div>
    </div>`;
}

function obProgress() {
  let dots = '';
  for (let i = 1; i <= OB_STEPS - 2; i++)
    dots += `<span class="ob-dot${i === onboardStep ? ' active' : ''}${i < onboardStep ? ' done' : ''}"></span>`;
  return `<div class="ob-progress">${dots}</div>`;
}

function obBody() {
  if (onboardStep === 0) {
    return `
      <div class="ob-welcome">
        <img class="ob-logo" src="icon.svg" alt="Pendler">
        <h1 class="ob-wordmark">Pendler</h1>
        <p class="ob-tagline">Stundenplan und Fahrplan in einer App.</p>
        <ul class="ob-features">
          <li><span class="ob-feat-ico">\u{1F686}</span> Passende Züge zu deinen Vorlesungen</li>
          <li><span class="ob-feat-ico">\u{1F5D3}️</span> Dein Stundenplan, automatisch geladen</li>
          <li><span class="ob-feat-ico">\u{1F9ED}</span> Spontane Routen mit dem Navigator</li>
        </ul>
      </div>`;
  }

  if (onboardStep === 1) {
    return `
      <div class="ob-step">
        <h2 class="ob-title">Wo pendelst du?</h2>
        <p class="ob-sub">Wähle deine Ziel- und Endhaltestelle.</p>
        <div class="ob-card">
          <div class="station-row" role="button" tabindex="0" onclick="openSearch('home')" onkeydown="onKeyActivate(event)">
            <div class="station-icon home">\u{1F3E0}</div>
            <div>
              <div class="station-label">Zuhause</div>
              <div class="station-name${config.homeLocation ? '' : ' placeholder'}">${config.homeLocation ? escHtml(config.homeLocation.name || config.homeLocation.address) : 'Adresse oder Station wählen'}</div>
            </div>
            <div class="station-chevron">›</div>
          </div>
          <div class="station-row" role="button" tabindex="0" onclick="openSearch('work')" onkeydown="onKeyActivate(event)">
            <div class="station-icon work">\u{1F393}</div>
            <div>
              <div class="station-label">Hochschule</div>
              <div class="station-name${config.workLocation ? '' : ' placeholder'}">${config.workLocation ? escHtml(config.workLocation.name || config.workLocation.address) : 'Adresse oder Station wählen'}</div>
            </div>
            <div class="station-chevron">›</div>
          </div>
        </div>
      </div>`;
  }

  if (onboardStep === 2) {
    const uni = selectedUni();
    const isIcs = uni.system === 'ics';

    // rows mirror the Standorte step — tap opens the full-screen picker
    const uniRow = `
      <div class="station-row" role="button" tabindex="0" onclick="openObPicker('uni')" onkeydown="onKeyActivate(event)">
        <div class="station-icon work">\u{1F393}</div>
        <div>
          <div class="station-label">Hochschule</div>
          <div class="station-name">${escHtml(uni.name)}</div>
        </div>
        <div class="station-chevron">›</div>
      </div>`;

    const courseRow = isIcs ? '' : `
      <div class="station-row" role="button" tabindex="0" onclick="openObPicker('course')" onkeydown="onKeyActivate(event)">
        <div class="station-icon via">\u{1F4DA}</div>
        <div>
          <div class="station-label">Studiengang</div>
          <div class="station-name${config.courseId ? '' : ' placeholder'}">${config.courseId ? escHtml(config.course) : 'Studiengang wählen'}</div>
        </div>
        <div class="station-chevron">›</div>
      </div>`;

    let below = '';
    if (isIcs) {
      below = `
        <div class="ob-field-label">iCal-Link (.ics)</div>
        <input id="ob-ics" class="ob-search" type="url" inputmode="url" placeholder="https://…/stundenplan.ics"
               autocomplete="off" autocorrect="off" spellcheck="false"
               value="${escAttr(config.icsUrl || '')}" oninput="setIcsUrl(this.value)">
        <p class="ob-hint">Abo-/Export-Link deines Stundenplans (LSF, Stud.IP, Rapla …). Wird direkt geladen.</p>`;
    } else if (uni.system === 'lsf') {
      // StarPlan groups already encode the semester → stepper is LSF-only.
      below = `
        <div class="ob-field-label">Semester</div>
        <div class="ob-stepper">
          <button class="ob-step-btn" onclick="setSemester((config.semester||3)-1)" aria-label="Semester weniger">−</button>
          <span id="ob-sem-val" class="ob-stepper-val">${config.semester || 3}</span>
          <button class="ob-step-btn" onclick="setSemester((config.semester||3)+1)" aria-label="Semester mehr">+</button>
        </div>`;
    }

    return `
      <div class="ob-step">
        <h2 class="ob-title">Dein Stundenplan</h2>
        <p class="ob-sub">Wähle deine Hochschule und deinen Studiengang.</p>
        <div class="ob-card">
          ${uniRow}
          ${courseRow}
        </div>
        ${below}
      </div>`;
  }

  // step 3 — finish
  const homeName = config.homeLocation ? escHtml(config.homeLocation.name || config.homeLocation.address) : '—';
  const workName = config.workLocation ? escHtml(config.workLocation.name || config.workLocation.address) : '—';
  return `
    <div class="ob-finish">
      <div class="ob-check">✓</div>
      <h2 class="ob-title">Alles bereit!</h2>
      <p class="ob-sub">Du kannst alles später in den Einstellungen ändern.</p>
      <div class="ob-summary">
        <div class="ob-summary-row"><div class="ob-summary-ico">\u{1F3E0}</div><div><div class="ob-summary-label">Zuhause</div><div class="ob-summary-value">${homeName}</div></div></div>
        <div class="ob-summary-row"><div class="ob-summary-ico">\u{1F393}</div><div><div class="ob-summary-label">Hochschule</div><div class="ob-summary-value">${workName}</div></div></div>
        <div class="ob-summary-row"><div class="ob-summary-ico">\u{1F4DA}</div><div><div class="ob-summary-label">Stundenplan</div><div class="ob-summary-value">${config.source === 'ics'
          ? 'Eigener iCal-Link'
          : config.source === 'lsf'
            ? `${escHtml(config.course || '—')} · ${config.semester || 3}. Semester`
            : escHtml(config.course || '—')}</div></div></div>
      </div>
    </div>`;
}

function obFooter() {
  if (onboardStep === 0)
    return `<button class="ob-btn primary" onclick="onboardNext()">Los geht’s</button>`;
  if (onboardStep === OB_STEPS - 1)
    return `<button class="ob-btn primary" onclick="finishOnboarding()">Los geht’s</button>`;
  const canNext = onboardStep === 1 ? !!(config.homeLocation && config.workLocation)
                : onboardStep === 2 ? (selectedUni().system === 'ics'
                    ? /^https?:\/\/.+/i.test(config.timetableUrl || '')
                    : !!config.courseId)
                : true;
  return `
    <button class="ob-btn ghost" onclick="onboardBack()">Zurück</button>
    <button class="ob-btn primary" onclick="onboardNext()" ${canNext ? '' : 'disabled'}>Weiter</button>`;
}

// ─── Tabs ────────────────────────────────────────────
// Table-driven so adding a tab means adding one entry (+ matching #tab-<id> /
// #view-<id> in index.html), not another branch in switchTab.
const TABS = {
  dashboard: { title: 'Pendler',   showDate: true,  render: renderDashboard },
  fahrplan:  { title: 'Wochenplan', showDate: false, render: renderFahrplan, onShow: ensureTimetableForFahrplan },
  navigator: { title: 'Navigator', showDate: false, render: renderNavigator, onShow: onShowNavigator },
};

function renderActiveTab() {
  (TABS[activeTab] || TABS.dashboard).render();
}

function switchTab(tab) {
  const cfg = TABS[tab];
  if (!cfg || activeTab === tab) return;
  activeTab = tab;
  for (const id of Object.keys(TABS)) {
    const on = id === tab;
    const btn = document.getElementById(`tab-${id}`);
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
    document.getElementById(`view-${id}`).classList.toggle('hidden', !on);
  }
  document.getElementById('app-title').textContent = cfg.title;
  document.getElementById('header-date').style.display = cfg.showDate ? '' : 'none';

  expandedCard = null;
  if (cfg.onShow) cfg.onShow();
  cfg.render();
}

function onShowNavigator() {
  if (!navInitialized) initNavigator();
  if (navFrom && navTo && !navJourneys && !navLoading) refreshNavigator();
}

// Fahrplan needs the week's timetable. Reuse cache first; fetch if absent.
function ensureTimetableForFahrplan() {
  if (config.scheduleMode !== 'timetable' || !config.timetableUrl) return;
  if (timetableData || timetableLoading) return;
  loadCachedTimetable();
  if (!timetableData) {
    fetchTimetable().then(() => { if (activeTab === 'fahrplan') renderFahrplan(); });
  }
}

// ─── Rendering: Fahrplan (week overview) ─────────────
function renderFahrplan() {
  const el = document.getElementById('view-fahrplan');

  if (config.scheduleMode !== 'timetable') {
    el.innerHTML = `<div class="no-commute">
      <div class="no-commute-icon">\u{1F4C5}</div>
      <h3>Stundenplan nicht aktiv</h3>
      <p>Aktiviere den Stundenplan-Modus in den Einstellungen, um den Wochenplan zu sehen.</p>
    </div>`;
    return;
  }

  const monday = getWeekMonday();
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const fmt = d => `${d.getDate()}.${d.getMonth() + 1}.`;
  const weekLabel = weekOffset === 0 ? 'Diese Woche' : `${fmt(monday)} – ${fmt(sunday)}`;

  let html = `<div class="week-nav">
    <button class="week-btn" onclick="changeWeek(-1)">‹</button>
    <span class="week-label">${weekLabel}</span>
    <button class="week-btn" onclick="changeWeek(1)">›</button>
  </div>`;

  if (timetableLoading && !timetableData) {
    html += '<div class="fahrplan-status">Stundenplan wird geladen…</div>';
    el.innerHTML = html;
    return;
  }
  if (timetableError && !timetableData) {
    html += `<div class="timetable-error">${escHtml(timetableError)}</div>`;
    el.innerHTML = html;
    return;
  }

  const order = [1, 2, 3, 4, 5, 6, 0];
  const today = new Date().getDay();
  html += '<div class="fahrplan-days">';
  for (const d of order) {
    const events = getTimetableDay(d);
    const isToday = d === today && weekOffset === 0;
    if (!events || events.length === 0) {
      html += `<div class="fahrplan-day empty${isToday ? ' today' : ''}">
        <div class="fahrplan-day-head"><span class="fahrplan-day-name">${DAY_NAMES[d]}</span><span class="fahrplan-day-off">Frei</span></div>
      </div>`;
      continue;
    }
    const times = getTimetableTimes(d);
    let evs = '';
    for (const ev of events) {
      const parts = ev.name.split(' - ');
      const name = parts.length > 1 ? parts.slice(1).join(' - ') : ev.name;
      evs += `<div class="fahrplan-event">
        <div class="fahrplan-event-time">${ev.startTime} – ${ev.endTime}</div>
        <div class="fahrplan-event-info">
          <div class="fahrplan-event-name">${escHtml(name)}</div>
          ${ev.location ? `<div class="fahrplan-event-room">${escHtml(ev.location)}</div>` : ''}
        </div>
      </div>`;
    }
    html += `<div class="fahrplan-day${isToday ? ' today' : ''}" role="button" tabindex="0" onclick="openDayInDashboard(${d})" onkeydown="onKeyActivate(event)">
      <div class="fahrplan-day-head">
        <span class="fahrplan-day-name">${DAY_NAMES[d]}</span>
        <span class="fahrplan-day-meta">Ank. ${times.outboundTime} · ${events.length} Veranst.</span>
      </div>
      <div class="fahrplan-events">${evs}</div>
    </div>`;
  }
  html += '</div>';
  el.innerHTML = html;
}

// Tap a day in the Fahrplan → jump to that day's commute on the dashboard.
function openDayInDashboard(day) {
  selectedDay = day;
  resetJourneys();
  switchTab('dashboard');
  refreshJourneys();
}

// ─── Navigator ───────────────────────────────────────
function initNavigator() {
  navInitialized = true;
  // Start from the saved commute locations, oriented by time of day: before
  // noon you're typically heading out (home→work); later, heading back.
  const morning = new Date().getHours() < 12;
  if (morning) { navFrom = config.homeLocation; navTo = config.workLocation; }
  else { navFrom = config.workLocation; navTo = config.homeLocation; }
}

function navWorkLabel() { return config.scheduleMode === 'timetable' ? 'Hochschule' : 'Arbeit'; }
function navWorkIcon() { return config.scheduleMode === 'timetable' ? '\u{1F393}' : '\u{1F3E2}'; }

function navWhenInputValue() {
  const d = navWhen || new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderNavigator() {
  const el = document.getElementById('view-navigator');
  let html = renderNavForm();

  if (!navFrom || !navTo) {
    html += `<div class="nav-hint">Wähle Start und Ziel, um Verbindungen zu sehen.</div>`;
    el.innerHTML = html;
    return;
  }

  if (navLastUpdated || navLoading) {
    html += `<div class="last-updated">
      <span>${navLoading ? 'Lädt…' : 'Aktualisiert ' + formatTimeAgo(navLastUpdated)}</span>
      <button class="refresh-btn${navLoading ? ' spinning' : ''}" onclick="refreshNavigator()" aria-label="Aktualisieren">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
      </button>
    </div>`;
  }

  html += '<div class="section">';
  if (navError) {
    html += `<div class="error-card"><p>${escHtml(navError)}</p><button class="error-retry" onclick="refreshNavigator()">Erneut versuchen</button></div>`;
  } else if (navJourneys && navJourneys.length > 0) {
    navJourneys.forEach((j, i) => { html += renderJourneyCard(j, 'nav', i); });
  } else if (navJourneys && navJourneys.length === 0) {
    html += `<div class="error-card"><p>Keine Verbindungen gefunden</p><button class="error-retry" onclick="refreshNavigator()">Erneut versuchen</button></div>`;
  } else if (navLoading) {
    html += renderLoadingSkeleton(3);
  }
  html += '</div>';

  el.innerHTML = html;

  if (expandedCard) {
    const card = el.querySelector(`[data-card-id="${expandedCard}"]`);
    if (card) { card.classList.add('expanded'); card.setAttribute('aria-expanded', 'true'); }
  }
}

function renderNavForm() {
  const fromName = navFrom ? (navFrom.name || navFrom.address || 'Start') : null;
  const toName = navTo ? (navTo.name || navTo.address || 'Ziel') : null;

  return `<div class="nav-card">
    <div class="nav-points">
      <div class="nav-rail" aria-hidden="true"><span class="nav-rail-dot start"></span><span class="nav-rail-line"></span><span class="nav-rail-dot end"></span></div>
      <div class="nav-fields">
        <button class="nav-field" onclick="openSearch('nav-from')">
          <span class="nav-field-label">Von</span>
          <span class="nav-field-value${fromName ? '' : ' placeholder'}">${fromName ? escHtml(fromName) : 'Startpunkt wählen'}</span>
        </button>
        <div class="nav-divider"></div>
        <button class="nav-field" onclick="openSearch('nav-to')">
          <span class="nav-field-label">Nach</span>
          <span class="nav-field-value${toName ? '' : ' placeholder'}">${toName ? escHtml(toName) : 'Ziel wählen'}</span>
        </button>
      </div>
      <button class="nav-swap" onclick="swapNav()" aria-label="Start und Ziel tauschen"${navFrom && navTo ? '' : ' disabled'}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5v14M7 5L4 8M7 5l3 3M17 19V5M17 19l3-3M17 19l-3-3"/></svg>
      </button>
    </div>

    <div class="nav-quick">
      <button class="nav-chip" onclick="navUseLocation('from')"${navLocating ? ' disabled' : ''}>
        <span class="nav-chip-ico">\u{1F4CD}</span>${navLocating ? 'Ortung…' : 'Standort'}
      </button>
      ${config.homeLocation ? `<button class="nav-chip" onclick="navQuick('to','home')"><span class="nav-chip-ico">\u{1F3E0}</span>Zuhause</button>` : ''}
      ${config.workLocation ? `<button class="nav-chip" onclick="navQuick('to','work')"><span class="nav-chip-ico">${navWorkIcon()}</span>${escHtml(navWorkLabel())}</button>` : ''}
    </div>

    <div class="nav-time">
      <div class="mode-toggle nav-time-modes">
        <button class="mode-btn${navTimeMode === 'departure' ? ' active' : ''}" onclick="setNavMode('departure')">Abfahrt</button>
        <button class="mode-btn${navTimeMode === 'arrival' ? ' active' : ''}" onclick="setNavMode('arrival')">Ankunft</button>
      </div>
      <input type="datetime-local" class="nav-when-input" value="${navWhenInputValue()}" onchange="setNavWhen(this.value)" aria-label="Zeitpunkt">
      <button class="nav-now-btn${navWhen ? '' : ' active'}" onclick="setNavNow()">Jetzt</button>
    </div>
  </div>`;
}

function swapNav() {
  if (!navFrom || !navTo) return;
  [navFrom, navTo] = [navTo, navFrom];
  navJourneys = null; expandedCard = null;
  renderNavigator();
  refreshNavigator();
}

function navQuick(target, which) {
  const loc = which === 'home' ? config.homeLocation : config.workLocation;
  if (!loc) return;
  if (target === 'to') navTo = loc; else navFrom = loc;
  navJourneys = null; expandedCard = null;
  renderNavigator();
  refreshNavigator();
}

function navUseLocation(target) {
  if (!navigator.geolocation) { navError = 'Standortdienste nicht verfügbar.'; renderNavigator(); return; }
  navLocating = true; navError = null; renderNavigator();
  navigator.geolocation.getCurrentPosition(
    pos => {
      const loc = { type: 'location', name: 'Mein Standort', latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      if (target === 'to') navTo = loc; else navFrom = loc;
      navLocating = false; navJourneys = null; expandedCard = null;
      renderNavigator();
      refreshNavigator();
    },
    () => { navLocating = false; navError = 'Standort konnte nicht ermittelt werden.'; renderNavigator(); },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

function setNavMode(mode) {
  navTimeMode = mode;
  renderNavigator();
  refreshNavigator();
}

function setNavWhen(val) {
  if (!val) return;
  const d = new Date(val);
  if (isNaN(d.getTime())) return;
  navWhen = d;
  refreshNavigator();
}

function setNavNow() {
  navWhen = null;
  renderNavigator();
  refreshNavigator();
}

async function refreshNavigator() {
  if (!navFrom || !navTo) { renderNavigator(); return; }
  navLoading = true; navError = null; expandedCard = null;
  renderNavigator();

  const when = navWhen || new Date();
  const p = n => String(n).padStart(2, '0');
  const timeStr = `${p(when.getHours())}:${p(when.getMinutes())}`;
  try {
    navJourneys = await fetchJourneys(navFrom, navTo, timeStr, when, navTimeMode, { viaStops: [], excludedProducts: [] });
  } catch (e) {
    navJourneys = null;
    navError = e?.message || 'Verbindungen konnten nicht geladen werden';
  }
  navLoading = false; navLastUpdated = new Date();
  renderNavigator();
}

// ─── Utilities ───────────────────────────────────────
function fmtTime(iso) {
  if (!iso) return '--:--';
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}\u2009Std\u2009${m}\u2009Min` : `${m}\u2009Min`;
}

function formatDateShort(d) {
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatTimeAgo(d) {
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 10) return 'gerade eben';
  if (sec < 60) return `vor ${sec}\u2009s`;
  return `vor ${Math.round(sec / 60)}\u2009Min.`;
}

function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '\u2026' : s || ''; }
function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')   // must run first
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function productColor(product) {
  const map = {
    nationalExpress: 'var(--product-ice)',
    national: 'var(--product-ice)',
    regionalExpress: 'var(--product-re)',
    regional: 'var(--product-re)',
    suburban: 'var(--product-s)',
    subway: 'var(--product-u)',
    tram: 'var(--product-tram)',
    bus: 'var(--product-bus)',
    ferry: 'var(--product-ferry)',
  };
  return map[product] || '#555b65';
}

// ─── Init ────────────────────────────────────────────
function init() {
  config = loadConfig();

  // Load cached timetable data if in timetable mode
  if (config.scheduleMode === 'timetable') {
    loadCachedTimetable();
  }

  renderDashboard();

  // First run: show the onboarding flow over the (empty) dashboard.
  if (!config.onboarded) startOnboarding();

  document.getElementById('search-input').addEventListener('input', e => onSearchInput(e.target.value));
  document.getElementById('search-cancel').addEventListener('click', closeSearch);
  document.getElementById('search-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSearch();
  });

  startAutoRefresh();

  // Refresh immediately when the user returns to the tab/PWA, if showing today.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (activeTab === 'navigator') {
      if (!navWhen && navFrom && navTo) refreshNavigator();
    } else if (selectedDay === new Date().getDay() && config.homeLocation && config.workLocation) {
      refreshJourneys();
    }
  });

  if (config.homeLocation && config.workLocation) {
    // In timetable mode, refresh timetable in background then load journeys
    if (config.scheduleMode === 'timetable' && config.timetableUrl) {
      fetchTimetable().then(() => {
        renderDashboard();
        refreshJourneys();
      });
    } else {
      refreshJourneys();
    }
  }

  // Enable real glass refraction only on Chromium, which actually renders an
  // SVG displacement filter inside backdrop-filter. Safari/Firefox parse the
  // url() but don't render it, so they keep the frosted-glass base instead.
  try {
    const supportsUrlBackdrop = CSS.supports('backdrop-filter', 'url(#g)')
      || CSS.supports('-webkit-backdrop-filter', 'url(#g)');
    if (window.chrome && supportsUrlBackdrop) {
      document.documentElement.classList.add('glass-lens');
    }
  } catch { /* CSS.supports unavailable — stay on frosted base */ }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
