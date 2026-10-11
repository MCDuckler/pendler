import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';

const webDir = fileURLToPath(new URL('../../web', import.meta.url));
const store = new Store(mkdtempSync(join(tmpdir(), 'pendler-test-')));
let server, base;
const seen = [];

before(async () => {
  const handle = createApp({
    webDir, appDir: null, store, ratePerMinute: 5,
    deps: {
      searchLocations: async q => [{ type: 'stop', id: 'x', name: q }],
      searchJourneys: async o => { seen.push(o); return []; },
      timetableEvents: async () => [],
    },
  });
  server = createServer(handle).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('serves the PWA shell, refuses path traversal', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<html/i);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  const t = await fetch(`${base}/%2e%2e/package.json`);
  assert.notEqual(t.status, 200);
});

test('v1 journeys contract: parses from/to/via/excludeProducts', async () => {
  const via = JSON.stringify([{ id: 'v' }]);
  const r = await fetch(`${base}/api/journeys?from=a&to=${encodeURIComponent('{"type":"location","latitude":1,"longitude":2}')}&departure=2026-10-12T06:00:00Z&via=${encodeURIComponent(via)}&excludeProducts=BUS,ICE`);
  assert.equal(r.status, 200);
  const o = seen.at(-1);
  assert.equal(o.from, 'a');
  assert.equal(o.to.latitude, 1);
  assert.deepEqual(o.via, [{ id: 'v' }]);
  assert.deepEqual(o.excludeProducts, ['BUS', 'ICE']);
});

test('missing params → 400 JSON error', async () => {
  const r = await fetch(`${base}/api/journeys?from=a`);
  assert.equal(r.status, 400);
  assert.ok((await r.json()).error);
});

test('pairing: token unlocks the device routes, profile round-trips', async () => {
  const { token } = store.pair('test');
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/device`)).status, 401);
  const put = await fetch(`${base}/api/device/profile`, { method: 'PUT', headers: h,
    body: JSON.stringify({ profile: { homeLocation: { id: 'a' }, workLocation: { id: 'b' }, days: {} }, notify: { leadMin: 7 } }) });
  assert.equal(put.status, 200);
  const dev = await (await fetch(`${base}/api/device`, { headers: h })).json();
  assert.equal(dev.hasProfile, true);
  assert.equal(dev.notify.leadMin, 7);
});

test('public endpoints are rate limited per IP', async () => {
  let last;
  for (let i = 0; i < 8; i++) last = await fetch(`${base}/api/locations?query=x`, { headers: { 'X-Forwarded-For': '9.9.9.9' } });
  assert.equal(last.status, 429);
});
