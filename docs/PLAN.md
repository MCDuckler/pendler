# Pendler v2 — plan

Written 2026-10-11. **Status 2026-10-11: phases 0–4 built and deployed, nothing verified on an
iPhone yet** (see §10).

v2 turns Pendler from a Cloudflare-hosted PWA into one product with three parts:

1. a **server on the WetOwl box** (89.58.49.140) that serves the PWA and the API,
2. a **native iPhone app** with **widgets**, shipped as an **ipa** through SideStore,
3. **Mail Coach merged in**: the uni-mail to-do list becomes a tab and a widget of the
   same app, so one install replaces two.

Everything is built by **GitHub Actions** in this repo.

---

## 1. Where things stand

### Pendler v1 (`~/IdeaProjects/commute-pwa`, local only, no git remote)
- Vanilla-JS PWA (`app.js` ~2000 lines, `style.css`, `index.html`, `sw.js`) with three tabs:
  **Pendler** (today: lectures → "leave at" for outbound + return, live delays),
  **Wochenplan** (week grid), **Navigator** (ad-hoc A→B). Onboarding picks uni → course →
  semester and builds an LSF/HIC timetable URL, or takes any `.ics` URL. Catalogs for 13 unis
  in `unis/*.json`. Config in `localStorage`.
- Backend = Cloudflare Pages Functions (`functions/api/`): `locations`, `journeys`
  (bahn.de web API), `timetable` (LSF page → iCal export → parsed events with
  RRULE/EXDATE/UNTIL, SSRF guard). `server.js` runs the same modules locally.
  `node --test` suite for the shared + timetable code.
- **13 files / ~1200 lines are uncommitted** in that checkout. They must be committed (or
  discarded) by the owner before the import in phase 0.

