// ─── EFA-BW transit provider ──────────────────────────────────────────
// NVBW's public EFA (the planner behind bwegt.de). Germany-wide, with realtime.
// bahn.de's web API answers datacenter and residential IPs alike with
// 403 OPS_BLOCKED (measured 2026-10-11), so this replaced it.
//
// Everything here returns the hafas-ish shapes Pendler v1 used, so the PWA's
// renderers (and the iOS app's models) don't care which upstream answered.

import { TtlCache, formatLocalTime } from './util.js';

export const EFA_BASE = process.env.EFA_BASE || 'https://www.efa-bw.de/nvbw';
// EFA drops connections from a default Python/undici User-Agent: send a real one.
const UA = 'Mozilla/5.0 (compatible; Pendler/2; +https://github.com/MCDuckler/pendler)';
const COORD_FMT = 'WGS84[dd.ddddd]';

// EFA product classes → v1 product names (the PWA's line colours key off these).
const CLASS_TO_PRODUCT = {
  0: 'regional', 1: 'suburban', 2: 'subway', 3: 'subway', 4: 'tram',
  5: 'bus', 6: 'bus', 7: 'bus', 8: 'tram', 9: 'ferry', 10: 'taxi', 11: 'regional',
  13: 'regional', 14: 'national', 15: 'national', 16: 'nationalExpress',
  17: 'bus', 19: 'bus',
};
const WALK_CLASSES = new Set([99, 100]);
const STAY_SEATED_CLASS = 97;
const BUS_CLASSES = new Set([5, 6, 7, 17, 19]);
const TRAM_CLASSES = new Set([4, 8]);

// The PWA's exclusion keys (from the bahn.de days) → EFA means of transport.
export const EXCLUDE_TO_MOT = {
  ICE: [16], EC_IC: [14, 15], IR: [14], REGIONAL: [0, 13], SBAHN: [1],
  BUS: [5, 6, 7, 17, 19], UBAHN: [2, 3], TRAM: [4, 8], ANRUFPFLICHTIG: [10],
};

const cache = new TtlCache(800);

