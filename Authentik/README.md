# Authentik

[Authentik](https://goauthentik.io/) is the identity provider (IdP) for
this homelab — a self-hosted, open-source alternative to something like
Okta or Auth0. It's what lets apps that support OIDC (OpenID Connect, a
standard protocol for delegating login to a separate identity provider)
log users in against a single set of credentials, instead of every app
maintaining its own username/password database. This folder is Authentik's
**core app**: its own dedicated Postgres, a Redis instance, the `server`
and `worker` processes, and a daily Postgres backup sidecar. Authentik's
two outposts (LDAP and forward-auth/proxy) live in separate stacks — see
`AuthentikOutpost/` and `Traefik/`.

## Prerequisites

- An existing `shared-services` Docker network.
- A generated `AUTHENTIK_SECRET_KEY` and a set of Postgres credentials (see
  `.env.example`) — plus, if you want outbound email (password resets,
  notifications) working, real SMTP credentials.
- Nothing GPU-related, no special host privileges.

## Running it standalone

Reasonably portable as a compose file, but not as a *deployment* — running
Authentik by itself is easy; making it the identity provider every other
app in your homelab trusts is the real work, and that part doesn't travel
with this folder. To run just this piece: drop or replace the
`shared-services` network with your own, generate your own
`AUTHENTIK_SECRET_KEY` and Postgres credentials, and expect to spend real
time in Authentik's own admin UI configuring providers, applications, and
outposts for whatever you want to protect — none of that configuration
lives in this compose file, it's stored in Authentik's own database.

## How it fits into this homelab

- **Traefik / hostname**: `auth.valdeze.ch` is the *only* URL for
  Authentik — there is no internal-only alias, confirmed directly by
  Tucker. Notably, **no `traefik.*` labels appear anywhere in this compose
  file** at all — see the gotcha below.
- **Networks**: `server` attaches to `shared-services` under the alias
  `authentik-server` (so Traefik can reach it there), while `postgresql`
  and `redis` deliberately have no explicit `networks:` entry and stay on
  the project's own internal `default` network — only `worker` and
  `server` need to reach them, and they're all in the same compose file.
  Don't add `shared-services` to `postgresql`/`redis` "for consistency" —
  they were deliberately kept off it.
- **Git Sync**: wired up like every other stack (per the top-level
  README's bootstrap order), full automated redeploy — Authentik isn't one
  of the two permanently-exempted stacks (`arcane`, `postgres`).
- **Secrets**: fully Infisical-backed — `PG_USER`/`PG_PASS`/`PG_DB`,
  `AUTHENTIK_SECRET_KEY`, and the `AUTHENTIK_EMAIL__*` block all come from
  Infisical's `Authentik` folder via `render-env.sh`.
- **Backups**: a `postgresql-backup` sidecar (`prodrigestivill/postgres-backup-local`)
  dumps daily/weekly/monthly to `/docker/Authentik/pgdump` — a second,
  independent backup layer on top of Duplicati's own coverage of the same
  path (Duplicati backs up `/docker/Authentik/{pgdump,data,templates,certs}`
  from its home in `ServarrSuite/docker-compose.yml`; see that stack's
  README and the top-level README's Duplicati callout).

## Notes / gotchas

- **No Traefik labels anywhere in this file**, yet `server` is clearly
  reachable on `shared-services`. This is one of several data points (along
  with Mealie, Reactive Resume, Trek, and YTzero) suggesting Authentik's
  `auth.valdeze.ch` routing is defined in Traefik's `./dynamic` file-provider
  directory instead of via compose labels — genuinely unconfirmed without
  actually reading that directory's contents; see the top-level README's
  open-questions list.
- **`AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS` is hardcoded to `"172.19.0.0/16"`**
  in both `server` and `worker` — a literal match for the `shared-services`
  subnet. This tells Authentik to trust `X-Forwarded-*` headers only from
  that subnet, which matters for it correctly seeing real client IPs behind
  Traefik. If `shared-services`'s subnet ever changes, this needs to change
  with it — it won't just work itself out.
- The `worker` service mounts the Docker socket directly
  (`/var/run/docker.sock:/var/run/docker.sock`) — Authentik uses this for
  its Docker-based outpost integration. Worth keeping in mind alongside the
  other direct-socket-mount containers tracked in the top-level README's
  hardening notes.
