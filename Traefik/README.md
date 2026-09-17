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
- **Git Sync**: wired up like every other non-exempt stack.
- **Secrets**: the Cloudflare DNS API token is mounted as a Docker secrets
  file (not a plain env var) directly in `docker-compose.yml`; the
  Authentik outpost's token (`AUTHENTIK_OUTPOST_TOKEN`) comes from
  Infisical via `render-env.sh`.

## Notes / gotchas

- Traefik also mounts `./dynamic:/etc/traefik/dynamic:ro` — a file-based
  dynamic-configuration provider directory, meaning routing rules can be
  defined in plain YAML/TOML files there instead of, or in addition to,
  Docker labels. **As of this writing, the actual contents of `./dynamic`
  haven't been confirmed** — this is the leading (but unconfirmed)
  hypothesis for how Authentik, Mealie, Reactive Resume, Trek, and YTzero
  might be routed despite having no `traefik.*` labels in their own compose
  files. Worth checking directly before assuming any of those five
  services are unrouted.
- Both `socket-proxy` and `traefik` itself run `read_only: true` with
  `tmpfs` mounts for their writable paths (`/run`, `/tmp`) — a hardening
  detail worth preserving if this compose file is ever significantly
  modified.
- `socket-proxy` is genuinely the "good" example in this homelab for
  Docker API exposure — several other containers (Arcane, `newt`,
  Homepage, `deunhealth`) still mount the raw socket directly, which is a
  tracked hardening gap, not a pattern to copy for anything new.