async function efaGet(endpoint, params, { timeoutMs = 12000 } = {}) {
  const qs = new URLSearchParams({ outputFormat: 'rapidJSON', coordOutputFormat: COORD_FMT, ...params });
  const url = `${EFA_BASE}/${endpoint}?${qs}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'de-DE,de;q=0.9' },
    });
    if (!res.ok) throw new Error(`EFA ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Fahrplanauskunft antwortet nicht');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ─── Locations ────────────────────────────────────────────────────────

export function transformLocation(l) {
  const [lat, lon] = l.coord || [];
  const isStop = l.type === 'stop' || l.type === 'platform';
  const products = {};
  for (const c of l.productClasses || []) {
    const p = CLASS_TO_PRODUCT[c];
    if (p) products[p] = true;
  }
  return {
    type: isStop ? 'stop' : 'location',
    // Stops are addressed by id; everything else (addresses, POIs) by coordinates,
    // which every EFA endpoint accepts and which survive EFA re-numbering streets.
    id: isStop ? l.id : undefined,
    name: l.name,
    address: isStop ? undefined : l.name,
    latitude: lat,
    longitude: lon,
    location: { latitude: lat, longitude: lon },
    products: isStop ? products : undefined,
    kind: l.type, // stop | singlehouse | street | poi | suburb | …
  };
}

export async function searchLocations(query, { limit = 8 } = {}) {
  const key = `sf:${query.toLowerCase()}`;
  return cache.wrap(key, 24 * 3600e3, async () => {
    const data = await efaGet('XML_STOPFINDER_REQUEST', { type_sf: 'any', name_sf: query, anyMaxSizeHitList: '30' });
    const locs = (data.locations || [])
      .filter(l => l.coord && l.type !== 'unknown')
      .sort((a, b) => (b.isBest - a.isBest) || ((b.matchQuality || 0) - (a.matchQuality || 0)));
    return locs.slice(0, limit).map(transformLocation);
  });
}

// A location as the client sends it → EFA's type_x/name_x pair.
export function efaPoint(loc) {
  if (typeof loc === 'string') return { type: 'any', name: loc };
  const lat = loc.latitude ?? loc.location?.latitude;
  const lon = loc.longitude ?? loc.location?.longitude;
  // A stop id from EFA ("de:08231:50") is the most precise; bare numeric ids are
  // bahn.de EVA numbers saved by v1, which EFA doesn't know — use the coordinates.
  if (loc.id && !/^\d+$/.test(String(loc.id))) return { type: 'any', name: String(loc.id) };
  if (lat != null && lon != null) return { type: 'coord', name: `${lon}:${lat}:${COORD_FMT}` };
  if (loc.name) return { type: 'any', name: loc.name };
  throw new Error('Ort ohne ID oder Koordinaten');
}

// ─── Journeys ─────────────────────────────────────────────────────────

const delaySec = (planned, est) =>
  planned && est ? Math.round((Date.parse(est) - Date.parse(planned)) / 1000) : 0;

function platformOf(point) {
  const p = point?.properties || {};
  if (p.platformName) return p.platformName;
  if (p.platform) return p.platform;
  return point?.pointType === 'TRACK' ? point.disassembledName : null;
}

function lineName(t) {
  const cls = t.product?.class;
  const num = t.disassembledName || t.number;
  if (BUS_CLASSES.has(cls)) return `Bus ${num}`;
  if (TRAM_CLASSES.has(cls)) return `STR ${num}`;
  // Long-distance trains carry only the train number in `number` ("2068");
  // the type ("IC") sits in the properties.
  const type = t.properties?.trainType;
  if (type && /^\d+$/.test(t.number || '')) return `${type} ${t.number}`;
  return t.number || t.name || num || '?';
}

function legRemarks(l) {
  const out = [];
  for (const i of l.infos || []) {
    if (!['high', 'veryHigh'].includes(i.priority)) continue;
    const text = i.infoLinks?.[0]?.urlText || i.infoLinks?.[0]?.title;
    if (text) out.push(text);
  }
  return out;
}

export function transformLeg(l) {
  const t = l.transportation || {};
  const cls = t.product?.class;
  const walking = WALK_CLASSES.has(cls);
  const transfer = cls === STAY_SEATED_CLASS;
  const o = l.origin || {};
  const d = l.destination || {};
  const plannedDeparture = o.departureTimePlanned;
  const plannedArrival = d.arrivalTimePlanned;
  const departure = o.departureTimeEstimated || plannedDeparture;
  const arrival = d.arrivalTimeEstimated || plannedArrival;
  const status = l.realtimeStatus || [];
  return {
    origin: { name: o.name || '', id: o.parent?.id || o.id },
    destination: { name: d.name || '', id: d.parent?.id || d.id },
    plannedDeparture,
    departure,
    plannedArrival,
    arrival,
    departureDelay: delaySec(plannedDeparture, o.departureTimeEstimated),
    arrivalDelay: delaySec(plannedArrival, d.arrivalTimeEstimated),
    departurePlatform: walking ? null : platformOf(o),
    arrivalPlatform: walking ? null : platformOf(d),
    platformChanged: o.properties?.platformChange === 'changed' || d.properties?.platformChange === 'changed',
    line: walking || transfer ? null : { name: lineName(t), product: CLASS_TO_PRODUCT[cls] || 'regional' },
    direction: t.destination?.name || null,
    walking,
    transfer,
    distance: l.distance || null,
    realtime: !!l.isRealtimeControlled,
    cancelled: status.includes('TRIP_CANCELLED') || !!l.isCancelled,
    remarks: legRemarks(l),
  };
}

export function transformJourney(j) {
  const legs = (j.legs || []).map(transformLeg);
  return { legs, cancelled: legs.some(l => l.cancelled) };
}

/**
 * opts: { from, to, departure|arrival (ISO instant), results, via: [loc], excludeProducts: [key] }
 * from/to/via: EFA id string, or a location object (stop or address with coordinates).
 */
export async function searchJourneys(opts) {
  const { from, to, departure, arrival, results = 4, via = [], excludeProducts = [] } = opts;
  const when = new Date(arrival || departure || Date.now());
  const local = formatLocalTime(when); // YYYY-MM-DDTHH:MM:SS, Europe/Berlin
  const o = efaPoint(from);
  const d = efaPoint(to);
  const params = {
    type_origin: o.type, name_origin: o.name,
    type_destination: d.type, name_destination: d.name,
    itdDate: local.slice(0, 10).replaceAll('-', ''),
    itdTime: local.slice(11, 16).replace(':', ''),
    itdTripDateTimeDepArr: arrival ? 'arr' : 'dep',
    calcNumberOfTrips: String(Math.min(Math.max(results, 1), 8)),
    useRealtime: '1',
    routeType: 'LEASTTIME',
  };
  // EFA takes one via point; the PWA allowed several on bahn.de — use the first.
  if (via?.length) {
    const v = efaPoint(via[0]);
    Object.assign(params, { type_via: v.type, name_via: v.name });
  }
  const mots = new Set(excludeProducts.flatMap(k => EXCLUDE_TO_MOT[String(k).toUpperCase()] || []));
  if (mots.size) {
    params.excludedMeans = 'checkbox';
    for (const m of mots) params[`exclMOT_${m}`] = '1';
  }
  const key = `trip:${JSON.stringify(params)}`;
  return cache.wrap(key, 45e3, async () => {
    const data = await efaGet('XML_TRIP_REQUEST2', params, { timeoutMs: 15000 });
    const journeys = (data.journeys || []).map(transformJourney);
    if (!journeys.length) {
      const msg = (data.systemMessages || []).find(m => m.type === 'error')?.text;
      if (msg) throw new Error(`Keine Verbindung gefunden (${msg})`);
    }
    // EFA answers arrival searches latest-first; keep the PWA's chronological order.
    journeys.sort((a, b) => Date.parse(a.legs[0]?.departure) - Date.parse(b.legs[0]?.departure));
    return journeys.slice(0, results);
  });
}

// ─── Departures ───────────────────────────────────────────────────────

export function transformStopEvent(e) {
  const t = e.transportation || {};
  const cls = t.product?.class;
  return {
    stop: { id: e.location?.parent?.id || e.location?.id, name: e.location?.parent?.name || e.location?.name },
    plannedWhen: e.departureTimePlanned,
    when: e.departureTimeEstimated || e.departureTimePlanned,
    delay: delaySec(e.departureTimePlanned, e.departureTimeEstimated),
    platform: platformOf(e.location),
    line: { name: lineName(t), product: CLASS_TO_PRODUCT[cls] || 'regional' },
    direction: t.destination?.name || null,
    realtime: !!e.isRealtimeControlled,
    cancelled: (e.realtimeStatus || []).includes('TRIP_CANCELLED') || !!e.isCancelled,
  };
}

export async function departures(stop, { limit = 10, when } = {}) {
  const p = efaPoint(stop);
  const params = { type_dm: p.type, name_dm: p.name, mode: 'direct', useRealtime: '1', limit: String(limit) };
  if (when) {
    const local = formatLocalTime(new Date(when));
    params.itdDate = local.slice(0, 10).replaceAll('-', '');
    params.itdTime = local.slice(11, 16).replace(':', '');
  }
  return cache.wrap(`dm:${JSON.stringify(params)}`, 30e3, async () => {
    const data = await efaGet('XML_DM_REQUEST', params);
    return (data.stopEvents || []).map(transformStopEvent);
  });
}
