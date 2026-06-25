import {
  BAHN_API, ALL_PRODUCTS, bahnFetch, buildHaltId,
  formatLocalTime, parseLocation, transformJourney, jsonResponse,
} from './_shared.js';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const params = url.searchParams;

  const from = parseLocation(params.get('from'));
  const to = parseLocation(params.get('to'));
  const departure = params.get('departure');
  const arrival = params.get('arrival');
  const count = parseInt(params.get('results') || '4', 10);

  if (!from || !to) return jsonResponse({ error: 'from, to required' }, 400);
  if (!departure && !arrival) return jsonResponse({ error: 'departure or arrival required' }, 400);

  let viaStops = null;
  const viaParam = params.get('via');
  if (viaParam) {
    try { viaStops = JSON.parse(viaParam); } catch { /* ignore */ }
  }
  const excludeParam = params.get('excludeProducts');
  const excludeProducts = excludeParam ? excludeParam.split(',').filter(Boolean) : null;

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

  if (viaStops?.length > 0) {
    body.zwischenhalte = viaStops.map(stop => ({
      id: buildHaltId(stop.id || stop),
    }));
  }

  try {
    const data = await bahnFetch(`${BAHN_API}/angebote/fahrplan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const verbindungen = data.verbindungen || [];
    const journeys = verbindungen.slice(0, count).map(transformJourney);
    return jsonResponse({ journeys });
  } catch (err) {
    return jsonResponse({ error: err.message }, 502);
  }
}
