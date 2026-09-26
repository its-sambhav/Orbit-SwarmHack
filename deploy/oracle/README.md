# Deploying on Oracle Cloud (Always Free)

One Ampere A1 server runs everything: Caddy serves the built frontend over
HTTPS and forwards `/api` to the API. The server gets the whole project: the
code and source CSVs from git (with Git LFS), and the complete `data/` folder
- built on your own machine, not in git - copied up as it is.

The API holds about 4 GB of RAM once loaded, which is why this needs the A1
shape rather than any 1 GB free server.

## 1. Create the server (Oracle console)

1. Sign up for Oracle Cloud Free Tier. Pick a home region with A1 capacity
   (Mumbai or Hyderabad) - it can't be changed, and free resources exist
   only there.
2. **Compute → Instances → Create instance**
   - Image: **Canonical Ubuntu 24.04**
   - Shape: **VM.Standard.A1.Flex, 2 OCPU / 12 GB**. Not the full 24 GB:
     Oracle reclaims an Always Free A1 server whose CPU, network *and*
     memory all stay under 20% for 7 days, and ~4 GB is under 20% of 24 GB.
   - Keep "Assign a public IPv4 address" on; download the SSH private key.
   - Boot volume: 100 GB.
   - "Out of capacity": try another availability domain, retry later, or
     upgrade the account to Pay-As-You-Go (still free within the limits).
3. **Networking → the instance's subnet → Security List → Add Ingress Rules**:
   source `0.0.0.0/0`, TCP, destination port `80`; the same for `443`.

Your HTTPS address is the public IP with dashes plus `.sslip.io`
(`140.238.10.20` → `140-238-10-20.sslip.io`), or your own domain with an A
record pointing at the IP.

## 2. Copy the data up (from your machine, PowerShell)

```powershell
cd <project folder>
tar -czf $env:TEMP\mplads-data.tgz data
scp -i C:\path\to\ssh-key.key $env:TEMP\mplads-data.tgz ubuntu@<PUBLIC_IP>:~/
```

If ssh rejects the key as unprotected:
`icacls C:\path\to\ssh-key.key /inheritance:r /grant:r "$($env:USERNAME):R"`

## 3. Set up the server

Connect from PowerShell with `ssh -i C:\path\to\ssh-key.key ubuntu@<PUBLIC_IP>`, then on the server:

```bash
sudo apt-get update && sudo apt-get install -y git-lfs && git lfs install
git clone https://github.com/its-sambhav/Orbit-SwarmHack.git ~/app
tar -xzf ~/mplads-data.tgz -C ~/app && rm ~/mplads-data.tgz
bash ~/app/deploy/oracle/setup.sh <HOST>
```

`setup.sh` opens ports 80/443 in the server's own firewall, locks SSH to key
sign-in with fail2ban banning repeated failures, turns on automatic security
updates, installs Node 22, Python 3.14 (via uv) with the pinned requirements
and Caddy, writes `.env` with a fresh `AUTH_SECRET`, builds the frontend, and
hands the rest to `configure.sh`: the sandboxed `mplads-api` service and the
Caddy site for `<HOST>` (HTTPS, security headers). It is safe to re-run, and
works the same on Google Cloud and AWS Ubuntu 24.04 servers.

For the written case-file narrative and data translation, add an OpenRouter
key to `~/app/.env` (`OPENROUTER_API_KEY=...`), then
`sudo systemctl restart mplads-api`. Set a credit limit on that key: the
sign-in page lists the demo passwords, so anyone can use those features.

## 4. Check it

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<HOST>/           # 200
curl -s -o /dev/null -w "%{http_code}\n" https://<HOST>/api/meta   # 401 - sign-in required
```

Logs: `journalctl -u mplads-api -f` (API), `journalctl -u caddy -f` (HTTPS).

## Updating

```bash
bash ~/app/deploy/oracle/update.sh
```

It pulls the code, rebuilds the frontend and re-applies the service and Caddy
site from the repo (`configure.sh`), so config changes deploy with the code.

## Adding a domain

Point the domain's A records (`@` and `www`) at the server first, wait until
`nslookup yourname.tech` shows its IP, then add the names to the one-line list
of site names and re-apply:

```bash
echo "yourname.tech, www.yourname.tech, <ip-with-dashes>.sslip.io" | sudo tee /etc/caddy/mplads-hosts
bash ~/app/deploy/oracle/configure.sh
```

Adding a name before its DNS points here makes Let's Encrypt refuse it for a
while, so DNS first.

## Security in place

- HTTPS only (Let's Encrypt, renewed by Caddy; HSTS), a strict
  Content-Security-Policy, no MIME sniffing or framing, no server banner.
- Only ports 22, 80 and 443 answer; the API listens on 127.0.0.1 only, and
  Caddy forwards just `/api` and `/static` to it (`/docs` stays private).
- The API runs sandboxed (systemd): read-only system, writes only in `data/`,
  no privilege gain; uploads are capped at 25 MB at the edge.
- The app itself: every API route needs a signed-in token and scopes data to
  the caller's own role; five wrong passwords lock a role for 5 minutes per
  visitor; the endpoints that call the paid LLM API are rate-limited per
  visitor.
- SSH: keys only, no root login, fail2ban; automatic security updates.

## Good to know

- After a restart the API needs 30-60 s to load; until then the pages say the
  server is restarting (Caddy answers the API's calls with a 503).
- Comments, attachments, finding statuses and reports are saved in
  `~/app/data/` on this server - back that folder up now and then.
- Don't set `AUTH_PASSWORD_<ROLE>` while the sign-in page shows the demo
  passwords, or the page will list the wrong ones. When the demo table goes
  (`VITE_HIDE_DEMO_CREDENTIALS=true` in `web/.env.production`), set real
  ones as `AUTH_PASSWORD_<ROLE>=...` in `~/app/.env`.
