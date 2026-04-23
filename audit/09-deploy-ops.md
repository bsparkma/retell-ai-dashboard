# 09 — Deploy & ops

This file documents how the system actually gets deployed today, the gaps between what the repo says and what the production box does, and the operational risks attached to each path.

## 1. Production topology (as deployed today)

```
Internet
  │
  ├── Cloudflare DNS  ──►  cloudflared tunnel (`carein`)  ──►  http://localhost:5000   (carein-backend, PM2)
  │                                                                       │
  │                                                                       └─ Express + Socket.IO + sync schedulers
  │
  └── Direct (HTTP, port 80)  ──►  Nginx on droplet 159.89.82.167
                                       ├── /api/   ──►  http://localhost:5000   (same backend)
                                       └── /      ──►  /var/www/html (legacy frontend build)
```

Two ingress paths reach the same backend. One is TLS-terminated at Cloudflare; the other is plaintext HTTP on a public IP. See `audit/07-security.md` H-5.

## 2. Deploy artifacts in the repo

| File | Purpose | Status |
|---|---|---|
| `ecosystem.config.js` | PM2 app definitions for backend + new-dashboard | **Broken for new-dashboard** (see §3) |
| `nginx.conf` (root) | Production Nginx config for the droplet | Used in production |
| `frontend/nginx.conf` | Nginx config for the dockerized legacy frontend | Used only in Docker dev path |
| `cloudflared-config.yml` | Cloudflare tunnel ingress | Pinned to a Windows-style path (see §6) |
| `docker-compose.yml` | Backend + legacy frontend containers | Dev-only, never deployed to prod |
| `docker-compose.dev.yml` | Hot-reload dev stack | Dev-only |
| `backend/Dockerfile` | Production-ish Node container | Used only in compose, not by PM2 |
| `frontend/Dockerfile` | Multi-stage Nginx build for legacy frontend | Used only in compose |
| `setup.sh` | First-time install on a fresh box | Embeds a leaked API key (see §6) |

There is no Dockerfile for `new-dashboard/`. There is no Dockerfile for `od-microservice/`. There is no Dockerfile for `mcp/`.

## 3. PM2 entries — what the repo declares vs. what works

```js
// ecosystem.config.js
{ name: 'carein-backend',   cwd: './backend',       script: 'server.js', interpreter: 'node', PORT: 5000 }   // works
{ name: 'carein-dashboard', cwd: './new-dashboard', script: 'node_modules/.bin/next', args: 'start', PORT: 3005 }
```

**The `carein-dashboard` entry cannot start.** `new-dashboard/` is a Vite project (`new-dashboard/package.json` declares `"dev": "vite"`, `"build": "vite build"`, `"start": "node dist/index.js"` for the unused Express server stub). There is no `next` binary, no `next.config.*`, no `.next/` directory. PM2 will fail-loop this process with `ENOENT: spawn node_modules/.bin/next ENOENT`.

The fact that this has not been noticed is itself a finding: it means either
- the production droplet runs a hand-edited `ecosystem.config.js` that doesn't match the repo, or
- nobody is actually running the new dashboard in production yet (consistent with §1, where Nginx serves the legacy build from `/var/www/html`).

The README, meanwhile, names the prod processes as `retell-backend` and `retell-frontend`:

> ```ssh root@159.89.82.167 "pm2 restart retell-frontend"```  
> — [README.md:124](../README.md)

These names appear nowhere in `ecosystem.config.js`. The README is documenting a previous (likely manually-created) PM2 setup whose definitions don't live in the repo.

**Net:** the repo's deploy plan is not the deploy plan that is running. There is no source of truth on disk for the actual prod PM2 processes.

## 4. Nginx — production vs. docker

`nginx.conf` (root) is the production droplet's Nginx config. It:
- listens on **port 80 only**, no TLS,
- proxies `/api/` to `http://localhost:5000` (the backend),
- serves the React build from `/var/www/html`,
- supports WebSocket upgrade headers (so Socket.IO works through Nginx).

`frontend/nginx.conf` is a different file used only by the Dockerized legacy frontend. It listens on port 3000, proxies `/api/` to `http://backend-dev:5000` (the compose service hostname). This file is **not** used in production.

Risks:
- Two Nginx configs that look similar but proxy to different upstreams — easy to copy the wrong one.
- The production config has no rate limiting at the Nginx layer; everything relies on the in-process `express-rate-limit` (see `audit/07-security.md` H-7).
- `proxy_read_timeout 60s` is too short for some sync endpoints (`POST /api/unified-calls/sync-retell` can pull 200 calls and persist; `POST /api/mango/sync` runs Puppeteer). On long runs the client gets a 504 even though the backend keeps going.

## 5. Cloudflare tunnel

`cloudflared-config.yml`:

```yaml
tunnel: carein
credentials-file: C:\Users\beau\.cloudflared\carein.json
```

The credentials path is a **Windows path**, but the production runtime is a Linux droplet (Ubuntu 20.04 per README). This file therefore cannot be the file the production tunnel reads — it's a developer's local config checked into the repo. The actual Linux tunnel reads `~/.cloudflared/<tunnel-id>.json` on the droplet.

Risks:
- The repo's tunnel config doesn't reflect production. Re-deploying from scratch using this file fails.
- The tunnel terminates TLS at Cloudflare and forwards plaintext HTTP to `localhost:5000`. That is fine inside the box but means anyone with a shell on the droplet can sniff traffic on the loopback interface.
- The fallback `service: http_status:404` is correct.

## 6. `setup.sh` — first-run install

`setup.sh` (lines 39–42):

```bash
cp backend/.env.example backend/.env 2>/dev/null || echo "RETELL_API_KEY=key_5286e8b619b00ed6815991eba586
PORT=5000
NODE_ENV=development
CORS_ORIGIN=http://localhost:3000" > backend/.env
```

