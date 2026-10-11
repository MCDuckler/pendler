// Pendler server: PWA + API + iPhone builds, on the WetOwl box.
//
//   PORT=8080 node server/server.js            local dev (no pushes, no app mirror)
//
// Production settings come from the environment (deploy/pendler.service +
// /etc/pendler/pendler.env): HOST, PORT, DATA_DIR, PUBLIC_URL, APP_REPO,
// NTFY_URL, NTFY_TOPIC, NTFY_TOKEN.

// Lecture times are German wall-clock; the timetable code works in local time.
process.env.TZ = 'Europe/Berlin';

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { createApp } from './src/app.js';
import { Store } from './src/store.js';
import { Watcher } from './src/watch.js';
import { startAppSync } from './src/appdist.js';
import { searchJourneys } from './src/efa.js';
import { fetchTimetableEvents } from './src/timetable.js';
import { TtlCache } from './src/util.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = process.env;
const PORT = +(env.PORT || 8080);
const HOST = env.HOST || '127.0.0.1';
const DATA_DIR = env.DATA_DIR || join(root, '.data');
const APP_DIR = join(DATA_DIR, 'app');
const PUBLIC_URL = (env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

let version = 'dev';
try { version = readFileSync(join(root, 'VERSION'), 'utf8').trim(); } catch { /* dev checkout */ }

const store = new Store(DATA_DIR);
const ttCache = new TtlCache(200);
const timetableEvents = url => ttCache.wrap(`tt:${url}`, 6 * 3600e3, () => fetchTimetableEvents(url));

const handle = createApp({
  webDir: join(root, 'web'),
  appDir: APP_DIR,
  store,
  version,
  deps: { timetableEvents },
});

createServer(handle).listen(PORT, HOST, () => {
  console.log(`Pendler ${version} on http://${HOST}:${PORT} (public ${PUBLIC_URL})`);
});

new Watcher({
  store,
  deps: { search: searchJourneys, timetableEvents },
  ntfy: { url: env.NTFY_URL, topic: env.NTFY_TOPIC, token: env.NTFY_TOKEN },
}).start();

startAppSync({ repo: env.APP_REPO, appDir: APP_DIR, publicUrl: PUBLIC_URL });
