# Pendler server API

Base: `https://pendler.89-58-49-140.nip.io` (Caddy → `pendler` on `172.18.0.1:8792`).
JSON, camelCase. Times are UTC ISO instants (`2026-10-12T05:54:00Z`); `HH:MM` strings and
`YYYY-MM-DD` dates are German wall-clock. Errors: `{"error": "…"}` with a 4xx/5xx status.
Public endpoints are rate-limited per IP (120/min); requests with a device token are not.

Mail Coach is proxied at `/mail/*` (its own contract: `ios/API.md`).

## Public (what the PWA and the app use)

| | |
|---|---|
| `GET /api/health` | `{ok, version}` |
| `GET /api/locations?query=` | `[Place]` — stops have `id` (EFA, e.g. `de:08231:50`), addresses only coordinates |
| `GET /api/journeys?from=&to=&departure=\|arrival=&results=&via=&excludeProducts=` | `{journeys: [Journey]}` |
| `GET /api/departures?stop=&limit=&when=` | `{departures: [StopEvent]}` |
| `GET /api/timetable?url=&week=YYYY-MM-DD` | `{week, days: {"1": [Lecture], …}}` (0 = Sunday) |
| `POST /api/today` body: profile | `{generatedAt, today: DayPlan, next: DayPlan\|null}` |
| `POST /api/day?date=YYYY-MM-DD` body: profile | `DayPlan` |
| `GET /unis/index.json`, `/unis/<id>.json` | university list and course catalogs (also used by the PWA) |
| `GET /app/source.json`, `/app/latest.json`, `/app/Pendler.ipa` | SideStore source, update manifest, newest build |

`from`/`to`/`via`/`stop`: an EFA stop id, or a JSON-encoded Place (addresses route by coordinates).
`excludeProducts`: comma list of `ICE, EC_IC, IR, REGIONAL, SBAHN, BUS, UBAHN, TRAM, ANRUFPFLICHTIG`.

**Profile** = the PWA's config object: `homeLocation`, `workLocation` (Place), `scheduleMode`
(`timetable` | `manual`), `timetableUrl`, `timetableLeadMin`, `days` (`{"1": {enabled, outboundTime, returnTime}}`),
`outboundMode`/`returnMode` (`arrival` | `departure`), `viaStops`, `excludedProducts`, `results`.

**Journey**: `{legs: [Leg], cancelled}`. **Leg**: `origin{name,id}`, `destination{name,id}`,
`plannedDeparture`, `departure` (realtime if known), `plannedArrival`, `arrival`, `departureDelay`,
`arrivalDelay` (seconds), `departurePlatform`, `arrivalPlatform`, `platformChanged`,
`line{name, product}` (null for walks), `direction`, `walking`, `transfer`, `distance` (m),
`realtime`, `cancelled`, `remarks[]`.

**DayPlan**: `{date, dow, setup, source, lectures: [Lecture], commute, timetableError?, outbound?, return?}`;
each of `outbound`/`return` is a LegPlan `{target: "HH:MM", targetAt, mode, journeys, best, leaveAt, arriveAt, delay, error?}`.
`best` = the recommended journey: arrival mode → the latest departure that still arrives by the target
(realtime), departure mode → the first one at/after the target. `next` is filled once today has
nothing left (return trip gone, or no commute today): the next commute day within a week.

## Paired device (`Authorization: Bearer <token>`)

Pair on the box: `pendler pair "iPhone"` → `pendler://pair?url=…&token=…`.

| | |
|---|---|
| `GET /api/device` | `{id, name, notify, hasProfile, profileAt}` |
| `PUT /api/device/profile` body `{profile, notify: {leadMin, enabled}}` | stores the profile the push watcher plans with |
| `GET /api/today` | today's plan from the stored profile |

## Pushes (ntfy topic `pendler`)
For paired devices with a profile the server re-plans every 2 min from 90 min before leaving
(every 15 min otherwise) and pushes once each: *los in N min* (`leadMin` before), delay ≥ 3 min
(in 3-minute steps), platform change, cancellation of the connection it recommended earlier.
Subscribe in the ntfy app: server `https://ntfy.89-58-49-140.nip.io`, topic `pendler`, user `phone`.
