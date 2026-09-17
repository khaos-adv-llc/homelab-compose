# AdGuardHome

[AdGuard Home](https://github.com/AdguardTeam/AdGuardHome) is this
homelab's DNS server and network-wide ad/tracker blocker. It answers DNS
queries for the LAN, filtering out ad and tracker domains before they ever
resolve, and gives Tucker a dashboard of what's being blocked and for whom.
It runs alongside the UniFi gateway's own DNS handling — as of this
writing it's not fully confirmed how much of the homelab's DNS/split-horizon
resolution is handled by AdGuard Home versus UniFi, so treat that division
of labor as still being worked out rather than settled.

## Prerequisites

- A Docker host with ports `53/tcp`, `53/udp` free (and, if you enable the
  commented-out alternatives in the compose file, `443`, `853`, `784`,
  `8853`, `5443` too).
- Nothing else — this stack has no dependency on any other stack in this
  repo, no external network, and no secrets.

## Running it standalone

This is one of the most portable stacks here. Clone just this folder,
create `./workdir` and `./confdir` next to the compose file (AdGuard Home
writes its working data and config there), and run:

```
docker compose up -d
```

then finish setup through the web UI on port `3000` (mapped to the
container's port `80`). No `.env` is needed — this stack genuinely has no
configurable environment variables, real or otherwise (see
`.env.example`). Point your router or individual devices' DNS at this
host's IP once it's configured, and be mindful that if this is your only
DNS server and it goes down, DNS resolution for the whole network goes with
it — consider a secondary resolver as a fallback in any environment beyond
a single test box.

## How it fits into this homelab

- **No Traefik labels.** AdGuard Home's web UI is reached directly by
  `<host-ip>:3000`, not through a `*.internal.valdeze.ch` hostname — DNS
  servers are usually reached by IP anyway, so this isn't unusual.
- **No Docker network entries at all** in the compose file — it only
  publishes ports directly, so it isn't on `shared-services`, `proxy_net`,
  or `MediaServer`.
- **Git Sync**: wired up like every other stack in this repo (see the
  top-level README's bootstrap order) — Arcane pulls this compose file and
  can redeploy it.
- **Secrets**: none. `render-env.sh` still renders an (empty) `.env` for
  this stack for consistency with every other stack in the `STACKS` array,
  but there's nothing in Infisical for it to pull.

## Notes / gotchas

- The compose file's port section includes several commented-out
  alternative listeners (DNS-over-HTTPS, DNS-over-TLS, DNS-over-QUIC,
  DNSCrypt) — uncomment whichever you actually want to expose, and make
  sure the corresponding port is free on the host.
- Whether AdGuard Home now handles some or all DNS resolution previously
  attributed only to the UniFi gateway is not fully confirmed — worth
  checking with Tucker if you're debugging a DNS issue rather than assuming
  either one is authoritative.
