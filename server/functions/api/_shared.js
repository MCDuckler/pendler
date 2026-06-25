// ─── Shared helpers for Cloudflare Pages Functions ──

export const BAHN_API = 'https://www.bahn.de/web/api';

export const PRODUCT_MAP = {
  ICE: 'nationalExpress',
  EC_IC: 'national',
  IR: 'regionalExpress',
  REGIONAL: 'regional',
  SBAHN: 'suburban',
  BUS: 'bus',
  UBAHN: 'subway',
  TRAM: 'tram',
  SCHIFF: 'ferry',
  ANRUFPFLICHTIG: 'taxi',
};

export const ALL_PRODUCTS = ['ICE', 'EC_IC', 'IR', 'REGIONAL', 'SBAHN', 'BUS', 'UBAHN', 'TRAM', 'ANRUFPFLICHTIG'];

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function bahnFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Accept': 'application/json',
      'Accept-Language': 'de-DE,de;q=0.9',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Origin': 'https://www.bahn.de',
      'Referer': 'https://www.bahn.de/',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`bahn.de ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export function buildHaltId(loc) {
  if (typeof loc === 'string') {
    return `A=1@L=${loc}@`;
  }
  // Coordinate halt — only valid with real lat/lon, else we'd emit X=NaN.
  if ((loc.type === 'location' || loc.address) && loc.longitude != null && loc.latitude != null) {
    const x = Math.round(loc.longitude * 1e6);
    const y = Math.round(loc.latitude * 1e6);
    const name = loc.address || loc.name || '';
    return `A=2@O=${name}@X=${x}@Y=${y}@`;
  }
  if (loc.id) return `A=1@L=${loc.id}@`;
  return `A=1@L=${loc}@`;
}

// bahn.de's anfrageZeitpunkt is a German wall-clock time with no offset.
// The client sends an absolute instant (UTC ISO), so we must render it in
// Europe/Berlin explicitly — getHours() would read the host timezone, which is
// UTC on Cloudflare Workers and would shift every query by 1–2 hours.
export function formatLocalTime(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  const hour = parts.hour === '24' ? '00' : parts.hour; // some engines emit "24" at midnight
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}`;
}

export function parseLocation(str) {
  if (!str) return null;
  if (str.startsWith('{')) {
    try { return JSON.parse(str); } catch { /* fall through */ }
  }
  return str;
}

export function transformJourney(v) {
  const legs = (v.verbindungsAbschnitte || []).map(transformLeg);
  return { legs };
}

function transformLeg(s) {
  const vm = s.verkehrsmittel || {};
  const isWalk = vm.typ === 'WALK';
  const isTransfer = vm.typ === 'TRANSFER';

  const depSoll = s.abfahrt?.sollzeit || s.abfahrtsZeitpunkt;
  const depIst = s.abfahrt?.istzeit;
  const arrSoll = s.ankunft?.sollzeit || s.ankunftsZeitpunkt;
  const arrIst = s.ankunft?.istzeit;

  const depDelay = depIst && depSoll ? Math.round((new Date(depIst) - new Date(depSoll)) / 1000) : 0;
  const arrDelay = arrIst && arrSoll ? Math.round((new Date(arrIst) - new Date(arrSoll)) / 1000) : 0;

  const depGleis = s.startHalt?.abfahrt?.gleis || s.startHalt?.abfahrt?.ezGleis;
  const arrGleis = s.zielHalt?.ankunft?.gleis || s.zielHalt?.ankunft?.ezGleis;

  const product = PRODUCT_MAP[vm.produktGattung] || vm.produktGattung?.toLowerCase();

  return {
    origin: { name: s.startHalt?.name || s.abfahrtsOrt || '' },
    destination: { name: s.zielHalt?.name || s.ankunftsOrt || '' },
    plannedDeparture: depSoll,
    departure: depIst || depSoll,
    plannedArrival: arrSoll,
    arrival: arrIst || arrSoll,
    departureDelay: depDelay,
    arrivalDelay: arrDelay,
    departurePlatform: depGleis || null,
    arrivalPlatform: arrGleis || null,
    line: isWalk || isTransfer ? null : {
      name: vm.mittelText || vm.name || vm.linienNummer || '?',
      product,
    },
    direction: vm.richtung || null,
    walking: isWalk,
    transfer: isTransfer,
    distance: s.entfernung || null,
  };
}
