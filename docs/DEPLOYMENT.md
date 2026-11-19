# Running the dashboard on a server

How to run the QA dashboard on a Linux server (a VM or a cloud machine) so you can open it from any browser, over HTTPS, behind a password. There are two ways: **Docker** (recommended) or **directly with Node** as a system service.

What you need:
- A Linux server with ports 80 and 443 open to you (or to everyone; the dashboard has a login).
- A domain name (e.g. `qa.example.com`) whose DNS points at the server. HTTPS certificates are fetched and renewed automatically.
- Your Anthropic API key, if you want AI runs.

## 1. With Docker (recommended)

Install Docker with the Compose plugin ([docs.docker.com/engine/install](https://docs.docker.com/engine/install/)), then:

```bash
git clone https://github.com/Atish93/postman-api-automation.git
cd postman-api-automation
cp .env.example .env
nano .env            # set DOMAIN, and ANTHROPIC_API_KEY for AI runs
chmod 600 .env
docker compose --profile https up -d --build
```

This starts two containers:
- **qa**: the dashboard (web app, API server and the agents), listening only inside the server.
- **caddy**: the web server in front of it. It gets the HTTPS certificate for your domain and forwards requests to the dashboard.

Open `https://<your domain>`. The first visit asks you to **set the password**, with a one-time setup code that only the server's log shows:

```bash
docker compose logs qa | grep -A2 "setup code"
```

Then, in the dashboard's Settings:
- Save your **Postman API key**.
- Under **Email**, set **Dashboard address** to `https://<your domain>`, so links in report emails point to the server.

**Without a domain** (trying it on a machine you're logged in to), leave out the profile: `docker compose up -d --build`, then open http://127.0.0.1:4000 on that machine. It isn't reachable from other machines in this mode.

### Where your data is

Everything worth keeping is in one Docker volume, `qa-data`, mounted at `/app/server/data`:
- `qa.db`: the database (collections, environments, runs, schedules, audit log).
- `secret.key`: the key that encrypts saved secrets.
- `backups/`: the database's backups.
- `runs/`: the agents' result files.
- `agent/`: what the agents learned (known issues and their search index).

### Everyday commands

```bash
docker compose logs -f qa                    # follow the log
docker compose exec qa npm run backup        # make a backup now
docker compose exec qa npm run reset-password   # forgot the password
docker compose restart qa
```

### Updating to a new version

```bash
docker compose exec qa npm run backup
git pull
docker compose --profile https up -d --build
```

The database is upgraded automatically when the new version starts.

### Copying backups off the server

The daily backups live on the same disk as the database. Copy them somewhere else now and then. Copy **`secret.key` separately**: backups don't include it on purpose, so a leaked backup alone exposes no secrets.

```bash
docker compose cp qa:/app/server/data/backups ./qa-backups
docker compose cp qa:/app/server/data/secret.key ./qa-secret.key   # keep this one somewhere safe
```

### Restoring a backup

```bash
docker compose stop qa
docker compose run --rm qa npm run restore -- data/backups/qa-20261119-020000-auto.db
docker compose start qa
```

## 2. Without Docker (Node as a system service)

On the server, as root:

```bash
apt-get install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
useradd --system --create-home --shell /usr/sbin/nologin qa
git clone https://github.com/Atish93/postman-api-automation.git /opt/postman-api-automation
cd /opt/postman-api-automation
(cd agent && npm ci) && (cd server && npm ci) && (cd web && npm ci && npm run build)
mkdir -p server/data && chown -R qa:qa server/data agent
```

Put settings in `/etc/qa-dashboard.env`: `ANTHROPIC_API_KEY=...` plus anything from `.env.example`. Then make it readable only by root with `chmod 600`.

```bash
cp deploy/qa-dashboard.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now qa-dashboard
journalctl -u qa-dashboard | grep -A2 "setup code"
```

For HTTPS, install [Caddy](https://caddyserver.com/docs/install) and put this in `/etc/caddy/Caddyfile` (with your domain), then `systemctl reload caddy`:

```
qa.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:4000 {
		flush_interval -1
	}
}
```

Commands such as `npm run backup` run in `/opt/postman-api-automation/server` as the qa user: `sudo -u qa npm run backup`.

## Security notes

- **The login.**
  - One password protects the dashboard. It's stored as a salted scrypt hash, never in plain text.
  - Sessions last 14 days from the last use. Changing the password logs out every other session.
  - Settings → Password and sessions shows where you're logged in.
- **Wrong passwords.** After 10 wrong passwords from one address, that address waits 15 minutes.
- **Requests from other sites.** Changes must come from the dashboard's own pages. Cookies are `HttpOnly` and `SameSite=Lax`, and `Secure` over HTTPS.
- **Browser headers.** A strict Content-Security-Policy, no framing (`X-Frame-Options: DENY`), and HSTS over HTTPS.
- **Secrets are encrypted at rest** (secret variables, the Postman key, the email password). Anyone with root on the server can still read them, as with any service that has to use them.
- **The audit log** (in the navigation) records:
  - logins and failed attempts;
  - settings and environment changes (which keys changed, never the values);
  - runs started and cancelled;
  - every AI approval you answered.

  Entries are kept for a year (`QA_AUDIT_DAYS`).
- **Behind a proxy.** Keep the dashboard's own port (4000) closed to the internet: only Caddy should reach it. Docker Compose binds it to `127.0.0.1`, and the systemd setup listens on `127.0.0.1` too. `QA_TRUST_PROXY=1` is set in both, so the dashboard believes the proxy's forwarded headers, and only the proxy can send them.

## Settings (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | | Needed for AI runs. |
| `PORT`, `HOST` | `4000`, `127.0.0.1` (`0.0.0.0` in Docker) | Where the server listens. |
| `QA_TRUST_PROXY` | off | `1` behind a reverse proxy (Caddy, nginx). |
| `QA_MAX_PARALLEL` | `2` | Runs at the same time, until set in Settings. |
| `QA_BACKUPS` | on | `off` turns the daily backup off. |
| `QA_BACKUP_KEEP` | `7` | Daily backups to keep. |
| `QA_BACKUP_DIR` | `data/backups` | Where backups go. |
| `QA_AUDIT_DAYS` | `365` | How long the audit log keeps entries. |
| `QA_SECRET_KEY` | (key file) | The encryption key as base64, instead of `data/secret.key`. |
| `QA_DB` | `data/qa.db` | The database file. |