This script writes the leaked API key from `README.md` into `backend/.env` if `.env.example` is missing. So the leaked key is embedded in **two** committed files. Rotating the key requires patching both (see `audit/07-security.md` C-1).

Other issues:
- Uses `npm install` not `npm ci`, so a fresh setup may resolve different versions than the lockfiles intend.
- Doesn't install `new-dashboard` or `od-microservice` deps — only legacy frontend and backend.
- Doesn't install or configure PM2, Nginx, or cloudflared.
- Doesn't `chmod 600 backend/.env`.
- Doesn't create the `data/` or `recordings/` directories.

It's a "make it run on a dev laptop" script, not a deploy script.

## 7. Docker compose — dev only

`docker-compose.yml` mounts source as a bind mount and runs `npm start` in both containers:

```yaml
volumes:
  - ./backend:/app
  - /app/node_modules
```

This is a development pattern (live source in container, anonymous volume to preserve `node_modules`). The production-style multi-stage `frontend/Dockerfile` is **not** used by `docker-compose.yml` — compose uses the same Dockerfile but bind-mounts source over it, defeating the build stage.

`docker-compose.dev.yml` (read in Phase A) is a closer dev experience with hot reload. Neither compose file is used in production; nothing on the droplet is containerized.

## 8. CI/CD

There is **no CI**:

- No `.github/workflows/`
- No `.gitlab-ci.yml`
- No `circle.yml`, no Travis, no Jenkinsfile
- No Husky pre-commit, no lint-staged
- No deploy webhook from GitHub to the droplet

Deploys are manual `git pull && pm2 restart all` over SSH. README documents the procedure and even has a PowerShell `scp` example from a dev's Windows machine ([README.md:122-125](../README.md)). This means:
- No build verification before deploy. A broken build hits prod immediately.
- No artifact pinning. A `git pull` may bring in a partially-merged commit.
- No rollback story beyond `git checkout <sha> && pm2 restart all`.
- No history of what was deployed when.

## 9. Operational secrets footprint

| Secret | Lives on droplet at | Backed up? |
|---|---|---|
| `backend/.env` | `/root/retell-ai-dashboard/backend/.env` (per README path) | No |
| Cloudflared tunnel creds | `~/.cloudflared/<tunnel-id>.json` | No |
| Open Dental DB credentials | inside `backend/.env` | No |
| Mango portal creds | inside `backend/.env` | No |
| SSH root key | the operator's local box | Out of scope for this repo |

Losing the droplet means re-entering all of the above by hand. There is no `op-secrets`/Vault/SSM-based fetch.

## 10. Disaster recovery — concrete walkthrough

If the droplet died right now, recovery looks like:
1. Provision a new DigitalOcean droplet, Ubuntu 20.04.
2. Install Node 18+, PM2, Nginx, cloudflared.
3. `git clone` the repo. Run `setup.sh` (which writes the leaked-key `.env`).
4. **Manually re-enter every real secret** into `backend/.env`.
5. Copy `nginx.conf` into `/etc/nginx/sites-available/` and enable it.
6. Re-create the Cloudflare tunnel and re-issue the credentials file. Update `cloudflared-config.yml` to a Linux path.
7. Realize that `ecosystem.config.js` doesn't match the actual prod processes; either fix the config or hand-craft the PM2 entries the README assumes.
8. Realize that `data/unified_calls.json` and `recordings/mango/` are empty. **All historical call data and recordings are lost.**
9. Wait for new calls to arrive to repopulate.

There is no backup, no restore script, no documented runbook for any of the steps above except (4) and (8) which are unwritten.

**RTO:** several hours by an experienced operator. **RPO:** total data loss back to the last `git push`.

## 11. Summary of deploy/ops gaps

| # | Gap | Severity |
|---|---|---|
| 1 | New-dashboard PM2 entry runs `next start` on a Vite project | High (deploy blocker for new UI) |
| 2 | README PM2 process names don't match `ecosystem.config.js` | High (drift between docs and reality) |
| 3 | Cloudflared config uses a Windows path | Medium (DR blocker) |
| 4 | `setup.sh` writes a leaked API key into `.env` | High (security + DR) |
| 5 | No CI, no automated deploy | Medium |
| 6 | No backups for `data/` or `recordings/` | High (PHI loss risk) |
| 7 | Two Nginx configs that look similar | Low |
| 8 | `proxy_read_timeout 60s` too short for sync endpoints | Low |
| 9 | No documented runbook | Medium |
| 10 | Two ingress paths (HTTP IP + Cloudflare TLS), only one is private | High (HTTPS not enforced) |

## 12. Recommended five-step ops cleanup

1. **Decide one ingress path** — either lock down the droplet's port 80 to Cloudflare's IPs only and force everything through the tunnel, or stand up TLS via Let's Encrypt and drop the tunnel.
2. **Make `ecosystem.config.js` the source of truth** — fix the new-dashboard entry (`npm run preview` for Vite, or build a static `dist/` and serve via Nginx), align the names with what's actually running, and commit a brief `OPS.md` runbook.
3. **Add nightly snapshot of `data/` and `recordings/`** to a remote bucket. Rotate at 30 days. This alone takes the system from "PHI loss on droplet failure" to "≤24h RPO".
4. **Replace `setup.sh` with a proper deploy script** (Ansible playbook, or even a shell script that pulls, runs `npm ci`, builds frontends, restarts PM2 by name) and stop committing API keys in it.
5. **Stand up minimal CI** — GitHub Actions running `npm ci && npm run build` on PR for backend, frontend, and new-dashboard. Catches the `next` vs `vite` class of bug at PR time, not in production.
