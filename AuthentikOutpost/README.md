# AuthentikOutpost

This stack runs Authentik's **LDAP outpost** (`ghcr.io/goauthentik/ldap`) —
despite the generically-named folder, its image confirms it's specifically
the LDAP outpost, not a combined or proxy outpost (that's a separate
service, `authentik-outpost`, living in `Traefik/`). An outpost is how
Authentik extends its authentication to protocols and apps that can't
speak to it directly over HTTP/OIDC — the LDAP outpost lets anything that
only understands LDAP (the Lightweight Directory Access Protocol, a much
older standard for looking up and authenticating directory/user
information) authenticate against Authentik's user database as if it were
talking to a real LDAP server.

## Prerequisites

- Authentik core (`Authentik/`) already running and reachable at
  `auth.valdeze.ch` — this outpost is useless without a core Authentik
  instance to proxy authentication to.
- An LDAP outpost already created in Authentik's own admin UI, with a
  generated outpost token.
- Existing `MediaServer` and `shared-services` Docker networks.

## Running it standalone

This stack is almost entirely dependent on Authentik core and cannot
function on its own — it's a thin client that authenticates against
whatever `AUTHENTIK_HOST` points to. To run it elsewhere, you need your own
Authentik deployment first, an LDAP outpost configured in it, and that
outpost's token. Beyond that, it's just one container with no persistent
state of its own — swap the two `external: true` networks for whatever
networks your LDAP-speaking clients need to reach it on.

## How it fits into this homelab

- **No Traefik labels** — LDAP isn't an HTTP protocol, so there's nothing
  for Traefik to route; clients speak LDAP directly to this container.
- **Networks**: both `MediaServer` and `shared-services`, under the alias
  `authentik-ldap-outpost` on each — reachable from services in either
  network that need LDAP-based auth.
- **Git Sync**: wired up like every other non-exempt stack.
- **Secrets**: `AUTHENTIK_TOKEN` (the outpost's auth token, generated in
  Authentik's admin UI) comes from Infisical via `render-env.sh`.

## Notes / gotchas

- `.env.example` lists an `AUTHENTIK_TAG` variable that isn't actually
  referenced anywhere in this stack's `docker-compose.yml` (the image tag
  is hardcoded as `2026.8.2`) — a leftover from an earlier template rather
  than something you need to fill in. (A near-identical stray
  `AUTHENTIK_TAG` was caught and dropped from `Authentik/`'s own
  `.env.example` during the initial repo build; this one in
  `AuthentikOutpost/` appears to be the same kind of leftover and is worth
  cleaning up the same way.)
- The image tag (`2026.8.2`) is pinned, not tracking `latest` — bump it
  deliberately alongside Authentik core's own version, since outpost and
  core versions are expected to stay in step with each other.
