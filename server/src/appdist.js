// ─── iPhone builds: mirror GitHub releases, serve a SideStore source ──
// CI attaches Pendler.ipa, latest.json and icon.png to a release `ios-<ver>-<build>`.
// The box pulls the newest and serves it under /app/ with a SideStore source, so the
// phone only ever talks to this server.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const FILES = ['Pendler.ipa', 'latest.json', 'icon.png'];
const GH_HEADERS = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'pendler-server' };

// The repo is public, so the plain releases API works without a token
// (60 requests/hour unauthenticated; this asks 4 times an hour).
export async function syncRelease({ repo, appDir, publicUrl, log = console }) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, { headers: GH_HEADERS });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const rels = (await res.json())
    .filter(r => r.tag_name.startsWith('ios-') && !r.draft)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (!rels.length) return null;
  const rel = rels.at(-1);
  const tag = rel.tag_name;
  const marker = join(appDir, '.tag');
  const have = existsSync(marker) ? (await readFile(marker, 'utf8')).trim() : '';
  if (have === tag && existsSync(join(appDir, 'Pendler.ipa'))) return tag;

  await mkdir(appDir, { recursive: true });
  for (const f of FILES) {
    const asset = rel.assets.find(a => a.name === f);
    if (!asset) { if (f === 'Pendler.ipa') throw new Error(`${tag} has no ${f}`); continue; }
    const r = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'pendler-server' }, redirect: 'follow' });
    if (!r.ok) throw new Error(`download ${f}: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (asset.size && buf.length !== asset.size) throw new Error(`download ${f}: ${buf.length} of ${asset.size} bytes`);
    await writeFile(join(appDir, `.${f}.new`), buf);
  }
  for (const f of FILES) {
    if (existsSync(join(appDir, `.${f}.new`))) await rename(join(appDir, `.${f}.new`), join(appDir, f));
  }
  const latest = JSON.parse(await readFile(join(appDir, 'latest.json'), 'utf8'));
  latest.url = `${publicUrl}/app/Pendler.ipa`;
  await writeFile(join(appDir, 'latest.json'), JSON.stringify(latest, null, 2));
  await writeSource(appDir, publicUrl, latest);
  await writeFile(marker, tag);
  log.info?.(`app release ${tag} (${latest.build})`);
  return tag;
}

async function writeSource(appDir, publicUrl, latest) {
  const path = join(appDir, 'source.json');
  let old = [];
  try { old = JSON.parse(await readFile(path, 'utf8')).apps[0].versions || []; } catch { /* first */ }
  const date = latest.built || new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const entry = {
    version: latest.version, buildVersion: latest.build, date,
    localizedDescription: latest.notes || `Build ${latest.build}`,
    downloadURL: latest.url, size: latest.bytes, minOSVersion: '17.0',
  };
  const versions = [entry, ...old.filter(v => v.buildVersion !== latest.build)].slice(0, 10);
  const icon = `${publicUrl}/app/icon.png`;
  const source = {
    name: 'Pendler',
    identifier: 'dance.duckduck.pendler.source',
    subtitle: 'Wann muss ich los? Plus Uni-Mail.',
    iconURL: icon,
    tintColor: '#2F9E6B',
    apps: [{
      name: 'Pendler',
      bundleIdentifier: 'dance.duckduck.pendler',
      developerName: 'MCDuckler',
      subtitle: 'Stundenplan + Live-Verbindungen + Uni-Mail',
      iconURL: icon,
      tintColor: '#2F9E6B',
      category: 'utilities',
      localizedDescription: 'Sagt dir anhand deines Stundenplans und der Live-Fahrplandaten, wann du los musst — mit Widgets. Enthält Mail Coach für die Uni-Mail.',
      version: latest.version,
      versionDate: date,
      downloadURL: latest.url,
      size: latest.bytes,
      versions,
      appPermissions: { entitlements: ['com.apple.security.application-groups'], privacy: {
        NSLocationWhenInUseUsageDescription: 'Für „Von hier" im Navigator.',
      } },
      screenshots: [],
    }],
    news: [],
  };
  await writeFile(path, JSON.stringify(source, null, 2));
}

export function startAppSync(opts, everyMs = 15 * 60e3) {
  if (!opts.repo || !opts.appDir || !opts.publicUrl) return null;
  const tick = () => syncRelease(opts).catch(e => (opts.log || console).error('app sync:', e.message));
  tick();
  return setInterval(tick, everyMs);
}
