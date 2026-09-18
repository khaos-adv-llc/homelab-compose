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

- **Web UI has no Traefik labels.** It's still reached directly by
  `<host-ip>:3000`, not through a `*.internal.valdeze.ch` hostname — DNS
  servers are usually reached by IP anyway, so this isn't unusual.
- **DNS-over-HTTPS has a Traefik label + `shared-services` network
  membership** (added for the `doh.valdeze.ch` remote-DNS setup): a
  `traefik.http.routers.adguardhome-doh` router routes
  `doh.valdeze.ch` to this container's internal port 443, with Traefik
  terminating the real publicly-trusted cert (`certresolver=cloudflare`)
  and re-encrypting to AdGuard Home's own DoH listener using
  `insecureSkipVerify` (AdGuard Home's DoH cert itself can be self-signed
  — see the DNS-over-HTTPS note below). Port 443 is deliberately **not**
  published to the host here — it would collide with Traefik's own
  host-published 443 — reachability for this router is purely
  container-to-container over `shared-services`, which is also how
  Pangolin/`newt` reaches Traefik itself for the external hop. The
  `traefik.docker.network=shared-services` label is required here (same
  pattern already used by Infisical and one ServarrSuite service) —
  without it, Traefik's Docker provider defaults to its global
  `proxy_net` preference, finds this container isn't on it, falls back
  to "first available network" and can pick `adguardhome_default`
  instead, which Traefik has no access to at all and can never route to.
- Otherwise still on no other Docker networks — DNS (53) and the web UI
  (3000) are still reached by publishing ports directly, not via
  `proxy_net` or `MediaServer`.
- **Git Sync**: wired up like every other stack in this repo (see the
  top-level README's bootstrap order) — Arcane pulls this compose file and
  can redeploy it.
- **Secrets**: none. `render-env.sh` still renders an (empty) `.env` for
  this stack for consistency with every other stack in the `STACKS` array,
  but there's nothing in Infisical for it to pull.

## DNS-over-HTTPS / DNS-over-TLS (remote access)

`doh.valdeze.ch` is set up so devices away from home can use this
resolver over DoH without any port-forwarding, tunneled the same way
`arcane.external.valdeze.ch` and other externally-reachable services are:
`newt` (Pangolin) -> Traefik -> this container, over `shared-services`.

To finish setting this up (steps outside this repo, done directly on the
host / in AdGuard Home's own config):

0. Traefik needs `serversTransport: { insecureSkipVerify: true }` added
   as a **top-level** key in `config/traefik.yml` (sibling of
   `entryPoints`/`providers`/`certificatesResolvers`, not nested under
   any of them) -- this is what lets Traefik re-encrypt to AdGuard
   Home's self-signed DoH cert without failing validation. A
   per-container `traefik.http.serversTransports.*` label was tried
   first and didn't register correctly in this Traefik instance for
   reasons not fully diagnosed, so this global static-config default is
   used instead. Note this is a **global** default -- it applies to any
   future Traefik service with an HTTPS-scheme backend, not just this
   one, until something more scoped replaces it. Restart Traefik after
   adding it.
1. Enable TLS/encryption in AdGuard Home (Settings -> Encryption
   settings, or `confdir/AdGuardHome.yaml`'s `tls:` block) with
   `port_https: 443`, `server_name: doh.valdeze.ch`. The cert/key here
   can be self-signed (Traefik is what presents the real
   publicly-trusted cert to clients; this is just the internal
   Traefik<->AdGuard Home hop) -- generate one and drop it in
   `confdir/`, e.g.:
   ```
   openssl req -x509 -newkey rsa:2048 -nodes \
     -keyout confdir/doh-selfsigned.key \
     -out confdir/doh-selfsigned.crt \
     -days 825 -subj "/CN=doh.valdeze.ch" \
     -addext "subjectAltName=DNS:doh.valdeze.ch"
   ```
   (the `-addext` SAN is required -- a CN-only cert fails AdGuard Home's
   own cert-pair validation on modern Go/OpenSSL, since Go's TLS stack
   ignores the legacy CN field entirely. Needs OpenSSL 1.1.1+.)
   then in the GUI's Encryption settings, set the certificate/private
   key **paths** (not pasted contents) to the container-side paths:
   `/opt/adguardhome/conf/doh-selfsigned.crt` and
   `/opt/adguardhome/conf/doh-selfsigned.key`.
2. **Important:** AdGuard Home's `port_https` (443) serves both the
   admin web UI at `/` *and* DoH at `/dns-query` on the same listener --
   there's no way to split them in AdGuard Home itself. The Traefik
   router above is deliberately scoped to
   `Host(\`doh.valdeze.ch\`) && PathPrefix(\`/dns-query\`)` so only DoH
   queries are reachable externally -- anything else on that hostname
   (including the admin login page) gets no matching router and 404s.
   Don't widen that rule to a bare `Host()` match without adding an
   equivalent restriction some other way, or the admin panel becomes
   reachable from the internet via Pangolin.
3. Add a Pangolin resource (HTTP type) for `doh.valdeze.ch` targeting the
   Traefik container on port 443 (the same way other
   `*.external.valdeze.ch` services with active Traefik labels are
   exposed through Pangolin) — not this container directly.
4. DNS-over-TLS (port 853) has **no equivalent path** here — Pangolin's
   available resource types (HTTP, AI Gateway, SSH, RDP, VNC, as of Sept
   2026) don't include a raw TCP/UDP passthrough, and DoT isn't HTTP, so
   it can't ride the same tunnel as DoH. Unconfirmed whether a newer
   Pangolin resource type covers this — otherwise DoT-for-away-from-home
   needs a different mechanism entirely (e.g. a WireGuard tunnel back to
   the LAN).

## Notes / gotchas

- The compose file's port section includes several commented-out
  alternative listeners (DNS-over-HTTPS, DNS-over-TLS, DNS-over-QUIC,
  DNSCrypt) — uncomment whichever you actually want to expose, and make
  sure the corresponding port is free on the host.
- Whether AdGuard Home now handles some or all DNS resolution previously
  attributed only to the UniFi gateway is not fully confirmed — worth
  checking with Tucker if you're debugging a DNS issue rather than assuming
  either one is authoritative.
