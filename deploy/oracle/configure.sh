#!/usr/bin/env bash
# Installs this checkout's API service and Caddy site - run by setup.sh and
# update.sh, so the server's config always matches the repo. The site names
# come from /etc/caddy/mplads-hosts: one comma-separated line, e.g.
#     mplad-ecosystem.tech, www.mplad-ecosystem.tech, 34-93-125-27.sslip.io
# To add a domain, point its DNS here first, then edit that line and re-run:
#     bash deploy/oracle/configure.sh
set -euo pipefail

APP="$(cd "$(dirname "$0")/../.." && pwd)"
WEB_ROOT=/var/www/mplads
HOSTS_FILE=/etc/caddy/mplads-hosts
if [ ! -s "$HOSTS_FILE" ]; then
  echo "$HOSTS_FILE is missing - run deploy/oracle/setup.sh <host> first" >&2
  exit 1
fi
HOST="$(tr -d '\n' < "$HOSTS_FILE")"

sed "s#__APP__#$APP#g; s#__USER__#$(id -un)#g" "$APP/deploy/oracle/mplads-api.service" \
  | sudo tee /etc/systemd/system/mplads-api.service >/dev/null
sudo systemctl daemon-reload

# validated before it replaces the live site, so a bad edit can't take it down
sed "s#__HOST__#$HOST#g; s#__WEB_ROOT__#$WEB_ROOT#g" "$APP/deploy/oracle/Caddyfile" \
  | sudo tee /etc/caddy/Caddyfile.new >/dev/null
sudo caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile >/dev/null
sudo mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
sudo systemctl reload caddy
echo "configured: API service + Caddy site for $HOST"
