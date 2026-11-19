#!/usr/bin/env bash
# Store the iCloud login for icloud-mcp in Secret Manager.
#
# Run it yourself, in a terminal: the password is read without echo, checked
# against iCloud, and piped straight to gcloud. It never touches disk, shell
# history, or a process argument list.
set -euo pipefail

PROJECT="${PROJECT:-icloud-claude-mcp}"
cd "$(dirname "$0")/.."

echo "Storing iCloud credentials for icloud-mcp in project $PROJECT."
echo "Create the app-specific password first: account.apple.com > Sign-In and Security > App-Specific Passwords."
echo
read -rp "iCloud Mail address (name@icloud.com): " EMAIL
read -rp "Apple ID, only if different from that address (Enter to skip): " APPLE_ID
read -rp "Display name for mail you send (Enter to skip): " FROM_NAME
read -rsp "App-specific password (xxxx-xxxx-xxxx-xxxx, input hidden): " APP_PASSWORD
echo

if [[ ! "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  echo "\"$EMAIL\" is not an email address." >&2
  exit 1
fi
if [[ ! "$APP_PASSWORD" =~ ^[a-z]{4}-?[a-z]{4}-?[a-z]{4}-?[a-z]{4}$ ]]; then
  echo "Warning: that does not look like an app-specific password (four groups of four lowercase letters)." >&2
fi

if [[ -f dist/mail.js ]]; then
  echo "Checking the login against iCloud (IMAP, SMTP, CalDAV)..."
  if ICLOUD_EMAIL="$EMAIL" ICLOUD_APPLE_ID="${APPLE_ID:-$EMAIL}" ICLOUD_APP_PASSWORD="$APP_PASSWORD" node --input-type=module -e '
    import { ICloudMail } from "./dist/mail.js";
    import { CalDavClient } from "./dist/caldav.js";
    const env = process.env;
    const { imap, smtp } = await new ICloudMail({ user: env.ICLOUD_EMAIL, password: env.ICLOUD_APP_PASSWORD, from: env.ICLOUD_EMAIL, timeZone: "UTC" }).verify();
    let caldav = "ok";
    try {
      await new CalDavClient({ username: env.ICLOUD_APPLE_ID, password: env.ICLOUD_APP_PASSWORD }).listCalendars();
    } catch (err) {
      caldav = err.message;
    }
    console.log(`  IMAP:   ${imap}\n  SMTP:   ${smtp}\n  CalDAV: ${caldav}`);
    process.exit(imap === "ok" && smtp === "ok" && caldav === "ok" ? 0 : 1);
  '; then
    echo "All three logins work."
  else
    read -rp "Something failed (see above). Store these credentials anyway? [y/N] " ANSWER
    [[ "$ANSWER" =~ ^[Yy]$ ]] || exit 1
  fi
else
  echo "(dist/ not built: skipping the login check. Run npm run build to enable it.)"
fi

upsert() {
  local name=$1 value=$2
  if gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- --project "$PROJECT" >/dev/null
    echo "Updated secret $name"
  else
    printf '%s' "$value" | gcloud secrets create "$name" --replication-policy=automatic --data-file=- --project "$PROJECT" >/dev/null
    echo "Created secret $name"
  fi
}

upsert icloud-email "$EMAIL"
upsert icloud-app-password "$APP_PASSWORD"
if [[ -n "$APPLE_ID" ]]; then upsert icloud-apple-id "$APPLE_ID"; fi
if [[ -n "$FROM_NAME" ]]; then upsert icloud-from "$FROM_NAME <$EMAIL>"; fi
unset APP_PASSWORD

echo
echo "Done. Next: npm run deploy (or tell Claude the credentials are stored)."
