import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared with the Cloudflare Pages Functions so the dev server and production
// behave identically. (Previously each had its own copy and they drifted.)
import {
  BAHN_API, PRODUCT_MAP, ALL_PRODUCTS, bahnFetch, buildHaltId,
  formatLocalTime, parseLocation, transformJourney,
} from './functions/api/_shared.js';
import { fetchTimetableEvents, getEventsForWeek, getMonday } from './functions/api/_timetable.js';

const __dir = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// ─── Location search ─────────────────────────────────

async function searchLocations(query) {
  const url = `${BAHN_API}/reiseloesung/orte?suchbegriff=${encodeURIComponent(query)}&typ=ALL&limit=8`;
  const items = await bahnFetch(url);

  return items.map(item => {
    const isAddress = item.type === 'ADR';
    const products = {};
    if (!isAddress && item.products) {
      for (const p of item.products) {
        const mapped = PRODUCT_MAP[p];
        if (mapped) products[mapped] = true;
      }
    }

    return {
      type: isAddress ? 'location' : 'stop',
      id: isAddress ? undefined : item.extId,
      name: item.name,
      address: isAddress ? item.name : undefined,
      latitude: item.lat,
      longitude: item.lon,
      location: { latitude: item.lat, longitude: item.lon },
      products: isAddress ? undefined : products,
    };
  });
}

// ─── Journey search ──────────────────────────────────

async function searchJourneys(from, to, departure, arrival, count, opts = {}) {
  const { viaStops, excludeProducts } = opts;

  // Build product list, excluding any user-specified types
  let products = ALL_PRODUCTS;
  if (excludeProducts?.length > 0) {
    const excluded = new Set(excludeProducts.map(p => p.toUpperCase()));
    products = ALL_PRODUCTS.filter(p => !excluded.has(p));
  }

  const body = {
    abfahrtsHalt: buildHaltId(from),
    ankunftsHalt: buildHaltId(to),
    anfrageZeitpunkt: formatLocalTime(arrival ? new Date(arrival) : new Date(departure)),
    ankunftSuche: arrival ? 'ANKUNFT' : 'ABFAHRT',
    klasse: 'KLASSE_2',
    reisende: [{
      typ: 'ERWACHSENER',
      anzahl: 1,
      alter: [],
      ermaessigungen: [{ art: 'KEINE_ERMAESSIGUNG', klasse: 'KLASSENLOS' }],
    }],
    produktgattungen: products,
    schnelleVerbindungen: false,
    sitzplatzOnly: false,
    bikeCarriage: false,
    reservierungsKontingenteVorhanden: false,
  };

  // Add via stops (Zwischenhalte)
  if (viaStops?.length > 0) {
    body.zwischenhalte = viaStops.map(stop => ({
      id: buildHaltId(stop.id || stop),
    }));
  }

  const data = await bahnFetch(`${BAHN_API}/angebote/fahrplan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const verbindungen = data.verbindungen || [];
  return verbindungen.slice(0, count).map(transformJourney);
}

// ─── Timetable: iCal fetching with a short-lived cache ─────

let timetableCache = { data: null, url: null, fetchedAt: 0 };
const TIMETABLE_CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours

async function fetchTimetable(timetableUrl) {
  if (timetableCache.data && timetableCache.url === timetableUrl
      && Date.now() - timetableCache.fetchedAt < TIMETABLE_CACHE_MS) {
    return timetableCache.data;
  }
  const events = await fetchTimetableEvents(timetableUrl);
  timetableCache = { data: events, url: timetableUrl, fetchedAt: Date.now() };
  return events;
}

// ─── HTTP server ─────────────────────────────────────

async function handleApi(url, res) {
  const path = url.pathname;
  const params = url.searchParams;

  try {
    if (path === '/api/locations') {
      const query = params.get('query');
      if (!query) return sendJson(res, 400, { error: 'query required' });
      const results = await searchLocations(query);
      return sendJson(res, 200, results);
    }

    if (path === '/api/journeys') {
      const from = parseLocation(params.get('from'));
      const to = parseLocation(params.get('to'));
      const departure = params.get('departure');
      const arrival = params.get('arrival');
      const count = parseInt(params.get('results') || '4', 10);

      if (!from || !to) return sendJson(res, 400, { error: 'from, to required' });
      if (!departure && !arrival) return sendJson(res, 400, { error: 'departure or arrival required' });

      // Parse via stops and excluded products
      let viaStops = null;
      const viaParam = params.get('via');
      if (viaParam) {
        try { viaStops = JSON.parse(viaParam); } catch { /* ignore */ }
      }
      const excludeParam = params.get('excludeProducts');
      const excludeProducts = excludeParam ? excludeParam.split(',').filter(Boolean) : null;

      const journeys = await searchJourneys(from, to, departure, arrival, count, { viaStops, excludeProducts });
      return sendJson(res, 200, { journeys });
    }

    if (path === '/api/timetable') {
      const timetableUrl = params.get('url');
      if (!timetableUrl) return sendJson(res, 400, { error: 'url required' });

      const weekStr = params.get('week'); // optional: YYYY-MM-DD in the target week
      const monday = weekStr ? getMonday(new Date(weekStr)) : getMonday(new Date());

      const events = await fetchTimetable(timetableUrl);
      const weekEvents = getEventsForWeek(events, monday);
      const pad2 = n => String(n).padStart(2, '0');
      const weekDate = `${monday.getFullYear()}-${pad2(monday.getMonth() + 1)}-${pad2(monday.getDate())}`;
      return sendJson(res, 200, {
        week: weekDate,
        days: weekEvents,
        cachedAt: new Date(timetableCache.fetchedAt).toISOString(),
      });
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('API error:', err.message);
    sendJson(res, 502, { error: err.message });
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

async function serveStatic(url, res) {
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  if (filePath.includes('..')) { res.writeHead(403); res.end(); return; }
  const full = join(__dir, filePath);
  try {
    const data = await readFile(full);
    const mime = MIME[extname(full)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) handleApi(url, res);
  else serveStatic(url, res);
});

server.listen(PORT, () => console.log(`Pendler läuft auf http://localhost:${PORT}`));
