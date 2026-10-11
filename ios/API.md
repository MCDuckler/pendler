# Mail Coach API

Base URL: `https://89-58-49-140.nip.io/mail` (Caddy → mailcoach on the WetOwl box).
Every `/api/*` call needs `Authorization: Bearer <token>`. Times are ISO 8601 with offset;
dates (`due`) are `YYYY-MM-DD`. Errors: `{"error": "..."}` with a 4xx/5xx status.

## Pairing

The server prints `mailcoach://pair?url=<base, percent-encoded>&token=<token>`.
Opening it on the phone stores both (app + widget).

## Items

An *item* is one conversation (thread) that still needs something from you.

```json
{
  "id": "t_3f2a…",               // thread id, stable
  "category": "reply",           // reply | todo | deadline | waiting | fyi
  "title": "Answer Prof. Keller about the thesis slot",
  "summary": "Keller offers 14 Oct or 21 Oct for the kickoff and asks which works.",
  "due": "2026-10-03",           // or null
  "urgency": 2,                  // 0 low … 3 urgent
  "from": "Prof. Dr. Anna Keller",
  "from_addr": "anna.keller@hs-pforzheim.de",
  "subject": "Re: Bachelorarbeit Kickoff",
  "last_at": "2026-09-30T09:12:00+02:00",
  "message_count": 3,
  "state": "open",               // open | done | snoozed | ignored | gone
  "snoozed_until": null,
  "is_new": true,                // arrived/changed since the last digest
  "webmail_url": "https://webmail.hs-pforzheim.de/owa/"
}
```

Ordering everywhere: overdue/soonest `due` first, then urgency desc, then `last_at` desc.

### `GET /api/summary`
```json
{
  "generated_at": "…",
  "last_sync": "…",               // last successful IMAP sync
  "counts": {"reply": 3, "todo": 2, "deadline": 1, "waiting": 4, "fyi": 6, "open": 6},
  "next_deadline": { item } | null,
  "digest": {"id": 12, "kind": "morning", "created_at": "…", "title": "…", "body": "…"} | null,
  "items": [ item, … ]            // state=open, categories reply/todo/deadline/waiting/fyi
}
```
`counts.open` = reply + todo + deadline (the "needs you" number shown on badge/widget).

### `GET /api/widget`
Compact version for WidgetKit: `{"generated_at", "last_sync", "counts", "next_deadline", "top": [item ×6]}`
(`top` = needs-you items only, i.e. reply/todo/deadline).

### `GET /api/items?state=open|done|snoozed|ignored|all&category=reply`
`{"items": [item, …]}` — `state` defaults to `open`. `done` returns last 100 closed.

### `GET /api/threads/{id}`
```json
{
  "item": { item },
  "messages": [
    {"id": 51, "from": "…", "from_addr": "…", "to": ["…"], "cc": ["…"], "date": "…",
     "mine": false, "subject": "…", "body": "plain text, quotes trimmed",
     "attachments": ["Anmeldung.pdf"]}
  ]
}
```
Messages oldest first.

### `POST /api/threads/{id}/action`
Body `{"action": "done" | "reopen" | "ignore" | "snooze", "until": "2026-10-01T08:00:00+02:00"}`
(`until` only for snooze). Returns `{"item": item}`. `ignore` = never surface this thread again.

### `POST /api/refresh`
Kicks an IMAP sync + triage now. Returns `{"started": true}` immediately.

### `GET /api/digests?limit=10`
`{"digests": [digest, …]}` newest first.

## App distribution (no auth)
- `GET /app/source.json` — SideStore/AltStore source
- `GET /app/latest.json` — `{version, build, bytes, built, url, notes}` (build = UTC `YYYYMMDDHHMM`)
- `GET /app/MailCoach.ipa`
