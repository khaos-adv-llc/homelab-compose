# authentik (core app)

Now added -- Postgres + Redis + `server` + `worker` + a daily Postgres
backup sidecar (`postgresql-backup`, 7 daily / 4 weekly / 6 monthly
retention, dumping to `/docker/Authentik/pgdump` -- the same path Duplicati
already backs up per the ServarrSuite's `duplicati` service, so this is a
second, independent backup layer on top of that one).

## Two things worth flagging back to the homelab brief

1. **No Traefik labels anywhere in this file**, yet `server` is attached to
   `shared-services` (where Traefik can reach it) under the alias
   `authentik-server`. Combined with the brief's Open Question about
   Traefik's `./dynamic` file-provider directory possibly routing Mealie /
   Reactive Resume / Trek / YTzero -- this is a second, stronger data point
   for the same hypothesis: Authentik's own `auth.valdeze.ch` routing is
   almost certainly defined there too, not via compose labels. Worth
   confirming by actually looking at `./dynamic`'s contents.
2. **`AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS: "172.19.0.0/16"`** is a literal,
   hardcoded match for the `shared-services` subnet from the brief's network
   table -- consistent with, and a nice confirmation of, that subnet
   assignment.

## Bootstrap note

Postgres and Redis here have no explicit `networks:` entry, so they only
join the project's own `default` network -- fine, since only `worker` and
`server` need to reach them and they're in the same compose file. Don't add
`shared-services` to `postgresql`/`redis` "for consistency" -- they were
deliberately kept off it.
