# ServarrSuite

The full media/download/playback stack — around 28 services in one
compose file, covering VPN tunneling, download clients, indexers, the
*arr apps (Sonarr, Radarr, Lidarr, Bazarr), discovery/request tools,
playback (Jellyfin and friends), live TV, file access, a dashboard, and
backups. This is the largest and most interconnected stack in this repo by
far, and it's also where [Duplicati](https://duplicati.com/) — this
homelab's backup tool for *every* stack, not just this one — happens to
live (see the callout below and the top-level README).

Services are grouped by role in the compose file itself (networking/VPN,
download clients, indexers, *arr apps, discovery/requests, playback, live
TV, storage/file access, dashboard, backups), each with its own comment
block — read the compose file's own header comment for the full map before
making changes here.

## Prerequisites

- Existing `MediaServer` and `shared-services` Docker networks.
- A WireGuard-based VPN provider's credentials for the primary `gluetun`
  tunnel, and separately a ProtonVPN account for `gluetun-proton` (used
  specifically for Soulseek traffic) — see `.env.example` for the full
  list of VPN-related variables.
- An NVIDIA GPU passed through to the host, if you want hardware
  transcoding for Jellyfin and Dispatcharr (both declare
  `deploy.resources.reservations.devices` blocks requesting
  `driver: nvidia`) — they'll still run without a GPU, just without
  hardware-accelerated transcoding.
- The host media library directory (`/home/tuckeraa/media` in this
  homelab) — mounted into nearly every service here.
- Authentik configured for `profilarr-v2`'s native OIDC login, if you want
  that specific service's auth to work.

## Running it standalone

**This is the least portable stack in this repo, by a wide margin** — not
because any single service is hard to run alone, but because of how many
services here depend on each other directly (Prowlarr feeding indexers to
every *arr app, `soularr` bridging Lidarr to `slskd`, Duplicati's mounts
spanning several *other* stacks' host paths entirely, `deunhealth`
watching every VPN-namespaced container for stuck health checks). Lifting
out a single *arr app (say, just Sonarr) is realistic — copy its service
block, its `MediaServer` network, its media/config volumes, and its
Prowlarr connection if you want indexer integration. Lifting out the
*whole* stack is realistic too, since it's genuinely one self-contained
unit. Lifting out "some but not all" of it is where the real work is —
expect to trace through `depends_on`, shared `network_mode: service:*`
namespaces, and Duplicati's cross-stack mounts (which reach *outside* this
folder into `Authentik/`, `YTzero/`, and `Infisical/`'s host directories —
see the Duplicati section below) before assuming a partial extraction is
clean.

## How it fits into this homelab

- **Traefik / hostnames**: nearly every service with a web UI has its own
  `traefik.*` labels, using the shared `INTERNAL_DOMAIN` variable (default
  `internal.valdeze.ch`) — e.g. `sonarr.internal.valdeze.ch`,
  `radarr.internal.valdeze.ch`, `prowlarr.internal.valdeze.ch`,
  `media.internal.valdeze.ch` (Jellyfin), `home.internal.valdeze.ch`
  (Homepage), `duplicati.internal.valdeze.ch`. A few services have no
  Traefik label at all by design: `gluetun`/`gluetun-proton` (not web
  apps), `deunhealth` (a background watchdog, `network_mode: none`),
  `flaresolverr` (an internal helper for Prowlarr, not meant for direct
  browsing).
- **GPU**: `jellyfin` and `dispatcharr` both reserve an NVIDIA GPU device
  for hardware-accelerated transcoding — the only two services in this
  entire repo that do.
- **Networking model** (per the compose file's own header comment):
  `MediaServer` is the network almost everything lives on; `shared-services`
  is Traefik's own second network, and `jellyfin` is deliberately dual-homed
  onto both, because its Traefik labels pin
  `traefik.docker.network=shared-services` and need to actually resolve
  there. `qbittorrent` (disabled) and `slskd` use `network_mode:
  service:gluetun`/`service:gluetun-proton` respectively — meaning they
  have no network of their own at all, they share their VPN container's
  network namespace outright, so *only* their traffic (not the whole
  stack's) is forced through that specific VPN tunnel.
- **Git Sync**: wired up like every other non-exempt stack — one compose
  file, so a sync touches the whole stack at once, not one service at a
  time.
- **Secrets**: a long list, covering the VPN credentials, `profilarr-v2`'s
  OIDC client, Jellystat's own Postgres + JWT secret, and Duplicati's own
  web UI password and settings-encryption key — all Infisical-backed via
  `render-env.sh` (see `.env.example` for the full list).

## Why is Duplicati here and not its own stack?

Duplicati (`lscr.io/linuxserver/duplicati`) backs up nearly every stack in
this repo, but it isn't a separate top-level folder — it's one service
inside this compose file, with one read-only bind mount per stack under
`/source/<name>` and one backup job per stack, all going to the same
S3-compatible destination. Its mounts reach well beyond this stack's own
services — e.g. `/docker/Authentik/{pgdump,data,templates,certs}` and
`/docker/YTzero/data` and `/docker/Infisical` are all mounted here too, read-only.
If you're adding backup coverage for a newly-deployed stack anywhere in
this repo, that means adding a source mount and a job **here**, in
`ServarrSuite/docker-compose.yml`, not in the new stack's own folder.

## Notes / gotchas

- **Two independent VPN tunnels run side by side.** `gluetun` (a
  custom/self-chosen WireGuard provider) carries most download-client
  traffic; `gluetun-proton` is specifically ProtonVPN, used only for
  Soulseek (`slskd`) traffic — don't assume all VPN-routed traffic in this
  stack goes through the same tunnel.
- **`nzbget` and `nzbget2` are both active simultaneously** — two
  independent Usenet download-client instances/accounts, not a
  primary/backup pair. `qbittorrent` and `sabnzbd` are present in the file
  but fully commented out/disabled.
- **`deunhealth`** (`network_mode: none`) watches for containers stuck
  "unhealthy" specifically inside a VPN network namespace and restarts
  them — a real operational safety net for the `service:gluetun*`
  containers, not optional decoration.
- **A handful of on-host directories under `/docker/ServarrSuite/` are
  cleanup candidates, not active services** — `compose.yaml.backup...`,
  `sonarr.empty-...`, and duplicate `overseer`/`overseerr` and
  `Suggestarr`/`suggestarr` directories were noted during a host audit as
  probably-safe-to-remove leftovers, but haven't been individually
  confirmed deletable — check before removing anything you find under
  that path that isn't referenced by this compose file.
- **`homepage` mounts the raw Docker socket directly** (read-only
  discovery, per its own design) rather than going through `socket-proxy`
  — one of the containers tracked in the top-level README's Docker-socket
  hardening backlog, alongside Arcane, `newt`, and `deunhealth`.
- **Nothing here auto-updates.** No Watchtower-style container exists in
  this file (or anywhere else in this repo, as of this writing) — every
  image here is pulled and updated deliberately, not automatically.
