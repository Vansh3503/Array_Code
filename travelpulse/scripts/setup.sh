#!/usr/bin/env bash
# One-time Cloudflare setup for TravelPulse. Run from the travelpulse/ directory:
#   npm install && npx wrangler login && bash scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

gen() { openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 40; }

echo "==> Creating D1 database (skip if it exists)"
if ! grep -q '00000000-0000-0000-0000-000000000000' wrangler.toml; then
  echo "    database_id already set in wrangler.toml"
else
  out=$(npx wrangler d1 create travelpulse 2>&1 || true)
  echo "$out"
  id=$(echo "$out" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  if [ -z "$id" ]; then
    echo "!! Could not read database_id. Run 'npx wrangler d1 list' and paste the id into wrangler.toml."; exit 1
  fi
  sed -i.bak "s/00000000-0000-0000-0000-000000000000/$id/" wrangler.toml && rm -f wrangler.toml.bak
fi

echo "==> Applying migrations"
npx wrangler d1 migrations apply travelpulse --remote

DEVICE_TOKEN=$(gen); VIEW_TOKEN=$(gen); ADMIN_TOKEN=$(gen)
echo "==> Setting secrets"
printf '%s' "$DEVICE_TOKEN" | npx wrangler secret put DEVICE_TOKEN
printf '%s' "$VIEW_TOKEN"   | npx wrangler secret put VIEW_TOKENS
printf '%s' "$ADMIN_TOKEN"  | npx wrangler secret put ADMIN_TOKEN

read -rp "Recipients (e.g. Mom:+9198XXXXXXXX,Dad:+9198XXXXXXXX): " RECIPIENTS
printf '%s' "$RECIPIENTS" | npx wrangler secret put RECIPIENTS

read -rp "WhatsApp permanent access token (Enter to skip for now): " WA_TOKEN
if [ -n "$WA_TOKEN" ]; then
  printf '%s' "$WA_TOKEN" | npx wrangler secret put WHATSAPP_TOKEN
  read -rp "WhatsApp Phone number ID: " WA_PNID
  printf '%s' "$WA_PNID" | npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
fi

echo "==> Deploying"
npx wrangler deploy | tee /tmp/travelpulse-deploy.log
URL=$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' /tmp/travelpulse-deploy.log | head -1 || true)

cat <<EOF

================ SAVE THESE SOMEWHERE SAFE (password manager) ================
Worker URL:      ${URL:-<see deploy output>}
DEVICE_TOKEN:    $DEVICE_TOKEN      (goes into the iPhone Shortcut)
ADMIN_TOKEN:     $ADMIN_TOKEN       (admin API)
Dashboard link:  ${URL:-<url>}/v/$VIEW_TOKEN   (send this to Mom & Dad)
==============================================================================
Next:
 1. Set PUBLIC_BASE_URL in wrangler.toml to the Worker URL and run: npx wrangler deploy
 2. Build the iPhone Shortcut (docs/SHORTCUTS.md)
 3. Set up WhatsApp (docs/WHATSAPP.md), then set WHATSAPP_MODE = "template" and redeploy
EOF
