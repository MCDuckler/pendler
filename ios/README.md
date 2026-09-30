# Mail Coach for iPhone

SwiftUI app + WidgetKit extension for the Mail Coach server (see `../API.md`).
iOS 17, no packages. `xcodegen` generates `MailCoach.xcodeproj` from `project.yml`.

- **App** (`App/`, `UI/`): Today (digest + deadlines/reply/to-do), Waiting, FYI, Done,
  Settings. Swipe right = done, left = snooze/ignore. Thread view with all messages.
- **Widgets** (`Widgets/`): home screen small/medium/large, lock screen circular/
  rectangular/inline. Each fetches `/api/widget` itself, falls back to the cached payload.
- **Shared** (`Shared/`, both targets): models, API client, `SharedStore`.

## Pairing
Open `mailcoach://pair?url=<server>&token=<token>` on the phone (the server prints it).

## App group under SideStore
With a free Apple ID SideStore renames `group.dance.duckduck.mailcoach` (team ID
appended). `SharedStore` finds the real name at runtime: configured id → `ALTAppGroups`
in Info.plist (own + containing app) → `embedded.mobileprovision` entitlements. Settings ›
Status shows which group was resolved ("not shared" = widget cannot see the token).

## Build
Nobody compiles Swift on Linux here: CI (`.github/workflows/ios.yml`) is the compiler.
Push to `main` touching `ios/**`, a `v*` tag, or run it by hand. It builds unsigned, ad-hoc
signs with the entitlements, and makes a Release with `MailCoach.ipa` + `latest.json`.
On failure, read the `build-log` artifact. The box re-hosts the ipa at
`https://89-58-49-140.nip.io/mail/app/` (repo is private); SideStore source:
`https://89-58-49-140.nip.io/mail/app/source.json`.

Needs 2 SideStore slots (app + widget extension). If only one is free, install with
"remove extensions" — the app works, just without widgets.

The server side (IMAP sync, Claude triage, digests, API) is a separate private project;
`API.md` is the contract. Builds are hosted by that server at
`https://89-58-49-140.nip.io/mail/app/source.json` (add it in SideStore → Sources).
