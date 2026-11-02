# Deploying on the Intel server with Cloudflare

## On the KL University K3s platform (how it runs today)

The portal runs on the K3s cluster (master 10.5.1.5, apps node 10.5.1.6, db node 10.5.1.7) like the other KL apps,
published at **https://exam.klfacultyhiring.com** through the existing `klu-cluster` Cloudflare Tunnel.

| Piece | Where |
|---|---|
| Container image | `deploy/docker/app.Dockerfile` → `ghcr.io/satish5813/klquiz` (built by `.github/workflows/k8s.yml`) |
| Kubernetes | `deploy/klquiz/base` (app, 5 GiB SQLite volume, ingress, network policies), `overlays/staging`, `overlays/prod` |
| Flux | `deploy/clusters/klu/klquiz-*.yaml` (applied once by hand) |
| Tunnel route | `aihr_pilot/deploy/platform/cloudflared.yaml` (hostname `exam.klfacultyhiring.com` → Traefik) |
| Secrets (on the cluster only) | `klquiz-env` (JWT_SECRET, APP_SECRET, ADMIN_USER, ADMIN_PASSWORD, GEMINI_API_KEY, GEMINI_MODEL), `klquiz-backup-key` (the image is public; no pull secret) |
| Backups | nightly 03:35 IST, encrypted, `master:/home/test/kl-backups/klquiz-prod`; restore test first Sunday 05:25 |

**Release flow:** push to `main` → CI tests, builds, smoke-tests, scans, pushes the image → staging updates automatically
(private: `kubectl -n klquiz-staging port-forward deploy/app 8080:8080`). To release to production:

```bash
git tag v1.0.1 && git push origin v1.0.1     # re-tags the tested image; Flux rolls production
```

SQLite runs as a single replica, so a release restarts the portal for a few seconds — **never release during a live exam**.
Everyday commands (on the master, `ssh -p 985 test@10.5.1.5`, then `export KUBECONFIG=~/.kube/config`):

```bash
kubectl -n klquiz-prod get pods
kubectl -n klquiz-prod logs deploy/app
kubectl -n klquiz-prod create job --from=cronjob/klquiz-backup klquiz-backup-now   # backup on demand
```

The rest of this guide covers running it **outside** the cluster (a single server with systemd).

---

```
Students / admins ──HTTPS──▶ Cloudflare (DNS, TLS, WAF, Access) ──Tunnel──▶ Intel server: Node.js app :3000 ──▶ SQLite (data/klquiz.db)
```

- **The Intel server runs the app.** It is a Node.js process with a SQLite database file, so it needs a machine
  with a persistent process and disk. Cloudflare Workers/Pages cannot run it without a rewrite.
- **Cloudflare sits in front.** It provides the domain, HTTPS certificate, DDoS/WAF protection and — through
  **Cloudflare Tunnel** — a secure path to the server with **no inbound ports opened** on the university network.
- Outbound HTTPS from the server must be allowed (Cloudflare Tunnel and the Gemini API).

The steps below are for **Ubuntu 22.04/24.04** (the usual choice on Intel Xeon servers). Windows Server notes are at the end.

---

## 1. Prepare the server

```bash
# Node.js 22 LTS (22.13+ is required for the built-in SQLite driver)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v

# Dedicated, unprivileged user and folders
sudo useradd --system --home /opt/klquiz --shell /usr/sbin/nologin klquiz
sudo mkdir -p /opt/klquiz /var/backups/klquiz
sudo chown klquiz:klquiz /opt/klquiz /var/backups/klquiz
sudo chmod 750 /var/backups/klquiz
```

## 2. Install the application

```bash
sudo -u klquiz git clone https://github.com/satish5813/KLQUIZ.git /opt/klquiz
cd /opt/klquiz
sudo -u klquiz npm ci --omit=dev
sudo -u klquiz mkdir -p data
```

**Bring your data** — choose one:

- **Full data (recommended)**: copy `data/klquiz.db` and `.env` from the backup zip (`KLStudentQuizAPP-*.zip`)
  into `/opt/klquiz/data/klquiz.db` and `/opt/klquiz/.env`. Same admin password, Gemini key, tests and questions.
- **Question bank only**: `sudo -u klquiz cp backups/klquiz-backup.db data/klquiz.db` and create a new `.env`
  from `.env.example` (generate secrets with `openssl rand -base64 48`).

Then edit `/opt/klquiz/.env` for production:

```ini
NODE_ENV=production
SECURE_COOKIES=true
TRUST_PROXY=1
HOST=127.0.0.1
PORT=3000
```

```bash
sudo chown klquiz:klquiz /opt/klquiz/.env /opt/klquiz/data/klquiz.db
sudo chmod 600 /opt/klquiz/.env
```

`HOST=127.0.0.1` means the app is reachable **only through the tunnel** — nobody can bypass Cloudflare.

## 3. Run it as a service

