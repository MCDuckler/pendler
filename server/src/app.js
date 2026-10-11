// ─── HTTP: the API, the PWA and the iPhone builds ─────────────────────

import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';

import { parseLocation, TtlCache } from './util.js';
import { searchLocations, searchJourneys, departures } from './efa.js';
import { fetchTimetableEvents, getEventsForWeek, getMonday } from './timetable.js';
import { planToday, planDay } from './plan.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.ipa': 'application/octet-stream',
};

const MAX_BODY = 64 * 1024;
const pad2 = n => String(n).padStart(2, '0');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Per-IP budget for the public endpoints: generous for one PWA + widgets,
// tight enough that the box can't be used as a free EFA relay.
class RateLimiter {
  constructor(perMinute) { this.perMinute = perMinute; this.hits = new Map(); }
  allow(ip) {
    const now = Date.now();
    const e = this.hits.get(ip);
    if (!e || now - e.start > 60e3) { this.hits.set(ip, { start: now, n: 1 }); return true; }
    if (this.hits.size > 5000) this.hits.clear();
    return ++e.n <= this.perMinute;
  }
}

export function createApp({ webDir, appDir, store, version = 'dev', ratePerMinute = 120, deps = {} }) {
  const search = deps.searchJourneys || searchJourneys;
  const locations = deps.searchLocations || searchLocations;
  const deps_ = deps.departures || departures;
  const ttEvents = deps.timetableEvents || cachedTimetable();
  const limiter = new RateLimiter(ratePerMinute);
  const planDeps = { search, timetableEvents: ttEvents };

  function cachedTimetable() {
    const cache = new TtlCache(200);
    return url => cache.wrap(`tt:${url}`, 6 * 3600e3, () => fetchTimetableEvents(url));
  }

  function bearer(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  }

  function device(req, required = true) {
    const d = store?.byToken(bearer(req));
    if (!d && required) throw new HttpError(401, 'Gerät nicht gekoppelt');
    if (d) store.touch(d);
    return d;
  }

  async function body(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > MAX_BODY) throw new HttpError(413, 'Anfrage zu groß');
      chunks.push(c);
    }
    if (!n) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Ungültiges JSON'); }
  }

  const profileOf = b => b?.profile ?? b;

  const routes = {
    'GET /api/health': async () => ({ ok: true, version }),

    // ── v1-compatible (the PWA) ──
    'GET /api/locations': async (req, url) => {
      const q = url.searchParams.get('query') || url.searchParams.get('q');
      if (!q) throw new HttpError(400, 'query required');
      return locations(q);
    },
    'GET /api/journeys': async (req, url) => {
      const p = url.searchParams;
      const from = parseLocation(p.get('from'));
      const to = parseLocation(p.get('to'));
      const departure = p.get('departure');
      const arrival = p.get('arrival');
      if (!from || !to) throw new HttpError(400, 'from, to required');
      if (!departure && !arrival) throw new HttpError(400, 'departure or arrival required');
      let via = [];
      try { via = JSON.parse(p.get('via') || '[]'); } catch { /* ignore */ }
      const excludeProducts = (p.get('excludeProducts') || '').split(',').filter(Boolean);
      const results = Math.min(parseInt(p.get('results') || '4', 10) || 4, 8);
      return { journeys: await search({ from, to, departure, arrival, results, via, excludeProducts }) };
    },
    'GET /api/timetable': async (req, url) => {
      const ttUrl = url.searchParams.get('url');
      if (!ttUrl) throw new HttpError(400, 'url required');
      const weekStr = url.searchParams.get('week');
      const monday = weekStr ? getMonday(new Date(`${weekStr}T12:00:00`)) : getMonday(new Date());
      const events = await ttEvents(ttUrl);
      const week = `${monday.getFullYear()}-${pad2(monday.getMonth() + 1)}-${pad2(monday.getDate())}`;
      return { week, days: getEventsForWeek(events, monday) };
    },

    // ── v2 ──
    'GET /api/departures': async (req, url) => {
      const stop = parseLocation(url.searchParams.get('stop'));
      if (!stop) throw new HttpError(400, 'stop required');
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 30);
      return { departures: await deps_(stop, { limit, when: url.searchParams.get('when') || undefined }) };
    },
    // Stateless: the caller sends its profile (PWA config). Used by app + widgets.
    'POST /api/today': async (req) => {
      const profile = profileOf(await body(req));
      device(req, false);
      return planToday(profile, planDeps);
    },
    'POST /api/day': async (req, url) => {
      const date = url.searchParams.get('date');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new HttpError(400, 'date=YYYY-MM-DD required');
      return planDay(profileOf(await body(req)), date, planDeps);
    },
    // Paired: the profile the server watches for pushes.
    'GET /api/today': async (req) => {
      const d = device(req);
      if (!d.profile) throw new HttpError(409, 'Kein Profil hinterlegt');
      return planToday(d.profile, planDeps);
    },
    'GET /api/device': async (req) => {
      const d = device(req);
      return { id: d.id, name: d.name, notify: d.notify, hasProfile: !!d.profile, profileAt: d.profileAt || null };
    },
    'PUT /api/device/profile': async (req) => {
      const d = device(req);
      const b = await body(req);
      const profile = profileOf(b);
      if (!profile?.homeLocation || !profile?.workLocation) throw new HttpError(400, 'Profil unvollständig');
      store.setProfile(d, profile, b.notify);
      return { ok: true, notify: d.notify };
    },
  };

  async function serveFile(res, root, rel, cache) {
    const full = normalize(join(root, rel));
    if (!full.startsWith(normalize(root) + sep) && full !== normalize(root)) throw new HttpError(403, 'forbidden');
    let s;
    try { s = await stat(full); } catch { throw new HttpError(404, 'Not found'); }
    if (!s.isFile()) throw new HttpError(404, 'Not found');
    const data = await readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[extname(full)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': cache,
    });
    res.end(data);
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const path = url.pathname;
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        });
        return res.end();
      }
      if (path.startsWith('/api/')) {
        const route = routes[`${req.method} ${path}`];
        if (!route) throw new HttpError(404, 'not found');
        if (!bearer(req) && !limiter.allow(ip)) throw new HttpError(429, 'Zu viele Anfragen');
        const out = await route(req, url);
        return sendJson(res, 200, out);
      }
      if (path.startsWith('/app/') && appDir) {
        return await serveFile(res, appDir, path.slice(5), 'no-cache');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      const rel = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
      // The app shell and the service worker must revalidate, or a deploy never arrives.
      const fresh = rel === 'index.html' || rel === 'sw.js' || rel.endsWith('.json');
      return await serveFile(res, webDir, rel, fresh ? 'no-cache' : 'public, max-age=3600');
    } catch (err) {
      const status = err.status || 502;
      if (status >= 500) console.error(`${req.method} ${path}: ${err.message}`);
      if (path.startsWith('/api/')) return sendJson(res, status, { error: err.message });
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(status === 404 ? 'Not found' : err.message);
    }
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