### Measured today (2026-10-11), these change the design
| Check | Laptop | WetOwl box |
|---|---|---|
| `bahn.de/web/api/reiseloesung/orte` | **403 `OPS_BLOCKED`** | **403 `OPS_BLOCKED`** |
| `app.services-bahn.de` (DB Navigator API) | — | **403 `OPS_BLOCKED`** |
| `v6.db.transport.rest` (v1's fallback) | 503 | 503 |
| `pendler-3sm.pages.dev` (v1 prod) | **does not resolve** | does not resolve |
| HIC/LSF `hic.hs-pforzheim.de` | — | 200 |
| **EFA-BW** `efa-bw.de/nvbw` stop finder + trip (rapidJSON, `useRealtime=1`) | — | **200, ~0.5 s** |

So v1's journey backend is dead and v1 prod is gone. EFA-BW returned correct trips with
realtime estimates for Pforzheim Hbf → Stuttgart (RE 1, +14 min), → Berlin and → Frankfurt
(RE + ICE chains), and Hbf → Hochschule/Wildpark (Stadtbus 5). It is Germany-wide, not only
BW. Note: EFA drops connections from a default Python User-Agent; send a real UA.

### Mail Coach (live since 2026-09-30)
- Server: private repo `MCDuckler/mailcoach`, stdlib Python, systemd `mailcoach` on the box,
  bound to `172.18.0.1:8790`, behind muse's Caddy at `https://89-58-49-140.nip.io/mail/`.
  IMAP read-only → SQLite → `claude -p` triage → digests + ntfy pushes. Contract: `API.md`.
- App: public repo `MCDuckler/mailcoach-ios`, SwiftUI iOS 17 + WidgetKit, XcodeGen,
  CI on `macos-15` builds unsigned → ad-hoc signs with entitlements → GitHub Release with
  `MailCoach.ipa` + `latest.json`; the box re-hosts it and serves a SideStore source.
  Runtime app-group resolution for SideStore's renamed groups. **Never verified on a device.**
- The box has Python 3.13, **no Node**. 7 GB RAM shared with muse.

---

## 2. Target shape

```
pendler/                         (this repo, public: macOS runners on private repos are blocked by billing)
├── server/                      Python 3.13, stdlib only — the "pendler" service
│   ├── pendler/
│   │   ├── transit/efa.py       EFA-BW provider (stops, trips, departures, realtime)
│   │   ├── transit/model.py     provider-neutral Location / Journey / Leg (v1's JSON shape)
│   │   ├── timetable.py         port of _timetable.js (LSF → iCal, RRULE/EXDATE/UNTIL, SSRF guard)
│   │   ├── plan.py              "when do I leave": lectures + profile → outbound/return options
│   │   ├── devices.py           paired devices + their commute profile (SQLite)
│   │   ├── notify.py            ntfy pushes (leave-now, delay changed)
│   │   └── http.py              API + static PWA
│   └── tests/                   unittest, fixtures recorded from EFA + LSF
├── web/                         the v1 PWA, pointed at /api/v2, no Cloudflare
├── ios/                         SwiftUI app + one WidgetKit extension (Mail Coach code merged in)
│   ├── project.yml              XcodeGen
│   ├── App/  UI/  Shared/  Widgets/  Resources/
├── deploy/                      systemd units, Caddy snippet, updater script
├── .github/workflows/           ios.yml, test.yml, server-release.yml
└── docs/                        PLAN.md, API.md (merged contract)
```

### Runtime on the box
```
phone / browser ──https──▶ Caddy (muse compose)
    pendler.89-58-49-140.nip.io
      /                → /opt/pendler/web          (PWA static files)
      /api/v2/*        → 172.18.0.1:8791           pendler service (new)
      /api/mail/*      → 172.18.0.1:8790           mailcoach (unchanged, path-rewritten)
      /app/*           → /var/lib/pendler/app      ipa, latest.json, source.json, icon
    89-58-49-140.nip.io/mail/*  → kept as-is until the old Mail Coach app is gone
```
`ntfy.89-58-49-140.nip.io` already got a Let's Encrypt cert, so a `pendler.` nip.io host works
too. A real domain can replace it later without app changes (the base URL is pairing data).

**Mail server stays in its private repo** (recommended default, see decisions): two services,
one host, one app. The pendler service never touches IMAP or Claude.

---

## 3. Server (phase 1–2)

**Language: Node** (decided after the plan: Node 24 LTS installed at `/opt/node` on the box), so
v1's timetable code and tests carried over as they were. Zero npm dependencies.

### API (`/api`, v1 paths kept so the PWA needed no routing changes — full contract in `docs/API.md`)
Public, stateless (what the PWA uses; rate-limited per IP, cached 60 s per query):
- `GET  /locations?q=` → stops/addresses (EFA stop finder, `type_sf=any`)
- `GET  /journeys?from=&to=&departure=|arrival=&via=&exclude=` → v1 journey JSON shape
  (legs, line, product, platform, planned/estimated times, delay) so the PWA renders unchanged
- `GET  /departures?stop=` → next departures (EFA `XML_DM_REQUEST`)
- `GET  /timetable?url=&week=` → events of one ISO week (port of v1)
- `GET  /unis`, `/unis/{id}/courses` → the `unis/*.json` catalogs

Paired device (Bearer token; same pairing flow Mail Coach has):
- `PUT  /profile` → home, uni stop, timetable URL or fixed work times, lead minutes, modes,
  via stops, excluded products, notification prefs
- `GET  /today` → **the one call widgets make**: today's lectures, chosen outbound option +
  2 alternatives, return option, `leave_at`, delays, plus mail counts (server asks mailcoach
  over loopback and embeds `counts` + `top[0..3]`, so a combined widget is one request)
- `GET  /week` → Wochenplan for the app
- `POST /pair` (CLI-issued), `DELETE /pair`

Background (only for paired devices, i.e. you):
- From 60 min before `leave_at` until departure, re-check the chosen trip every 2 min.
  Push via the existing ntfy instance when: leave-now (T−10), delay ≥ 3 min changed,
  cancellation, platform change. Quiet when no lectures.
- iOS cannot wake the widget without APNs (not available with a free Apple ID), so the push
  is a notification; the widget catches up on its own timeline (§5).

### Transit provider
`transit/efa.py` behind a small interface so a second provider can be added. EFA specifics to
handle: resolve names to stop ids first (bare names return "multiple matches"), times are UTC
`Z`, realtime in `departureTimeEstimated`, footpaths as their own legs, `coordOutputFormat=WGS84[dd.ddddd]`.
**Fallback idea, phase 2+:** call DB's API from the phone itself (mobile IP, not a datacenter)
if EFA misses something. Unverified — only build it if a real gap shows up.

### Deploy
- `/opt/pendler` (release tree) + `/var/lib/pendler` (devices JSON, ipa mirror), systemd
  `pendler.service` bound to `172.18.0.1:8792` (8791 is ntfy), ufw rule from `172.18/16` like mailcoach.
- **Pull-based updates, no box credentials in GitHub:** `pendler-update.timer` (every 15 min)
  runs `deploy/update.sh`: newest `server-*` release from the public API, sha256 check, unpack to
  `/opt/pendler/releases/<tag>`, flip `current`, restart, wait for `/api/health` to report the new
  tag, else flip back. The server itself mirrors the newest `ios-*` ipa into `/app/` and writes
  `source.json`.
- Caddy: `pendler.` site, Mail Coach `/mail` and the ntfy site are committed in the muse repo's
  `deploy/Caddyfile` (`publish.sh` copies that file over the box's on every muse deploy — which is
  how the uncommitted Mail Coach routes had silently disappeared).

---

## 4. iPhone app (phase 3)

Start from `mailcoach-ios` (imported with history), rename to **Pendler**.

- iOS 17, SwiftUI, no packages, XcodeGen. Bundle `dance.duckduck.pendler`, widget
  `dance.duckduck.pendler.widgets`, app group `group.dance.duckduck.pendler`, scheme
  `pendler://` (`mailcoach://pair` still accepted). Keep `SharedStore`'s runtime group
  resolution as is.
- **Tabs:** Heute · Woche · Navigator · Mail · Einstellungen
  - **Heute**: next lecture, big "Los in 12 min" countdown, chosen connection with legs,
    delay badges, alternatives; return trip after the last lecture; mail "needs you" strip.
  - **Woche**: v1 Wochenplan, tap a day → that day's Heute.
  - **Navigator**: from/to search, now / depart / arrive, swap, current location (CoreLocation
    when-in-use).
  - **Mail**: the existing Mail Coach screens (Today/Waiting/FYI/Done, thread view, swipe
    actions) moved under one tab, API base `/api/mail`.
  - **Einstellungen**: onboarding re-run (uni → course → semester, or .ics URL), home stop,
    lead time, modes, pairing, update check (existing `Updates.swift`), status.
- **Local notifications** scheduled from `/today` ("in 10 min los") so the basic reminder
  works even without the ntfy app. `BGAppRefreshTask` refreshes `/today` + reschedules.
- Look: v1 tokens (cream `#faf9f5`, emerald `#2f9e6b`, charcoal, transit line colours) as a
  `Style.swift` palette; system font; respects dark mode.

## 5. Widgets (phase 4)

One extension, several kinds (the extension counts as one extra SideStore App ID, so keep it one):

| Kind | Families | Shows |
|---|---|---|
| **Pendler** | small, medium | "Los in mm:ss" (`Text(.timer)`, ticks without reloads), line badge, departure, platform, delay; medium adds the next lecture + one alternative |
| **Heute** | large | lectures, outbound + return, top 3 mail items |
| **Mail** | small, medium, large | the existing Mail Coach widget, unchanged |
| **Lock screen** | circular, rectangular, inline | countdown ring to `leave_at` / "RE 1 16:28 +14 · Gl. 3" / "Los 16:18" |

Timeline: the provider calls `/today`, falls back to the cached payload in the app group, and
emits entries at each switch point (leave_at passed → show the next option; last lecture over
→ return trip). Reload policy `.after(min(next switch, now + 15 min))`; nights and lecture-free
days drop to hourly. The app calls `WidgetCenter.reloadAllTimelines()` after every refresh.

Stretch (phase 6): **Live Activity** for the trip in progress (countdown + next change,
started from the app, updated by the app while it runs — no push), **interactive widget**
buttons via App Intents ("next connection", "mark mail done"), Siri/Shortcuts intent
"Wann muss ich los?".

## 6. CI — GitHub Actions (phase 0 and on)

| Workflow | Runner | Trigger | Does |
|---|---|---|---|
| `test.yml` | ubuntu | every push / PR | `python -m unittest` (server), `node --test` (web), `xcodegen` spec lint |
| `server-release.yml` | ubuntu | push to `main` touching `server/ web/ deploy/`, `server-v*` tags | tarball of `server/ web/ deploy/` + sha256 → Release `server-<ver>-<stamp>` |
| `ios.yml` | macos-15 | push to `main` touching `ios/`, `v*` tags, manual | xcodegen → unsigned build → ad-hoc sign (appex, then app) with entitlements → verify `application-groups` present → `Pendler.ipa` + `latest.json` + `icon.png` → Release `ios-<ver>-<stamp>`; build log as artifact on failure |

`ios.yml` is the Mail Coach workflow with names changed and `paths:` scoped to `ios/**`
(the old one's README claims `ios/**` but the trigger has no such filter). Build number stays the
UTC stamp so SideStore always sees an update. Concurrency group per workflow so two pushes
don't race a release.

## 7. Phases

| # | What | Done when |
|---|---|---|
| 0 | **Bootstrap.** Owner commits/discards v1's pending changes. Import `commute-pwa` → `web/` and `mailcoach-ios` → `ios/` with history (`git filter-repo --to-subdirectory-filter`, then merge). Add `test.yml` + `ios.yml`, get a green ipa build of the renamed app. | Release `ios-0.2.0-*` exists, tests green |
| 1 | **Server core.** EFA provider, timetable port, plan engine, public API, recorded fixtures. Run locally against live EFA. | `/journeys` and `/timetable` match v1 output shape; unittest green |
| 2 | **Box.** systemd unit, Caddy site, updater timer, pairing, `/today`, ntfy pushes, mail proxy. PWA served from the box and pointed at `/api/v2`. | PWA usable at `https://pendler.89-58-49-140.nip.io` from a phone |
| 3 | **App.** Tabs, native onboarding, Navigator, Mail tab, local notifications, BG refresh. | ipa installs via SideStore, pairs, shows today |
| 4 | **Widgets.** Pendler / Heute / Mail / lock screen, timeline switch points. | Widgets show live data on the home + lock screen |
| 5 | **Cutover.** New SideStore source at `/app/source.json`; uninstall Mail Coach (frees a slot); archive `mailcoach-ios`; old `/mail/app/*` redirects to `/app/*`; delete the Cloudflare Pages project. | One app on the phone, old paths redirect |
| 6 | **Stretch.** Live Activity, interactive widgets, Shortcuts intent. | — |

Phases 1 and 3 can run in parallel once phase 0 is in.

## 8. Risks

- **Nothing iOS has been seen on a device yet.** Mail Coach's widget + app-group-under-SideStore
  path is unverified. Phase 0's first install is the real test. If the group can't be shared,
  the widget can't read the pairing token: it then shows only the public commute data it can
  fetch without one (journeys for a profile baked into the widget's own configuration intent),
  and mail counts are app-only until that is solved.
- **SideStore limits:** 3 active apps and 10 App IDs per 7 days on a free Apple ID; app +
  widget = 2 IDs. New bundle ids cost IDs, so don't churn them. Re-sign every 7 days.
- **EFA is unofficial.** Public endpoint, no key, no SLA. Cache, rate-limit, send an honest
  User-Agent, keep the provider interface so it can be swapped.
- **HIC/LSF outages** (v1 already handles them: fail fast, keep cached week). Keep that.
- **Box memory** (7 GB, muse workers). Pendler is small; cap it with `MemoryMax=256M`.
- **Public repo:** no tokens, passwords, or personal mail data in it, ever. Pairing tokens and
  ntfy credentials live only in `/etc/pendler/` on the box.

## 9. Decisions to confirm

1. **Mail server location** — *recommended:* stays in the private `mailcoach` repo, Pendler
   proxies `/api/mail`. Alternative: move it into `server/mail/` here after scrubbing prompts
   and config of personal details (the repo has to stay public for iOS CI).
2. **Domain** — *recommended:* `pendler.89-58-49-140.nip.io` now; a real domain later.
3. **Who can use it** — *recommended:* PWA + public API open to anyone (like v1), mail and
   pushes only for paired devices.
4. **Bundle id** — *recommended:* new `dance.duckduck.pendler`, not reusing Mail Coach's.
5. **Live Activity in v2.0 or later** — *recommended:* later (phase 6).

## 10. Progress log

**2026-10-11**
- Phase 0: v1 (`commute-pwa`, pending changes committed first) and `mailcoach-ios` imported with
  history into `web/`+`server/` and `ios/`. CI: `test.yml`, `server-release.yml`, `ios.yml`.
- Phase 1: `server/src/efa.js` (EFA-BW: stop finder, trips, departure monitor → v1 shapes),
  `plan.js` (when to leave; `today` + `next`), `app.js` (API + static + `/app`), `store.js`
  (paired devices), `watch.js` (ntfy pushes), `appdist.js` (ipa mirror). 40 tests, also under `TZ=UTC`.
- Phase 2: live at `https://pendler.89-58-49-140.nip.io` — PWA checked in headless Chromium with
  real EFA + HIC data. ntfy user `pendler` (write-only on topic `pendler`), `phone` can read it.
  Mail Coach `/mail` + ntfy site restored in Caddy (they had been dropped).
- Phases 3–4: iOS app (Heute / Woche / Navigator / Mail / Einstellungen, native onboarding,
  local reminders, BG refresh) + widgets (Pendler small/medium/large/lock screen, Uni-Mail).
  First CI build green; `ios-0.2.0-*` mirrored to `/app/source.json`.

**Open**
- Install on the iPhone via SideStore, check the app-group sharing under SideStore, then pair
  (`pendler pair` on the box) and subscribe to topic `pendler` in the ntfy app.
- Phase 5 cutover (remove Mail Coach app, archive `mailcoach-ios`, delete the CF Pages project).
- Phase 6 stretch (Live Activity, interactive widgets, Shortcuts).

