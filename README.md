# Pendler

When do I have to leave for my lecture? Pendler reads a university timetable (LSF/HIC or any
`.ics` feed), looks up live connections, and tells you when to go — on the web, in an iPhone
app, and in widgets. The iPhone app also carries a uni-mail to-do list (formerly Mail Coach).

**v2 is being planned.** See [`docs/PLAN.md`](docs/PLAN.md).

- `server/` — Python service on the WetOwl box: transit (EFA), timetable, API, PWA hosting
- `web/` — the PWA
- `ios/` — SwiftUI app + WidgetKit extension, built to an ipa by GitHub Actions, installed via SideStore
