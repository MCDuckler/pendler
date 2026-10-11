// ─── Push watcher ─────────────────────────────────────────────────────
// For every paired device with a profile: keep today's plan fresh (every 2 min
// close to a departure, every 15 min otherwise) and push through ntfy when it's
// time to leave, when the recommended connection is late, cancelled, or moves
// platform. iOS can't wake a sideloaded app (no APNs), so ntfy carries these.

import { planToday } from './plan.js';

const MIN = 60e3;
const WINDOW_BEFORE = 90 * MIN; // watch closely from 90 min before leaving

const hhmm = iso => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });

function firstRide(j) { return j.legs.find(l => l.line) || j.legs[0]; }
const sig = j => { const r = firstRide(j); return `${r.line?.name || 'walk'}@${r.plannedDeparture}`; };

function describe(j) {
  const r = firstRide(j);
  const plat = r.departurePlatform ? ` · Gl. ${r.departurePlatform}` : '';
  const late = r.departureDelay >= 60 ? ` (+${Math.round(r.departureDelay / 60)})` : '';
  return `${r.line?.name || 'Fußweg'} ${hhmm(r.plannedDeparture)}${late}${plat}`;
}

export class Watcher {
  constructor({ store, deps, ntfy, log = console }) {
    this.store = store;
    this.deps = deps;
    this.ntfy = ntfy; // { url, topic, token }
    this.log = log;
    this.state = new Map(); // deviceId → { plan, planAt, best: {dir: sig} }
  }

  start(intervalMs = MIN) {
    if (!this.ntfy?.url || !this.ntfy?.topic) {
      this.log.info?.('watcher: ntfy not configured, pushes off');
      return;
    }
    const tick = () => this.tick().catch(e => this.log.error('watcher:', e.message));
    this.timer = setInterval(tick, intervalMs);
    tick();
  }

  stop() { clearInterval(this.timer); }

  async push(title, message, { priority = 3, tags = [] } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.ntfy.token) headers.Authorization = `Bearer ${this.ntfy.token}`;
    const res = await fetch(this.ntfy.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ topic: this.ntfy.topic, title, message, priority, tags, click: 'pendler://today' }),
    });
    if (!res.ok) throw new Error(`ntfy ${res.status}`);
  }

  needsRefresh(st, now) {
    if (!st?.plan) return true;
    const age = now - st.planAt;
    const legs = [st.plan.today?.outbound, st.plan.today?.return].filter(Boolean);
    const close = legs.some(l => l.leaveAt && now > Date.parse(l.leaveAt) - WINDOW_BEFORE && now < Date.parse(l.leaveAt) + 5 * MIN);
    return age > (close ? 2 * MIN : 15 * MIN);
  }

  async tick(now = Date.now()) {
    for (const d of this.store.data.devices) {
      if (!d.profile || d.notify?.enabled === false) continue;
      let st = this.state.get(d.id);
      if (!this.needsRefresh(st, now)) continue;
      const plan = await planToday(d.profile, this.deps, new Date(now));
      st = { plan, planAt: now, best: st?.best || {} };
      this.state.set(d.id, st);
      for (const dir of ['outbound', 'return']) {
        const leg = plan.today?.[dir];
        if (leg) await this.check(d, plan.today.date, dir, leg, st, now);
      }
    }
  }

  async once(d, key, title, msg, opts) {
    if (this.store.wasSent(d.id, key)) return;
    this.store.markSent(d.id, key);
    try { await this.push(title, msg, opts); } catch (e) { this.log.error('push failed:', e.message); }
  }

  async check(d, date, dir, leg, st, now) {
    const base = `${date}:${dir}`;
    const label = dir === 'outbound' ? 'Hinweg' : 'Rückweg';
    const prevSig = st.best[dir];

    // The connection we recommended earlier got cancelled → say so, once.
    if (prevSig) {
      const prev = leg.journeys.find(j => sig(j) === prevSig);
      if (prev?.cancelled) {
        await this.once(d, `${base}:cancel:${prevSig}`, `${label}: Fahrt fällt aus`,
          `${describe(prev)} fällt aus.${leg.journeys[leg.best] ? ` Alternative: ${describe(leg.journeys[leg.best])}` : ''}`,
          { priority: 5, tags: ['x'] });
      }
    }
    const best = leg.journeys[leg.best];
    if (!best) return;
    st.best[dir] = sig(best);
    const leaveAt = Date.parse(leg.leaveAt);
    if (!(now > leaveAt - WINDOW_BEFORE && now < leaveAt + 2 * MIN)) return;

    const r = firstRide(best);
    const lateMin = Math.round((r.departureDelay || 0) / 60);
    if (lateMin >= 3) {
      // Bucketed so 3, 4, 5 minutes late don't each buzz the phone.
      await this.once(d, `${base}:delay:${sig(best)}:${Math.floor(lateMin / 3)}`, `${label}: +${lateMin} min`,
        `${describe(best)} — los um ${hhmm(leg.leaveAt)}`, { priority: 4, tags: ['hourglass'] });
    }
    if (r.platformChanged && r.departurePlatform) {
      await this.once(d, `${base}:platform:${sig(best)}:${r.departurePlatform}`, `${label}: Gleiswechsel`,
        `${describe(best)}`, { priority: 4, tags: ['twisted_rightwards_arrows'] });
    }
    const lead = (d.notify?.leadMin ?? 10) * MIN;
    if (now >= leaveAt - lead && now < leaveAt) {
      const inMin = Math.max(1, Math.round((leaveAt - now) / MIN));
      await this.once(d, `${base}:leave:${sig(best)}`, `${label}: los in ${inMin} min`,
        `${describe(best)} · an ${hhmm(leg.arriveAt)}`, { priority: 4, tags: ['runner'] });
    }
  }
}
