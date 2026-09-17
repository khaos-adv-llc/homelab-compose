# arcane

[Arcane](https://github.com/getarcaneapp/arcane) (`ghcr.io/getarcaneapp/manager`)
is the Docker-stack management UI for this entire homelab — and the
engine behind this very repo's usefulness. Arcane's native Git Sync
feature is what pulls every stack's compose file from `homelab-compose` on
GitHub down onto the host and (for every stack except itself and
`postgres`) redeploys it automatically. Without Arcane running, this repo
is just a folder of YAML files someone has to `docker compose up` by hand.

## Prerequisites

- The shared central `postgres` container (see `postgres/`) running and
  reachable — Arcane's `DATABASE_URL` points at it. Arcane's own docs say
  SQLite is the default and Postgres is opt-in; this homelab opts in.
- An existing `shared-services` Docker network.
- Full read-write access to the Docker socket and to the host's `/docker`
  directory (`PROJECTS_DIRECTORY: /docker`) — Arcane needs both to
  discover, read, and redeploy every other stack.
- Runs as `1000:1000` (`tuckeraa`), not root — the project directory and
  its `compose.yaml` need to be owned by that user or Arcane's own Git Sync
  can't write to them (see Notes below).

## Running it standalone

Arcane is designed to manage a *fleet* of stacks, so running just this
compose file in isolation gives you an Arcane instance with nothing to
manage — which is a valid way to try it out, but not really "this
repo's" Arcane. To actually use it standalone: drop the `shared-services`
network requirement (or create your own), point `PROJECTS_DIRECTORY` at
wherever your own compose projects live, and either switch `DATABASE_URL`
to SQLite (Arcane's default, no external Postgres needed) or stand up your
own Postgres instance. You'll also need your own OIDC provider if you want
`OIDC_AUTO_REDIRECT_TO_PROVIDER` to do anything — this homelab points it at
Authentik.

## How it fits into this homelab

- **Traefik / hostname**: deliberately reachable only at
  `arcane.external.valdeze.ch`. A second router,
  `arcane-internal-redirect`, matches `arcane.internal.valdeze.ch` and
  permanently redirects (via a `redirectregex` middleware) to the external
  hostname, preserving the full path — so `arcane.internal.valdeze.ch` never
  serves the app directly, it only ever bounces you to the external URL.
- **Networks**: `shared-services` only.
- **Git Sync**: on, for drift-tracking only — **not** for automated
  redeploy. Arcane hard-refuses to redeploy its own compose project
  (confirmed live: `git.sync.error: ... arcane cannot redeploy itself; use
  the system upgrade flow (Settings -> Updates) instead`), a deliberate
  upstream guard ([getarcaneapp/arcane#2371](https://github.com/getarcaneapp/arcane/issues/2371))
  against the container killing itself mid-redeploy and failing to come
  back. Any real compose change here needs a manual `docker compose up -d`;
  version bumps go through Settings → Updates, never Git Sync.
- **Secrets**: `ARCANE_DATABASE_URL`, `ARCANE_ENCRYPTION_KEY`, and
  `ARCANE_JWT_SECRET` are Infisical-backed like everywhere else, rendered
  into `/docker/arcane/.env` by `render-env.sh`.

## Notes / gotchas

- `/docker/arcane` and its `compose.yaml` were found to be **root-owned**
  on the host, while Arcane itself runs as `1000:1000` — a plain UID-1000
  process can't write into a root-owned directory, so Git Sync would fail
  here before ever reaching a redeploy attempt (moot for the redeploy step
  specifically, since that's blocked anyway, but it still matters for the
  Git *pull* itself). The fix applied was a **targeted, non-recursive**
  ownership change, leaving `data/`, `backups/`, and `builds/` untouched:
  `sudo chown tuckeraa:tuckeraa /docker/arcane /docker/arcane/compose.yaml`.
  If you're deploying this fresh, check ownership before wiring up Git
  Sync, here or for any other stack.
- Arcane mounts the raw Docker socket read-write (`/var/run/docker.sock:/var/run/docker.sock`),
  not `socket-proxy` — this is a known, tracked hardening gap (see the
  top-level README), not something specific to this stack that's been
  overlooked.
- `cgroup: host` is set, which Arcane needs for accurate container resource
  stats in its UI.
