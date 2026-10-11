// ─── Paired devices ───────────────────────────────────────────────────
// A handful of rows at most (it's a personal box), so a JSON file written
// atomically is plenty. Tokens are stored as sha256 only.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const hashToken = t => createHash('sha256').update(t).digest('hex');

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.path = join(dir, 'devices.json');
    mkdirSync(dir, { recursive: true });
    try {
      this.data = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      this.data = { devices: [], sent: {} };
    }
    this.data.devices ??= [];
    this.data.sent ??= {};
  }

  save() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  pair(name) {
    const token = randomBytes(24).toString('base64url');
    const device = {
      id: randomBytes(4).toString('hex'),
      name: name || 'iPhone',
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
      lastSeen: null,
      profile: null,
      notify: { enabled: true, leadMin: 10 },
    };
    this.data.devices.push(device);
    this.save();
    return { device, token };
  }

  unpair(id) {
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter(d => d.id !== id);
    delete this.data.sent[id];
    this.save();
    return this.data.devices.length < before;
  }

  byToken(token) {
    if (!token) return null;
    const h = hashToken(token);
    return this.data.devices.find(d => d.tokenHash === h) || null;
  }

  touch(device) {
    // Only persist lastSeen at minute granularity — widgets poll a lot.
    const now = new Date().toISOString().slice(0, 16);
    if (device.lastSeen?.slice(0, 16) !== now) {
      device.lastSeen = new Date().toISOString();
      this.save();
    }
  }

  setProfile(device, profile, notify) {
    device.profile = profile;
    if (notify) device.notify = { ...device.notify, ...notify };
    device.profileAt = new Date().toISOString();
    this.save();
  }

  // Push dedupe: keys already sent per device (pruned to the last 2 days).
  wasSent(deviceId, key) { return !!this.data.sent[deviceId]?.[key]; }
  markSent(deviceId, key) {
    const m = (this.data.sent[deviceId] ??= {});
    m[key] = Date.now();
    const cutoff = Date.now() - 2 * 86400e3;
    for (const [k, t] of Object.entries(m)) if (t < cutoff) delete m[k];
    this.save();
  }
}
