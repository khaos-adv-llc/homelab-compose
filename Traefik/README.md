# Traefik

[Traefik](https://traefik.io/) v3.6 is the reverse proxy and TLS
terminator for this entire homelab. Every internal and external hostname
(`*.internal.valdeze.ch`, `*.external.valdeze.ch`, and a handful of
apex-domain hostnames) that's routed by Docker labels ultimately passes
through this stack. Alongside Traefik itself, this compose file also runs
`socket-proxy` (a scoped, read-only Docker API proxy Traefik uses instead
of the raw socket) and Authentik's **forward-auth/proxy outpost**
(`authentik-outpost`) — confirmed via a repo-wide `grep -l goauthentik` to
genuinely live in this same file, not just inferred from context.

## Prerequisites

- Existing `proxy_net`, `MediaServer`, `shared-services`, and
  `reactive_resume_network` Docker networks — Traefik needs to reach
  containers on all four to route to them by label.
- A Cloudflare account with DNS access for whichever domain(s) you're
  issuing certificates for, and an API token with DNS-edit permission,
  stored as a Docker secret file (`./secrets/cloudflare_dns_api_token`).
- Ports `80` and `443` free on the host.
- An Authentik outpost token, if you want the bundled forward-auth outpost
  to actually authenticate against Authentik.

## Running it standalone

Traefik itself is highly portable and well-documented upstream — the
homelab-specific pieces here are the `socket-proxy` pairing (worth keeping
if you value least-privilege Docker API access) and the bundled Authentik
outpost (drop this service entirely if you don't use Authentik, or aren't
ready to). You'll need your own Cloudflare-managed domain for the DNS-01
challenge as configured, or swap `certresolver=cloudflare` for whatever DNS
provider/challenge type your own domain's DNS is hosted with — Traefik
supports dozens of DNS providers for DNS-01 beyond Cloudflare.

## How it fits into this homelab

- **TLS**: every router across every stack in this repo that has Traefik
  labels uses `certresolver=cloudflare` — Let's Encrypt certificates issued
  via Cloudflare's DNS-01 challenge (proving domain ownership via a DNS TXT
  record rather than serving an HTTP file, which is what allows issuing
  wildcard certificates without exposing port 80 for that specific
  purpose). This is a separate use of Cloudflare from the standalone
  Cloudflare Tunnel container in `Cloudflared/` — don't conflate the two;
  this one only issues certificates, it never carries live traffic.
- **Docker API access**: Traefik does **not** mount the raw Docker socket.
  `socket-proxy` (linuxserver's image) sits in between and exposes only a
  read-only, tightly-scoped subset of the Docker API — containers,
  services, networks, events, info, ping — with everything else (exec,
  secrets, volumes, image builds, swarm) explicitly disabled. This is the
  pattern any new service needing Docker discovery in this homelab should
  reuse, rather than mounting the real socket directly.
- **Networks**: `proxy_net` (Traefik's own front-door network),
  `MediaServer`, `shared-services`, and `reactive_resume_network` — enough
  to reach labeled containers across every other network in this homelab.
- **Git Sync — important caveat confirmed 2026-09-18**: only `compose.yaml`
  and `.env` are actually managed by Arcane's Git Sync for this project.
  `config/`, `dynamic/`, `letsencrypt/`, and `secrets/` are local-only
  "workspace files" in Arcane — editable there, but **pulling from Git
  never touches them**, even when the repo has files at those same paths.
  Concretely: this repo's `config/traefik.yml` and `dynamic/*.yml` are
  reference copies only. To actually change Traefik's static config or
  dynamic routing on the live host, edit the files directly in Arcane's
  project workspace editor (Projects → traefik → Configuration →
  Workspace) and hit Save there — a git commit/push/pull alone does
  nothing for these paths. This was the root cause of a routing bug on
  2026-09-18 (see below) and cost real debugging time; don't assume a
  green "Sync from Git" implies these files are current.
- **Secrets**: the Cloudflare DNS API token is mounted as a Docker secrets
  file (not a plain env var) directly in `docker-compose.yml`; the
  Authentik outpost's token (`AUTHENTIK_OUTPOST_TOKEN`) comes from
  Infisical via `render-env.sh`.

## Traefik dashboard replaced (2026-09-18)

The stock Traefik dashboard (`api@internal`, routed at
`traefik.internal.valdeze.ch`) was replaced with
[hhftechnology/traefik-log-dashboard](https://github.com/hhftechnology/traefik-log-dashboard)
— see `../TraefikLogDashboard/README.md` for that stack. To make it work:

- `config/traefik.yml`: `accessLog`/`log` switched from stdout (`{}`) to
  file-based JSON output (`filePath` + `format: json`), since the
  dashboard's agent tails a log file.
- `docker-compose.yml`: the `traefik` service now mounts a named volume,
  `traefik-logs`, at `/var/log/traefik`, declared with an explicit
  `name: traefik-logs` (not project-prefixed) so the dashboard stack can
  attach to it by that exact name.
- `dynamic/dashboard.yml`: the `traefik-dashboard` router (which pointed at
  `api@internal`) is commented out, not deleted, and a new
  `traefik-log-dashboard` router takes over the same hostname, same
  middleware chain (LAN allowlist + Authentik forward-auth + rate-limit +
  security-headers).
- `dashboard-lan-allowlist`'s `sourceRange` also picked up a `/32` for
  Tucker's laptop's WireGuard peer address (`192.168.3.3/32`) alongside the
  existing `10.210.40.0/24` and `10.210.50.0/24` — accessing the dashboard
  over the homelab WireGuard tunnel presents that IP to Traefik, not the
  laptop's real LAN IP, so it needed its own allowlist entry.

## Notes / gotchas

- `./dynamic:/etc/traefik/dynamic:ro` is a file-based dynamic-configuration
  provider directory (`watch: true`, so changes apply live with no
  restart needed). **Contents confirmed 2026-09-18**: `dashboard.yml`
  (the dashboard router, described above), `shared.yml` (a
  `security-headers` middleware — also duplicated locally in
  `dashboard.yml`, a harmless pre-existing redundancy worth cleaning up
  next time that file is touched), and `tls.yml` (sets the `default` TLS
  store's cert resolver to `cloudflare` for `internal.valdeze.ch` and its
  wildcard). This resolves the open question about whether Authentik,
  Mealie, Reactive Resume, Trek, or YTzero might be routed via this
  provider — none of them are; it's dashboard/TLS-store config only, and
  those five services' routing (or lack of it) is unrelated.
- Both `socket-proxy` and `traefik` itself run `read_only: true` with
  `tmpfs` mounts for their writable paths (`/run`, `/tmp`) — a hardening
  detail worth preserving if this compose file is ever significantly
  modified.
- `socket-proxy` is genuinely the "good" example in this homelab for
  Docker API exposure — several other containers (Arcane, `newt`,
  Homepage, `deunhealth`) still mount the raw socket directly, which is a
  tracked hardening gap, not a pattern to copy for anything new.