```bash
sudo cp /opt/klquiz/deploy/klquiz.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now klquiz
sudo systemctl status klquiz          # should be "active (running)"
curl -s http://127.0.0.1:3000/api/health   # {"ok":true,...}
journalctl -u klquiz -f               # live logs
```

The service restarts automatically on crash or reboot and shuts down cleanly (no half-written database).

## 4. Publish through Cloudflare Tunnel

Your domain must be on Cloudflare (DNS managed by Cloudflare).

```bash
# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

cloudflared tunnel login                     # opens a browser link: choose your domain
cloudflared tunnel create klquiz             # prints the TUNNEL-ID and writes ~/.cloudflared/<TUNNEL-ID>.json
cloudflared tunnel route dns klquiz exam.your-domain.in

sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<TUNNEL-ID>.json /etc/cloudflared/
sudo cp /opt/klquiz/deploy/cloudflared-config.yml /etc/cloudflared/config.yml
sudo nano /etc/cloudflared/config.yml        # put in the TUNNEL-ID and your hostname
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Open `https://exam.your-domain.in` (students) and `https://exam.your-domain.in/admin/` (admin).

(Alternative: create the tunnel in the Cloudflare **Zero Trust dashboard → Networks → Tunnels**, which gives a
single `cloudflared service install <token>` command; add a public hostname pointing to `http://127.0.0.1:3000`.)

## 5. Cloudflare settings — important

In the Cloudflare dashboard for your domain:

| Setting | Value | Why |
|---|---|---|
| SSL/TLS → mode | **Full** | HTTPS end to end through the tunnel |
| SSL/TLS → Always Use HTTPS | **On** | Cookies are `Secure`; plain HTTP would break login |
| Speed → **Rocket Loader** | **Off** | It rewrites `<script>` tags; the strict Content-Security-Policy blocks that and the exam page breaks |
| Scrape Shield → **Email Address Obfuscation** | **Off** | Injects a script into pages (blocked by CSP) |
| Security → **Bot Fight Mode** | **Off** (or skip rule for `/api/student/*`) | A bot challenge on autosave requests would interrupt candidates mid-exam |
| Security level | Medium; never "I'm Under Attack" during an exam | Same reason |
| Caching | Default | API responses are sent with `Cache-Control: no-store` |

**Protect the admin portal with Cloudflare Access (strongly recommended).**
Zero Trust → Access → Applications → *Self-hosted*: add **two** paths on your hostname — `/admin` and `/api/admin` —
with a policy like *Emails ending in `@kluniversity.in`* (or a list of named examiners). Admins then sign in with
their university email before they even reach the admin login page. Do **not** put `/` or `/api/student` behind Access.

## 6. Backups

```bash
# Nightly full backup at 02:30, keeps 14 days (includes student data — this folder is private)
sudo crontab -u klquiz -e
30 2 * * * cd /opt/klquiz && /usr/bin/node scripts/backup-full.js /var/backups/klquiz >> /var/backups/klquiz/backup.log 2>&1
```

Copy `/var/backups/klquiz` off the server regularly (another machine or storage). Restore = stop the service,
copy a backup to `/opt/klquiz/data/klquiz.db`, delete `klquiz.db-wal`/`-shm`, start the service.

`node scripts/backup-db.js` makes the *publishable* snapshot (no admin hashes, pass keys or student data) used in GitHub.

## 7. Updating

```bash
cd /opt/klquiz
sudo -u klquiz node scripts/backup-full.js /var/backups/klquiz
sudo -u klquiz git pull
sudo -u klquiz npm ci --omit=dev
sudo systemctl restart klquiz
```

`git pull` never touches `data/` or `.env` (both are git-ignored). Don't update during a live exam.

## Exam-day checklist

- [ ] `curl https://exam.your-domain.in/api/health` returns `{"ok":true}`
- [ ] Test is scheduled, pass key generated, status **live**
- [ ] One dry-run registration from an exam-hall computer
- [ ] Cloudflare: Rocket Loader / Bot Fight Mode off, not in "Under Attack" mode
- [ ] Fresh full backup taken before the exam; another right after

**Capacity.** One Node.js process with SQLite (WAL mode) comfortably handles a few hundred candidates writing at once
on a modern Intel server; each answer is a tiny write. For very large sittings, run a timed rehearsal with your
expected number of students first.

---

## Windows Server instead of Linux

1. Install Node.js 22 LTS and Git, then `git clone https://github.com/satish5813/KLQUIZ.git C:\klquiz`, `cd C:\klquiz`, `npm ci --omit=dev`.
2. Put `data\klquiz.db` and `.env` in place (same settings as step 2).
3. Run as a service with [NSSM](https://nssm.cc): `nssm install KLQuiz "C:\Program Files\nodejs\node.exe" server\index.js`,
   set *Startup directory* to `C:\klquiz`, then `nssm start KLQuiz`.
4. Install cloudflared for Windows and use the Zero Trust dashboard token method: `cloudflared.exe service install <token>`.
5. Task Scheduler: run `node scripts\backup-full.js D:\klquiz-backups` nightly.
