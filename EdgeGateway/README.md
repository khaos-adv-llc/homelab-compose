# EdgeGateway

This stack runs `newt` (`fosrl/newt`), the client half of
[Pangolin](https://github.com/fosrl/pangolin) — a self-hosted reverse
tunnel/access system. `newt` connects outbound to a Pangolin server
(`PANGOLIN_ENDPOINT`) and, once authenticated, lets Pangolin route external
traffic in to services on this Docker host without opening inbound ports
directly.

**Updated Sept 2026 (Pangolin migration):** this used to be the primary
exposure path for most of the homelab (`appname.external.valdeze.ch`).
It no longer is. Almost every service is now internal-only via Traefik at
`appname.valdeze.ch`, reached remotely through the UniFi VPN's split
tunnel instead of through Pangolin. `newt` now only needs to route a
minimal exception list: Authentik (`auth.valdeze.ch`), Mealie
(`meals.valdeze.ch`), YTzero (`yt.valdeze.ch`), and the
FluxerDiscordBridge panel (`fluxerbridge.valdeze.ch`) -- services that
genuinely need to work without the VPN. The standalone Cloudflare Tunnel
in `Cloudflared/` has been decommissioned entirely (it was never carrying
live traffic).

This folder also still contains a `nginx-proxy-manager/` subfolder and a
fully commented-out NPM service block — a leftover from the retired Nginx
Proxy Manager setup, not anything active. As of this writing it hasn't been
confirmed safe to delete (worth a final Duplicati backup pass first), so
it's left in place rather than removed.

## Prerequisites

- A running Pangolin server (self-hosted or Pangolin's hosted offering)
  with a site/`newt` identity already created, giving you `NEWT_ID` and
  `NEWT_SECRET`.
- Existing `MediaServer`, `shared-services`, and `reactive_resume_network`
  Docker networks — `newt` needs to be able to reach containers on all
  three to route to them.
- Docker socket access (mounted read-only) for `newt` to discover
  containers to route to.

## Running it standalone

Moderately portable: you need your own Pangolin server and a `newt`
identity for it, plus whatever networks your own services actually sit on
(the three networks referenced here are specific to this homelab's layout
— swap them for your own). The retired `nginx-proxy-manager/` block can be
safely ignored or deleted if you're starting fresh elsewhere; it isn't
wired to anything active.

## How it fits into this homelab

- **No Traefik labels** — `newt` isn't a web app Traefik routes to; it's
  itself part of the routing path, working alongside (not replacing)
  Traefik. Pangolin/`newt` gets traffic to the host; Traefik still handles
  TLS termination and host-based routing to the right container once
  traffic arrives.
- **Networks**: `MediaServer`, `shared-services`, and
  `reactive_resume_network` — enough to reach most of what's meant to be
  externally routable across this homelab.
- **Git Sync**: wired up like every other non-exempt stack.
- **Secrets**: `PANGOLIN_ENDPOINT`, `NEWT_ID`, `NEWT_SECRET` come from
  Infisical via `render-env.sh`.

## Notes / gotchas

- `newt` mounts the raw Docker socket read-only
  (`/var/run/docker.sock:/var/run/docker.sock:ro`) rather than going
  through `socket-proxy` — read-only limits some damage, but this is still
  one of the containers tracked in the top-level README's Docker-socket
  hardening backlog (alongside Arcane, Homepage, and `deunhealth`).
- The `nginx-proxy-manager/` subfolder and its fully commented-out service
  block in `docker-compose.yml` are dead weight from the pre-Traefik era —
  don't uncomment it (NPM is retired homelab-wide) and don't assume it's
  safe to delete without checking backup coverage first.
- Confirmed (Sept 16, 2026) that this is genuinely a separate stack from
  `Traefik/`, despite both being edge/external-access related — `newt`
  lives here, Traefik + its `socket-proxy` + the Authentik forward-auth
  outpost live in `Traefik/`.
