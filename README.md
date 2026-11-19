# icloud-mcp

A single-user MCP server that gives Claude your **iCloud Mail** and **iCloud Calendar**, running on Cloud Run as a claude.ai custom connector — so it works from claude.ai on the web, the desktop app, the iPhone app, and Claude Code, with no computer of yours switched on.

- **Mail over IMAP and SMTP** — search, read, draft, send, reply, mark, move
- **Calendar over CalDAV** — list calendars, list and read events with recurring series expanded, create, change and delete events, including one instance of a series
- **MCP over Streamable HTTP** — stateless JSON, so Cloud Run can scale to zero between requests
- **No OAuth, no database** — iCloud has no OAuth for mail or calendars; the server logs in with an app-specific password kept in Secret Manager, and keeps no state of its own

iCloud speaks standard protocols for both: IMAP at `imap.mail.me.com:993`, SMTP at `smtp.mail.me.com:587`, CalDAV at `caldav.icloud.com`.

## Access model — read before deploying

There is no login on the MCP endpoint. Every route lives under a 256-bit secret path segment: `https://<service-url>/<SECRET>/mcp`. Whoever holds that URL can read your mail, send mail as you, and change your calendar, so treat it like a password: it goes into claude.ai's connector settings and nowhere else. Rotate it by adding a new secret version and redeploying.

