#!/usr/bin/env bash
# One-time setup of a fresh Oracle Cloud Ubuntu 24.04 (Ampere A1) server,
# run on the server from the cloned repo once data/ has been unpacked into it:
#
#     bash deploy/oracle/setup.sh <host>
#
# <host> is the public name Caddy gets an HTTPS certificate for - the
# server's IP with dashes plus .sslip.io (140-238-10-20.sslip.io), or your
# own domain pointed at the server. Safe to re-run.
set -euo pipefail

HOST="${1:?usage: bash deploy/oracle/setup.sh <host, e.g. 140-238-10-20.sslip.io>}"
APP="$(cd "$(dirname "$0")/../.." && pwd)"
WEB_ROOT=/var/www/mplads
export PATH="$HOME/.local/bin:$PATH"

if [ ! -f "$APP/data/processed/spine.parquet" ]; then
  echo "data/ is missing - unpack mplads-data.tgz into $APP first (see deploy/oracle/README.md)" >&2
  exit 1
fi

echo "== system packages"
sudo apt-get update -q
sudo DEBIAN_FRONTEND=noninteractive apt-get install -yq git rsync curl gnupg \
  debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

echo "== firewall: open 80 and 443 (Oracle's Ubuntu image rejects all but SSH)"
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    # insert above the image's catch-all REJECT, or first if it has none
    line=$(sudo iptables -L INPUT --line-numbers | awk '$2 == "REJECT" { print $1; exit }')
    sudo iptables -I INPUT "${line:-1}" -p tcp --dport "$port" -m state --state NEW -j ACCEPT
  fi
done
sudo netfilter-persistent save

echo "== Node 22 (Ubuntu's own nodejs is too old for Vite)"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -yq nodejs
fi

echo "== Python 3.14 environment (uv), pinned to the tested versions"
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
cd "$APP"
[ -d .venv ] || uv venv --python 3.14 .venv
uv pip install --python .venv -r requirements.txt

if [ ! -f .env ]; then
  echo "== .env with a fresh AUTH_SECRET"
  printf 'AUTH_SECRET=%s\nOPENROUTER_API_KEY=\n' "$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')" > .env
  chmod 600 .env
fi

echo "== API service"
sed "s#__APP__#$APP#g; s#__USER__#$(id -un)#g" deploy/oracle/mplads-api.service \
  | sudo tee /etc/systemd/system/mplads-api.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable mplads-api
sudo systemctl restart mplads-api

echo "== frontend build"
cd "$APP/web"
npm ci --no-audit --no-fund
npm run build
sudo mkdir -p "$WEB_ROOT"
sudo rsync -a --delete dist/ "$WEB_ROOT/"

echo "== Caddy (HTTPS + routing)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -q
  sudo apt-get install -yq caddy
fi
sed "s#__HOST__#$HOST#g; s#__WEB_ROOT__#$WEB_ROOT#g" "$APP/deploy/oracle/Caddyfile" \
  | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo systemctl reload caddy || sudo systemctl restart caddy

echo "== waiting for the API to load its data (30-60 s)"
code=000
for _ in $(seq 1 90); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/api/meta || true)
  [ "$code" = 401 ] && break
  sleep 2
done
if [ "$code" = 401 ]; then
  echo "API is up (401 = running and requiring sign-in)."
else
  echo "API not answering yet (got $code) - check: journalctl -u mplads-api -n 50" >&2
fi
echo "Done: https://$HOST  (first HTTPS request can take a few seconds while Caddy gets the certificate)"
