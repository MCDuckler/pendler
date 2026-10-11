# Pendler for iPhone

SwiftUI app + one WidgetKit extension. iOS 17, no packages. `xcodegen` generates
`Pendler.xcodeproj` from `project.yml`. Mail Coach (the uni-mail to-do list) lives inside as the Mail tab.

- **App** (`App/`, `UI/`): Heute (countdown to leaving, lectures, connections, mail strip),
  Woche (timetable per weekday → plan any day), Navigator (A → B), Mail (Mail Coach's
  Today/Waiting/FYI/Done + thread view), Einstellungen. Local "los in N min" reminders.
- **Widgets** (`Widgets/`): *Pendler* (small/medium/large + lock screen circular/rectangular/inline)
  and *Uni-Mail* (Mail Coach's widget, unchanged). Each asks its server itself and falls back
  to what the app cached in the app group.
- **Shared** (`Shared/`, both targets): models, API clients (`Commute/PendlerAPI.swift`,
  `API.swift` for Mail Coach), `SharedStore`.

## Servers
- Pendler: `https://pendler.89-58-49-140.nip.io` — public endpoints, no token. A device token
  (`pendler pair` on the box → `pendler://pair?url=…&token=…`) only adds server pushes.
- Mail Coach: `https://pendler.89-58-49-140.nip.io/mail` — pair with the `mailcoach://pair` link
  the Mail Coach server prints (`python3 -m mailcoach pair`). Contract: `API.md`.

## App group under SideStore
With a free Apple ID SideStore renames `group.dance.duckduck.pendler` (team ID appended).
`SharedStore` finds the real name at runtime: configured id → `ALTAppGroups` in Info.plist
(own + containing app) → `embedded.mobileprovision`. Einstellungen › Status shows which group
was resolved ("nicht geteilt" = the widgets cannot see the settings).

## Build
Nothing compiles Swift on Linux here: CI (`.github/workflows/ios.yml`) is the compiler. Push to
`main` touching `ios/**`, a `v*` tag, or run it by hand. It builds unsigned, ad-hoc signs with the
entitlements, and makes a Release with `Pendler.ipa` + `latest.json`. On failure, read the
`build-log` artifact. SideStore source: `https://pendler.89-58-49-140.nip.io/app/source.json`.

Needs 2 SideStore App IDs (app + widget extension).
