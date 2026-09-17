# Infisical

[Infisical](https://infisical.com/) is the self-hosted secrets manager that
every other stack in this repo ultimately depends on for its real
credentials. It holds one project ("Homelab" → Secrets Management), with
one folder per stack (matching the exact folder names in this repo and on
the host), and a read-only machine identity that `scripts/render-env.sh`
authenticates as to pull those secrets down onto the host as real `.env`
files. Nothing in this repo's other 17 stacks ever contains a real secret
value — they only reference `${VARIABLE_NAME}`, and Infisical is where the
actual value lives.

## Prerequisites

- This is the one stack that has to be bootstrapped **before** the rest of
  the Infisical/Arcane pipeline can exist — it can't hand out secrets for
  its own deployment before it's running. See the top-level README's
  bootstrap order.
- An existing `shared-services` Docker network.
- Manually generated file-based Docker secrets for its own Postgres
  password (`./secrets/infisical_db_pw.txt`), since this is the one stack
  that has to use the "old-fashioned" bootstrapping approach the central
  `postgres` stack also uses.
- A root-owned, chmod-600 `.env` for values its own backend image reads as
  plain environment variables rather than Docker secrets (see the gotcha
  below) — `ENCRYPTION_KEY`, `AUTH_SECRET`, `DB_CONNECTION_URI`, and the
  Postgres/backup service's own `POSTGRES_USER`/`POSTGRES_DB` values.

## Running it standalone

Infisical itself is a mature, widely-deployed open-source project with its
own extensive self-hosting docs — running it standalone elsewhere is well
supported, just follow [Infisical's own self-hosting guide](https://infisical.com/docs/self-hosting/overview)
rather than treating this compose file as the canonical reference. What
*is* homelab-specific here: the `traefik.docker.network=shared-services`
pin (needed because `backend` sits on two networks and Traefik needs to be
told which one to actually connect through), the Docker-secrets wiring for
the Postgres password, and the `postgresql-backup` sidecar matching
Authentik's pattern. Drop or adapt all three if you're standing this up
elsewhere.

## How it fits into this homelab

- **Traefik / hostname**: `infisical.internal.valdeze.ch` — LAN-only by
  design, since this holds every other stack's secrets and has no reason to
  be reachable from outside the house.
- **Networks**: `backend` sits on both its own private `infisical` network
  (to reach `db`/`redis`) and `shared-services` (so Traefik can reach it) —
  hence the `traefik.docker.network=shared-services` label, needed to
  disambiguate which of `backend`'s two networks Traefik should actually
  route through.
- **Git Sync**: wired up like every other non-exempt stack — worth noting
  this is slightly recursive (Infisical's own compose file is Git-synced
  from a pipeline that depends on Infisical), but harmless in practice
  since Infisical's compose file itself references no live secrets, only
  `${VAR}` placeholders and Docker-secrets file paths.
- **Backups**: a `postgresql-backup` sidecar
  (`prodrigestivill/postgres-backup-local`) dumps daily/weekly/monthly to
  `/docker/Infisical/pgdump`, matching Authentik's pattern — built
  specifically because Infisical's Postgres and Redis use **named Docker
  volumes** (`pg_data`, `redis_data`), not host bind mounts, so a raw
  volume-level backup wasn't a good fit; a logical `pg_dump` is safer to
  restore from than copying a live Postgres data directory. Duplicati (in
  `ServarrSuite/`) then backs up `.env`, `secrets/`, and `pgdump/` off-box
  to S3 via a whole-directory read-only mount of `/docker/Infisical`.

## Notes / gotchas

- **Infisical's backend doesn't read Docker secrets files directly** —
  only its Postgres container (`db`) does, via `POSTGRES_PASSWORD_FILE`.
  The backend's own sensitive values (`ENCRYPTION_KEY`, `AUTH_SECRET`,
  `DB_CONNECTION_URI`) end up in a root-owned, chmod-600 `.env` instead —
  equivalent protection in practice, just not literally the `secrets:`
  block. Don't assume every value in `.env.example` maps to a real Docker
  secrets file; check which service actually consumes it.
- **Generate the Postgres password with `openssl rand -hex`, not
  `-base64`** — a `-base64`-generated password can contain a `/` character,
  which breaks a `postgres://` connection URI that embeds the password
  directly.
- **`docker compose restart` does not pick up `.env`/secrets changes** —
  if you rotate a credential here, use `docker compose up -d <service>` (or
  `--force-recreate`), never a plain `restart`. A plain restart keeps the
  old, stale environment baked into the still-running container, which can
  cause exactly the kind of "password authentication failed" crash loop
  that looks like the new credential is wrong when it's actually just not
  loaded yet.
- The `db` healthcheck needs an explicit `--dbname` — without it, libpq
  defaults to a database named after `POSTGRES_USER`, which isn't the real
  database name here, and the healthcheck will report spurious "database
  does not exist" errors even though the container itself is healthy.
- As of this writing, `infisical-backend`'s SMTP configuration appears
  unset (`SMTP - Failed to connect to undefined:587` in its logs) —
  password-reset/email features are likely non-functional. Low priority,
  but worth fixing before relying on email-based account recovery.
