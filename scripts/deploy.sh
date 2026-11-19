#!/usr/bin/env bash
# Deploy icloud-mcp to Cloud Run from source. Safe to re-run: it creates
# whatever is missing (URL secret, runtime service account, secret access)
# and rolls out a new revision.
#
#   npm run deploy
#   READ_ONLY=true npm run deploy                 # hide every tool that writes
#   DEFAULT_TIMEZONE=Europe/London npm run deploy
set -euo pipefail

PROJECT="${PROJECT:-icloud-claude-mcp}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-icloud-mcp}"
TIMEZONE="${DEFAULT_TIMEZONE:-America/New_York}"
SA="$SERVICE@$PROJECT.iam.gserviceaccount.com"
cd "$(dirname "$0")/.."

g() { gcloud --project "$PROJECT" "$@"; }
has_secret() { g secrets describe "$1" >/dev/null 2>&1; }

for name in icloud-email icloud-app-password; do
  if ! has_secret "$name"; then
    echo "Secret $name is missing: run npm run store-credentials first." >&2
    exit 1
  fi
done

# The connector's only credential: 256 random bits, generated here and never printed.
if ! has_secret icloud-mcp-secret-path; then
  openssl rand -hex 32 | tr -d '\n' | g secrets create icloud-mcp-secret-path --replication-policy=automatic --data-file=- >/dev/null
  echo "Created secret icloud-mcp-secret-path"
fi

# A runtime identity that can read these secrets and nothing else.
if ! g iam service-accounts describe "$SA" >/dev/null 2>&1; then
  g iam service-accounts create "$SERVICE" --display-name="icloud-mcp Cloud Run" >/dev/null
  echo "Created service account $SA"
fi

SECRETS="SECRET_PATH=icloud-mcp-secret-path:latest,ICLOUD_EMAIL=icloud-email:latest,ICLOUD_APP_PASSWORD=icloud-app-password:latest"
NAMES="icloud-mcp-secret-path icloud-email icloud-app-password"
if has_secret icloud-apple-id; then SECRETS="$SECRETS,ICLOUD_APPLE_ID=icloud-apple-id:latest"; NAMES="$NAMES icloud-apple-id"; fi
if has_secret icloud-from; then SECRETS="$SECRETS,ICLOUD_FROM=icloud-from:latest"; NAMES="$NAMES icloud-from"; fi
for name in $NAMES; do
  g secrets add-iam-policy-binding "$name" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor >/dev/null
done

ENV_VARS="DEFAULT_TIMEZONE=$TIMEZONE"
if [[ "${READ_ONLY:-}" =~ ^(1|true|yes|on)$ ]]; then ENV_VARS="$ENV_VARS,READ_ONLY=true"; fi

g run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$SA" \
  --allow-unauthenticated \
  --min-instances=0 --max-instances=2 \
  --cpu=1 --memory=512Mi --timeout=300 \
  --set-secrets="$SECRETS" \
  --set-env-vars="$ENV_VARS" \
  --quiet

URL=$(g run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
echo
echo "Deployed: $URL"
echo "Connector URL is $URL/<SECRET>/mcp. Print the secret with:"
echo "  gcloud secrets versions access latest --secret=icloud-mcp-secret-path --project $PROJECT"
