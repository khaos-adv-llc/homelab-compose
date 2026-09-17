# postgres

A single, shared Postgres 17 instance — the central database for this
homelab, as distinct from nearly every other stack's own dedicated
Postgres container. As of this writing it backs exactly one consumer,
Arcane (`arcane`'s `ARCANE_DATABASE_URL`), confirmed both by grepping every
compose file in this repo for anything pointing at the `postgres`
hostname, and by checking `pg_stat_activity` on the live server directly.
It's kept around specifically because Arcane depends on it, not because
it's a recommended pattern to extend — every other stack that needs a
database runs its own dedicated instance instead (see the top-level
README's design-decisions section for why).

## Prerequisites

- Manually generated file-based Docker secrets before first start:
  `./secrets/pg_user.txt`, `./secrets/pg_pw.txt`, `./secrets/arcane_pg_pw.txt`.
- An existing `shared-services` Docker network.
- Nothing exposed on the LAN — it binds only to `127.0.0.1:5432` on the
  host, reachable from other containers via the Docker network, not from
  other machines on the network.

## Running it standalone

Portable as a plain Postgres instance — it's just `postgres:17` with
file-based secrets and a few tuning flags (`pg_stat_statements`, connection
logging, slow-query logging at 1000ms). What *isn't* portable is the
assumption that anything depends on it: elsewhere, you'd be standing up a
generic shared Postgres server, not "the database this specific homelab's
Arcane instance needs." If you're trying to reuse this compose file as a
template for a shared Postgres elsewhere, that's reasonable; if you're
trying to reuse it as part of *this* homelab's stack elsewhere, remember
`arcane`'s `ARCANE_DATABASE_URL` needs to point at wherever you actually
put it.

## How it fits into this homelab

- **No Traefik labels** — Postgres isn't an HTTP service, so it isn't
  routed by Traefik; it's reached by other containers over the
  `shared-services` network by hostname (`postgres`), and by the host
  itself via the `127.0.0.1:5432` port binding.
- **Networks**: `shared-services` only.
- **Git Sync**: on, for **drift-tracking only** — like `arcane`, this stack
  is permanently exempt from automated redeploy, deliberately, because of
  its blast radius: a bad automated redeploy of the one thing Arcane's own
  database depends on is a much worse failure mode than most stacks, so
  any real change here goes through a manual, watched
  `docker compose up -d`.
- **Secrets**: this is the one stack (alongside Infisical's own database)
  that already uses genuine file-based Docker secrets rather than plain env
  vars — `pg_user`, `pg_pw`, and `arcane_pg_pw` are all mounted via the
  `secrets:` block, not passed as `environment:` values. This is the
  pattern the rest of the homelab is gradually migrating toward, not
  something unique to Postgres.

## Notes / gotchas

- `/docker/postgres` and its `compose.yaml` were found to be **root-owned**
  on the host — the same ownership issue found on `arcane`. The applied
  fix was a targeted, non-recursive
  `sudo chown tuckeraa:tuckeraa /docker/postgres /docker/postgres/compose.yaml`,
  leaving `data/`, `initdb/`, and `secrets/` untouched. Worth checking
  ownership again if this stack is ever redeployed fresh.
- Postgres itself doesn't strictly need to be decommissioned even though
  Arcane's own docs say SQLite is the default and Postgres is opt-in —
  decommissioning this container is only sensible via a deliberate
  migration (back to SQLite, or to a dedicated Postgres matching every
  other stack's pattern), never a plain removal, since Arcane is actively
  using it right now.
- `POSTGRES_INITDB_ARGS: "--auth-host=scram-sha-256"` sets a stronger
  password-hashing method for host-based connections than Postgres's older
  default — worth keeping if you're basing a new deployment on this file.
