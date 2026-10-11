import { BAHN_API, PRODUCT_MAP, bahnFetch, jsonResponse } from './_shared.js';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const query = url.searchParams.get('query');
  if (!query) return jsonResponse({ error: 'query required' }, 400);

  try {
    const apiUrl = `${BAHN_API}/reiseloesung/orte?suchbegriff=${encodeURIComponent(query)}&typ=ALL&limit=8`;
    const items = await bahnFetch(apiUrl);

    const results = items.map(item => {
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

    return jsonResponse(results);
  } catch (err) {
    return jsonResponse({ error: err.message }, 502);
  }
}
