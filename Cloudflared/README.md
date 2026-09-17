# Cloudflared

A standalone [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
container (`cloudflare/cloudflared`), authenticated via a `TUNNEL_TOKEN`.
Cloudflare Tunnel lets a service be reached from the internet without
opening any inbound firewall ports — the container makes an outbound
connection to Cloudflare's network, and Cloudflare routes public traffic
back through that tunnel to whatever's configured on the other end.

**As of this writing, current understanding (confirmed directly by Tucker)
is that this is a deliberate standby/fallback path, not presently in active
use** — kept running in case Pangolin (`newt`, in `EdgeGateway/`) has
trouble reaching a particular service, not a competing or partially-used
primary route. Don't assume any specific `*.external.valdeze.ch` hostname
is currently routed through this tunnel without checking Cloudflare's own
tunnel configuration.

## Prerequisites

- A Cloudflare account with a tunnel already created and a `TUNNEL_TOKEN`
  generated for it.
- Nothing else — this is a single container with no persistent state, no
  Docker network requirements beyond its own default network, and no
  dependency on any other stack in this repo.

## Running it standalone

About as portable as a compose file gets: one container, one secret.
Generate your own Cloudflare Tunnel and token, put it in `.env` as
`cloudflare_token`, and run `docker compose up -d`. Whatever you want
reachable through the tunnel is configured on Cloudflare's side (via the
Cloudflare dashboard or `cloudflared`'s own config), not in this compose
file.

## How it fits into this homelab

- **No Traefik labels, no shared networks** — this container doesn't sit
  on `proxy_net`, `shared-services`, or `MediaServer`; it has its own
  isolated `cloudflared_default` network and reaches services purely
  through Cloudflare's tunnel routing (configured on Cloudflare's side, not
  visible in this compose file).
- **Git Sync**: wired up like every other non-exempt stack.
- **Secrets**: the single `cloudflare_token` value (lowercase in the
  compose file, worth noting since every other secret in this repo is
  UPPER_SNAKE_CASE) is Infisical-backed via `render-env.sh`.

## Notes / gotchas

- This is a genuinely different use of "Cloudflare" from Traefik's
  DNS-01 certificate issuance (see `Traefik/README.md`) — don't conflate
  the two. This container is a live tunnel for routing traffic; Traefik's
  Cloudflare integration is only for proving domain ownership to get
  Let's Encrypt certificates. They happen to both use Cloudflare, for
  unrelated reasons.
- Because this is a standby path, its actual tunnel configuration on
  Cloudflare's side (which hostnames it would serve if activated) isn't
  documented in this repo at all — that lives entirely in the Cloudflare
  dashboard/API, outside of anything version-controlled here.
