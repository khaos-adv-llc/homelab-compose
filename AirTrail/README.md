# AirTrail

[AirTrail](https://github.com/lakuapik/airtrail) is a self-hosted
flight-tracking and travel-logging app (`johly/airtrail` image). It's a
small, low-risk personal app, own dedicated Postgres database, exposed
externally so it can be updated from anywhere Tucker happens to be
traveling. It's also notable in this repo as the **pilot stack** for the
whole Infisical + Arcane Git Sync migration — the first stack ever
migrated end-to-end, and the template every other stack's migration
followed.

## Prerequisites

- An existing `shared-services` Docker network (`external: true` in the
  compose file — this stack expects it to already exist, not create it).
- Three secret values: a Postgres username, password, and database name
  (see `.env.example`).
- No GPU, no special host privileges — this is a plain two-container app.

## Running it standalone

Fairly portable. You'll need to:

- Create your own network (or drop the `shared-services` network entry and
  just use the default network Compose creates) — the only reason this
  stack touches `shared-services` at all is so Traefik can reach it by
  container name.
- Populate a real `.env` with `DB_USERNAME`, `DB_PASSWORD`, and
  `DB_DATABASE_NAME` — these flow straight into both AirTrail's `DB_URL`
  and its Postgres sidecar's credentials, so they must match between the
  two (the compose file already wires this correctly via `${VAR}`
  references; you just need real values in `.env`).
- Change the hardcoded `ORIGIN` (`https://airtrail.external.valdeze.ch`)
  to whatever hostname you'll actually reach this app at — AirTrail uses
  this to validate incoming request origins, so a mismatch will break
  logins/CSRF checks.
- AirTrail's own Postgres data is bind-mounted to `/docker/AirTrail/postgresql`
  on the host — change that path if you're not deploying under `/docker`.

## How it fits into this homelab

- **Traefik / hostname**: `airtrail.external.valdeze.ch`, routed via
  Pangolin (`newt`, in `EdgeGateway/`) — **confirmed** end-to-end during
  this stack's pilot migration (verified by redeploying the container and
  loading the site through that hostname).
- **Networks**: the `airtrail` service joins both the project's own
  `default` network (to reach its own Postgres sidecar) and
  `shared-services` (so Traefik can reach it) under the alias `airtrail`.
  Its Postgres sidecar stays on `default` only — it doesn't need to be
  reachable from anywhere but its own app container.
- **Git Sync**: wired up and validated — this was the very first stack
  Arcane's Git Sync was pointed at, confirming the whole pipeline works.
- **Secrets**: fully Infisical-backed. `DB_USERNAME`, `DB_PASSWORD`, and
  `DB_DATABASE_NAME` live in Infisical's `AirTrail` folder, and
  `render-env.sh` renders them into `/docker/AirTrail/.env` on a schedule.

## Notes / gotchas

- Because this was the pilot, it's worth knowing its migration surfaced two
  real bugs later fixed repo-wide: `render-env.sh` originally used
  `infisical export --format=dotenv-export` (which prepends `export ` to
  every line — meant for shell sourcing, not for Docker Compose's `.env`
  parser) before being corrected to `--format=dotenv`; and a `sed`-based
  edit made through a device bridge once silently dropped a script's
  executable bit. Neither affects AirTrail specifically anymore, but it's
  the reason this stack's history is worth knowing if you're debugging the
  render pipeline itself.
- AirTrail's Postgres uses a healthcheck (`pg_isready`) that the app
  container's `depends_on: condition: service_healthy` waits on — if the
  app container won't start, check the Postgres sidecar's health first.
