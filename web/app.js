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
let activeTab = 'dashboard';   // 'dashboard' | 'navigator'
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
    timetableUrl: 'https://hic.hs-pforzheim.de/lsf/rds?state=wplan&act=stg&pool=stg&show=plan&P.vx=mittel&r_zuordabstgv.semvonint=3&r_zuordabstgv.sembisint=3&k_abstgv.abstgvnr=1011',
    timetableLeadMin: 15,      // minutes before first class to arrive
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
// Primary: own backend (/api/*, proxies bahn.de, same-origin — no third-party
// rate limit). Fallback: public transport.rest demo when the backend errors out
// (e.g. bahn.de bot-blocks the egress IP). Either upstream alone is flaky; the
// pair is what makes station search & journeys load reliably.
const API = '/api';
const DB_FALLBACK = 'https://v6.db.transport.rest';
const PRODUCT_TO_HAFAS = {
  ICE: 'nationalExpress', EC_IC: 'national', IR: 'regionalExpress',
  REGIONAL: 'regional', SBAHN: 'suburban', BUS: 'bus',
  UBAHN: 'subway', TRAM: 'tram', ANRUFPFLICHTIG: 'taxi',
};

async function fetchJson(url, signal) {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function searchLocations(query) {
  if (!query || query.length < 2) return [];
  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();
  const signal = searchAbort.signal;
  const q = encodeURIComponent(query);
  try {
    return await fetchJson(`${API}/locations?query=${q}`, signal);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return await fetchJson(`${DB_FALLBACK}/locations?query=${q}&results=8`, signal);
  }
}

// Both upstreams return the same hafas-shaped legs, so one normalizer fits both.
function normalizeJourneys(data) {
  return (data.journeys || []).map(j => ({
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

  // Resolve time/mode once; both upstreams share the departure/arrival param names.
  const useArrival = mode === 'arrival' && !(isToday && timeDate < now);
  const timeKey = useArrival ? 'arrival' : 'departure';
  const timeVal = (useArrival ? timeDate : (isToday && timeDate < now ? now : timeDate)).toISOString();
  const results = String(opts.results ?? config.results ?? 4);

  // Primary: own backend. from/to = stop id string or JSON-encoded address.
  const encodeLoc = loc => (loc.type === 'location' && !loc.id) ? JSON.stringify(loc) : loc.id;
  const apiParams = new URLSearchParams({
    from: encodeLoc(fromLoc), to: encodeLoc(toLoc), results, [timeKey]: timeVal,
  });
  if (excludedProducts.length > 0) {
    apiParams.set('excludeProducts', excludedProducts.join(','));
  }
  if (viaStops.length > 0) {
    // Backend resolves each stop via buildHaltId (id string or address object).
    apiParams.set('via', JSON.stringify(viaStops));
  }

  try {
    return normalizeJourneys(await fetchJson(`${API}/journeys?${apiParams}`));
  } catch {
    // Fallback: public transport.rest demo (different param contract).
    const fb = new URLSearchParams({ results, [timeKey]: timeVal });
    setLocParam(fb, 'from', fromLoc);
    setLocParam(fb, 'to', toLoc);
    for (const p of excludedProducts) {
      const hafas = PRODUCT_TO_HAFAS[p];
      if (hafas) fb.set(hafas, 'false');
    }
    // transport.rest only supports a single station-id via stop (best effort).
    const firstVia = viaStops.find(v => v.id);
    if (firstVia) fb.set('via', firstVia.id);
    return normalizeJourneys(await fetchJson(`${DB_FALLBACK}/journeys?${fb}`));
  }
}

// transport.rest takes a bare stop id, or split lat/long/address params.
function setLocParam(params, key, loc) {
  if (loc.type === 'location' && !loc.id) {
    params.set(`${key}.latitude`, loc.latitude);
    params.set(`${key}.longitude`, loc.longitude);
    params.set(`${key}.address`, loc.address || loc.name);
  } else {
    params.set(key, loc.id);
  }
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
  renderDashboard();
  await refreshJourneys();
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
      <div class="schedule-section-title">Stundenplan (LSF)</div>
      <div class="station-card">
        <div class="timetable-url-row">
          <label class="timetable-label" for="timetable-url">Stundenplan-URL</label>
          <input type="url" id="timetable-url" class="timetable-input" placeholder="https://hic.hs-pforzheim.de/lsf/rds?state=wplan&..." value="${escAttr(config.timetableUrl || '')}" onchange="setTimetableUrl(this.value)">
        </div>
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

function setTimetableUrl(url) {
  config.timetableUrl = url.trim();
  saveConfig();
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

// ─── Tabs ────────────────────────────────────────────
function switchTab(tab) {
  if (activeTab === tab) return;
  activeTab = tab;
  const onDash = tab === 'dashboard';
  document.getElementById('tab-dashboard').classList.toggle('active', onDash);
  document.getElementById('tab-navigator').classList.toggle('active', !onDash);
  document.getElementById('tab-dashboard').setAttribute('aria-selected', String(onDash));
  document.getElementById('tab-navigator').setAttribute('aria-selected', String(!onDash));
  document.getElementById('view-dashboard').classList.toggle('hidden', !onDash);
  document.getElementById('view-navigator').classList.toggle('hidden', onDash);
  document.getElementById('app-title').textContent = onDash ? 'Pendler' : 'Navigator';
  document.getElementById('header-date').style.display = onDash ? '' : 'none';

  expandedCard = null;
  if (onDash) {
    renderDashboard();
  } else {
    if (!navInitialized) initNavigator();
    renderNavigator();
    if (navFrom && navTo && !navJourneys && !navLoading) refreshNavigator();
  }
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