Only `/status` sits outside it, and returns nothing but a liveness flag. (Not `/healthz`: Cloud Run's front end reserves that path and answers it with its own 404 before the request reaches the container; the server still serves `/healthz` for local runs.) `/<SECRET>/health` logs in to IMAP, SMTP and CalDAV and reports each.

The iCloud side is an [app-specific password](https://support.apple.com/en-us/102654), which works only for third-party mail, calendar and contacts access — not for signing in to your Apple account — and can be revoked on its own at any time without touching your Apple ID password.

Cloud Run's own IAM authentication can't be used: claude.ai speaks plain HTTPS and can't sign Google IAM requests, hence `--allow-unauthenticated` plus the secret path.

## Set up (≈10 minutes)

Prereqs: Node 24+, the [gcloud CLI](https://cloud.google.com/sdk/docs/install) logged in (`gcloud auth login`), and a Google Cloud project with billing and these APIs enabled:

```bash
gcloud services enable run.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com --project icloud-claude-mcp
```

The scripts default to project `icloud-claude-mcp` in `us-central1`; set `PROJECT=` / `REGION=` to use others.

1. **Create an app-specific password**: [account.apple.com](https://account.apple.com) → Sign-In and Security → App-Specific Passwords → `+`. Name it after the connector. Apple shows it once, as `xxxx-xxxx-xxxx-xxxx`.

2. **Store the login in Secret Manager**, in your own terminal:

   ```bash
   npm install && npm run build
   npm run store-credentials
   ```

   It asks for your iCloud Mail address, your Apple ID if that is a different address, a display name for outgoing mail, and the password (hidden). It checks all three logins against iCloud before storing anything; the password never touches disk, shell history or a process list.

3. **Deploy**:

   ```bash
   npm run deploy
   ```

   On first run this also creates the URL secret (`icloud-mcp-secret-path`, never printed) and a runtime service account that can read these secrets and nothing else. Re-run it to roll out changes. Options: `DEFAULT_TIMEZONE=Europe/London npm run deploy`, `READ_ONLY=true npm run deploy`.

4. **Connect Claude**: claude.ai → **Settings → Connectors → Add custom connector**, URL:

   ```
   https://<service-url>/<SECRET>/mcp
   ```

   `npm run deploy` prints the service URL; print the secret with `gcloud secrets versions access latest --secret=icloud-mcp-secret-path --project icloud-claude-mcp`. Leave the OAuth fields empty — the secret path is the auth.

   In the connector's settings, consider setting the write tools to **Needs approval**, so Claude asks before it sends mail or changes your calendar. Then try: *"Use icloud_connection_status, then summarize my unread mail and what's on my calendar this week."*

Connectors added on claude.ai also show up in Claude Code when it is signed in with the same account.

## Tools

| Tool | What it does |
| --- | --- |
| `icloud_connection_status` | Checks the IMAP, SMTP and CalDAV logins; shows account, time zone, write mode |
| `icloud_mail_list_folders` | Folders with message and unread counts, and their roles (inbox, sent, drafts, archive, junk, trash) |
| `icloud_mail_search` | Searches one folder: text, from, to, subject, date range, unread, flagged; newest first, with snippets |
| `icloud_mail_get_message` | Headers, plain-text body (HTML converted), attachment list |
| `icloud_mail_send` | Sends mail, or a reply with threading and the original quoted; files a copy in Sent |
| `icloud_mail_create_draft` | Saves a message or reply to Drafts, to review and send from Apple Mail |
| `icloud_mail_mark` | Read/unread, flagged/unflagged |
| `icloud_mail_move` | Moves to archive, trash, junk or any folder |
| `icloud_calendar_list_calendars` | Calendars with ids, colors, write access, and the default for new events |
| `icloud_calendar_list_events` | Events in a range across calendars, recurring series expanded |
| `icloud_calendar_get_event` | One event in full: notes, repeat rule, exceptions, alerts, attendees and their responses |
| `icloud_calendar_create_event` | Timed or all-day events, with alerts, repeat rules and invitations |
| `icloud_calendar_update_event` | Changes a whole event or series, or just one occurrence |
| `icloud_calendar_delete_event` | Deletes an event or series, or just one occurrence |

With `READ_ONLY=true` only the first seven read tools exist; nothing can send or change anything.

## How it behaves

- **Times** come back as ISO 8601 with an offset (`2026-11-20T15:00:00-05:00`), in `DEFAULT_TIMEZONE` unless a call asks for another zone. Wall-clock arguments (`2026-11-20T15:00`) are read in that zone; arguments with an offset mean exactly that instant. New events are stored with a `TZID` and a full `VTIMEZONE`, so they show at the right time on every device and stay put across DST changes.
- **All-day events** use dates, and their `end` is the last day, inclusive — a one-day event ends on its start date. (iCalendar stores the day after; the server converts both ways.)
- **Recurring events** are expanded into occurrences in `list_events`, with excluded dates, moved instances and cancelled instances applied. Each occurrence carries an `occurrence` value (its original start); pass it with the `event_id` to change or delete only that instance — the server writes a `RECURRENCE-ID` override or an `EXDATE`, as Apple Calendar does.
- **Writes are conditional**: an event is saved with the ETag it was read with, so a change made on your phone in the meantime is never silently overwritten; the update is re-read and re-applied once.
- **Invitations**: adding attendees makes iCloud email each one an invitation from your account, and changes or deletions send updates.
- **Mail UIDs belong to a folder** and change when a message moves; tools return the folder with every uid, and `move` returns the new uids.
- **Reading never marks mail as read** — fetches use `BODY.PEEK` and folders are opened read-only.
- **Replies** go to Reply-To or From; replying to your own message goes to its recipients; reply-all copies everyone else but never you. The original is quoted under your text with Apple Mail's attribution line, and the original is flagged as answered.
- **Drafts** carry the header Apple Mail uses to recognize its own drafts, so they open for editing in Mail on any device.
- **Untrusted content**: the server's instructions tell the model that email bodies and event notes are written by other people and are information, not instructions.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `SECRET_PATH` | yes | URL secret: `openssl rand -hex 32` |
| `ICLOUD_EMAIL` | yes | iCloud Mail address: IMAP/SMTP login and default From |
| `ICLOUD_APP_PASSWORD` | yes | App-specific password |
| `ICLOUD_APPLE_ID` | no | CalDAV login, if your Apple ID is a different address (iCloud accepts the iCloud address too) |
| `ICLOUD_FROM` | no | From header, e.g. `Jane Doe <jane@icloud.com>`; must be your address or one of its aliases |
| `DEFAULT_TIMEZONE` | no | IANA zone, default `UTC` (the deploy script sets `America/New_York`) |
| `READ_ONLY` | no | `true` hides every tool that writes |

On Cloud Run the first five come from Secret Manager (`icloud-mcp-secret-path`, `icloud-email`, `icloud-app-password`, `icloud-apple-id`, `icloud-from`).

## Local development

```bash
npm install
npm run check      # typecheck
npm test           # 54 tests: the HTTP server end to end, iCalendar expansion and editing, CalDAV over a stubbed fetch, mail helpers
```

To run against your real account, with the credentials straight from Secret Manager:

```bash
npm run build
P=icloud-claude-mcp; s() { gcloud secrets versions access latest --secret=$1 --project $P; }
SECRET_PATH=dev ICLOUD_EMAIL=$(s icloud-email) ICLOUD_APP_PASSWORD=$(s icloud-app-password) \
  DEFAULT_TIMEZONE=America/New_York npm start
# then: curl localhost:8080/dev/health
```

For Claude Desktop or Claude Code without Cloud Run, point an MCP client at `http://localhost:8080/dev/mcp` (Claude Code: `claude mcp add --transport http icloud http://localhost:8080/dev/mcp`).

## Operations

- **Logs**: `gcloud run services logs tail icloud-mcp --region us-central1 --project icloud-claude-mcp`. The service logs method, redacted path (`:secret` or `:bad-secret`), status, and the name and outcome of each tool call — never the secret, arguments, or mail and calendar content. Cloud Run's own platform request log is separate and does record the full request URL, secret included, so anyone with Logs Viewer on the project can read it; a secret you mistype into a URL bar is logged too. Rotate if that happens.
- **Rotate the URL secret**: `openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add icloud-mcp-secret-path --data-file=- --project icloud-claude-mcp`, `npm run deploy`, then update the connector URL in claude.ai.
- **Revoke iCloud access**: delete the app-specific password at account.apple.com — every login stops at once. For a new one, run `npm run store-credentials` and `npm run deploy`.
- **Cost**: $0 within Cloud Run's free tier with `min-instances=0`. The one thing that accumulates is old container images in Artifact Registry; set a cleanup policy or prune now and then.
- **Cold start**: 1–3 s after idle, plus about a second per tool call for the IMAP login — each call opens its own connection, since Cloud Run throttles an idle instance's CPU and a pooled connection would time out half-open.

## Limits

- Mail is plain text only: no HTML composing, and attachments are listed but not downloaded or sent.
- Search covers one folder per call (the inbox by default), using the server's IMAP `SEARCH`.
- Reminders and Contacts are not included. Apple moved Reminders off CalDAV in iOS 13, so only old-style task lists are visible there; they are left out.
- Changing the start of a whole recurring series does not move instances that were already edited individually; Apple Calendar asks about those, this server leaves them where they are.

Personal project; not affiliated with or endorsed by Apple, Google or Anthropic.
