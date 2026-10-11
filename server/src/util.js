// ─── Small helpers shared by the transit, timetable and plan modules ──

// Upstreams (EFA, LSF) want German wall-clock time with no offset. The client
// sends absolute instants (UTC ISO), so render them in Europe/Berlin explicitly —
// getHours() would read the host timezone and shift every query by 1–2 hours.
export function formatLocalTime(d) {
  const p = berlinParts(d);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

export function berlinParts(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false,
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  if (parts.hour === '24') parts.hour = '00'; // some engines emit "24" at midnight
  parts.dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return parts;
}

// The instant at which Berlin's wall clock shows `dateStr` (YYYY-MM-DD) `hhmm`.
// Tries both candidate offsets (+1/+2) and keeps the one that round-trips.
export function berlinInstant(dateStr, hhmm) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  for (const off of [2, 1]) {
    const t = new Date(Date.UTC(y, mo - 1, d, h - off, mi));
    const p = berlinParts(t);
    if (+p.hour === h && +p.minute === mi && +p.day === d) return t;
  }
  return new Date(Date.UTC(y, mo - 1, d, h - 1, mi)); // inside a DST gap: best effort
}

export function berlinDateStr(d) {
  const p = berlinParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

// from/to query params: a bare id string, or a JSON-encoded location object.
export function parseLocation(str) {
  if (!str) return null;
  if (str.startsWith('{')) {
    try { return JSON.parse(str); } catch { /* fall through */ }
  }
  return str;
}

// Tiny TTL cache so repeated widget/PWA refreshes don't hammer upstreams.
export class TtlCache {
  constructor(max = 500) { this.max = max; this.map = new Map(); }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) { this.map.delete(key); return undefined; }
    return e.val;
  }
  set(key, val, ttlMs) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { val, exp: Date.now() + ttlMs });
    return val;
  }
  // Memoize an async producer; concurrent callers share one in-flight promise.
  async wrap(key, ttlMs, fn) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const p = fn();
    this.set(key, p, ttlMs);
    try { return await p; } catch (e) { this.map.delete(key); throw e; }
  }
}
