#!/usr/bin/env bash
# Redeploy the latest code on the server: bash deploy/oracle/update.sh
# (data/ is left as it is - comments, statuses and reports live there.)
set -euo pipefail

APP="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$HOME/.local/bin:$PATH"

cd "$APP"
git pull --ff-only
uv pip install --python .venv -r requirements.txt

cd web
npm ci --no-audit --no-fund
npm run build
sudo rsync -a --delete dist/ /var/www/mplads/

# re-apply the service and Caddy site from the repo, then restart the API
bash "$APP/deploy/oracle/configure.sh"
sudo systemctl restart mplads-api
echo "Redeployed. The API takes 30-60 s to load its data again."
