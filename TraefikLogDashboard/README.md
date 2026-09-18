# Traefik Log Dashboard

[hhftechnology/traefik-log-dashboard](https://github.com/hhftechnology/traefik-log-dashboard)
-- a real-time analytics UI for Traefik's access logs. Replaces the stock
Traefik dashboard (`api@internal`) at `traefik.internal.valdeze.ch` as of
2026-09-18.

Two containers:

- **`traefik-log-agent`** -- tails Traefik's JSON access/error log files and
  exposes a REST API on port 5000.
- **`traefik-log-dashboard`** -- the web UI (port 3000), talks to the agent
  over the shared `proxy_net` network.

## Prerequisites

- Traefik must be writing JSON access logs to a file, not just stdout. This
  was not the case before 2026-09-18 (`accessLog: {}` in
  `Traefik/config/traefik.yml` only logged to stdout in Traefik's default
  "common" format). Both the static config and `Traefik/docker-compose.yml`
  were updated alongside this stack:
  - `config/traefik.yml` now sets `accessLog.filePath` /
    `accessLog.format: json` (and the same for `log.*`, so error-level logs
    are also file-based and JSON).
  - `Traefik/docker-compose.yml` now mounts a named volume,
    `traefik-logs`, into the `traefik` service at `/var/log/traefik`, and
    declares it with an explicit `name: traefik-logs` (not
    project-prefixed) so other stacks can attach to it by that exact name.
- The shared `tld_auth_token.txt` secret file must exist under
  `./secrets/` before first boot (see `.env.example`).

## How it fits into this homelab

- **Network**: `proxy_net` only -- it doesn't touch `MediaServer` or
  `shared-services`; it just needs to be reachable from Traefik and to
  share the `traefik-logs` volume.
- **Routing**: no `traefik.*` Docker labels. Like Authentik's outpost
  callback route on this same hostname, it's routed via Traefik's dynamic
  file provider (`Traefik/dynamic/dashboard.yml`), reusing the LAN
  allowlist + Authentik forward-auth + rate-limit + security-headers
  middleware chain that used to gate `api@internal`. The old router is
  left in that file, commented out, rather than deleted, in case the stock
  dashboard is ever wanted back.
- **Auth**: neither component speaks OIDC natively, so the dashboard sits
  behind the existing `authentik-outpost` forward-auth middleware rather
  than getting its own login, matching how other non-OIDC-native admin
  tools in this homelab are handled. The `tld_auth_token.txt` secret is a
  separate thing -- it only authenticates the agent↔dashboard API calls,
  not a browser.
- **Secrets**: file-based (`./secrets/tld_auth_token.txt`), matching the
  central-Postgres pattern, rather than a plain env var.
- **GPU / GeoIP**: not configured. `GEOIP_LOCAL_DB_PATH` /
  `GEOIP_PROVIDER_URLS` can be added to the `traefik-log-dashboard`
  service later if IP-geolocation on the map view is wanted.

## Deploying

1. On the host, confirm/generate the shared secret:
   ```
   mkdir -p secrets && openssl rand -hex 32 > secrets/tld_auth_token.txt
   ```
2. Redeploy `Traefik` first (it now writes to the `traefik-logs` volume) --
   `docker compose up -d` in `Traefik/`.
3. Bring this stack up -- `docker compose up -d` in `TraefikLogDashboard/`.
4. Visit `https://traefik.internal.valdeze.ch/` -- should now serve this
   dashboard instead of the stock Traefik UI, behind the same LAN +
   Authentik gate as before.

## Notes / gotchas

- `Traefik/dynamic/dashboard.yml` still defines `security-headers` locally
  as well as in `Traefik/dynamic/shared.yml` -- a pre-existing duplicate
  from before this change, not introduced by it. Harmless since the
  content is identical, but worth deduplicating (drop the copy in
  `dashboard.yml`) next time that file is touched.
- If `traefik-log-agent` logs permission errors reading
  `/var/log/traefik/access.log`, check the file's ownership -- Traefik
  writes it as whatever user the `traefik` container runs as, and this
  container reads it read-only as its own default user.
