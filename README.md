# homelab-compose

Config-as-code for Tucker's self-hosted homelab at `valdeze.ch`. This
repository holds the `docker-compose.yml` (or `compose.yaml`) and
`.env.example` for every stack that runs on the homelab's Docker host — the
reverse proxy, identity provider, media stack, home automation, and a
handful of individual apps. It is the single source of truth for *what*
runs, while two independent, cooperating pipelines keep it *actually
running* on the host: [Arcane](https://github.com/getarcaneapp/arcane)
pulls compose file changes from here, and
[Infisical](https://infisical.com/) supplies the real secret values that
never touch this repo.

If you're new to this repo or to the homelab it describes, read this file
first, then the README in whichever stack folder you care about.

## Why this repo exists

Before this repo existed, every stack's compose file lived only on the
host, hand-edited over SSH, with real database passwords and API tokens
sitting in plaintext `.env` files next to them. That works fine for one
person on one box, right up until you want to know what changed and when,
roll a bad change back, or hand a stack's config to someone else without
also handing them every credential it uses. Three problems, in order of how
much they eventually hurt:

1. **No history.** A compose file edited in place has no record of what it
   looked like last week, or why a label changed.
2. **Secrets and config were the same file.** You couldn't share, back up,
   or diff a compose file without also handling its credentials.
3. **Every change was a manual SSH session.** Nothing enforced that a
   change was reviewed, or even remembered later.

This repo solves problem 1 and 2 directly, and problem 3 indirectly (a git
history is at least a paper trail, even though pushes still aren't gated by
CI here). The core idea: **compose files are config, secrets are not, and
they should never live in the same place.** Compose files (this repo,
public-ish, versioned) describe *shape*. Infisical (private, self-hosted)
holds *values*. A small script glues the two together on the host, and
Arcane's native Git Sync feature keeps the host's copy of each stack's
compose file in sync with what's committed here.

## Architecture overview

Two pipelines feed the same set of per-stack directories on the host
independently of each other — neither has to wait on the other once both
are running:

```
 GitHub (this repo)                      Infisical (self-hosted)
 ─────────────────────                   ────────────────────────
 homelab-compose/                        "Homelab" project
   AirTrail/docker-compose.yml             /AirTrail  → DB_USERNAME, ...
   Traefik/docker-compose.yml              /Traefik   → AUTHENTIK_OUTPOST_TOKEN
   ...one folder per stack...              ...one folder per stack...
          │                                          │
          │ Arcane "Git Sync"                         │ scripts/render-env.sh
          │ (pull, per project,                       │ (systemd timer, hourly,
          │  5 min poll)                              │  runs `infisical export`)
          ▼                                          ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │                     Host: /docker/<stack>/                       │
 │   docker-compose.yml   (from GitHub, via Arcane)                 │
 │   .env                 (from Infisical, via render-env.sh)       │
 │              — gitignored, never committed —                     │
 └───────────────────────────────┬───────────────────────────────────┘
                                  │ docker compose up  (Arcane-triggered,
                                  │  or manual for arcane/postgres)
                                  ▼
                     Running containers for that stack
```

Arcane owns "does the compose file on disk match GitHub." `render-env.sh`
owns "does the `.env` file on disk match Infisical." Each pipeline only
touches its own file. The one place they interact is bootstrapping a brand
new stack — Arcane's Git Sync currently fails on a project whose compose
file references a variable with no `.env` present yet
([known upstream issue](https://github.com/getarcaneapp/arcane/issues/2566)),
so `render-env.sh` has to have run at least once, for that stack, before
Git Sync is turned on for it. After that first run, both loops are free to
update independently on their own schedules.

## Why each major design decision was made

**Traefik + `socket-proxy`, not a raw Docker socket mount.** Traefik needs
to watch the Docker API to discover containers and their labels, but the
raw `/var/run/docker.sock` grants a container full control over the host's
Docker daemon — create containers, read every other container's
environment variables (including their secrets), mount arbitrary host
paths, the works. `socket-proxy` (linuxserver's image) sits between Traefik
and the real socket and exposes only a read-only, explicitly-scoped subset
of the Docker API (containers/services/networks/events/info/ping) — nothing
that lets Traefik create, exec into, or otherwise modify anything. It's a
few extra lines of compose for a real reduction in blast radius if Traefik
itself is ever compromised. Not every container that talks to the Docker
API in this homelab goes through `socket-proxy` yet (Arcane, `newt`,
Homepage, and `deunhealth` all still mount the real socket directly) — that
inconsistency is a known, tracked hardening gap, not something this repo
pretends is already solved.

**Infisical + `render-env.sh` + Arcane Git Sync, instead of secrets living
in git or baked into images.** Compose files need to reference secret
values, but a git history is forever — a secret committed once, then
"removed" in a later commit, is still sitting in the repo's history. Baking
secrets into a custom image has the same problem one layer down. Instead,
this repo only ever contains `${VARIABLE_NAME}` references and a
`.env.example` documenting what each one is for; the real values live in
Infisical, and a host-side script (`scripts/render-env.sh`) exports them
into each stack's real, gitignored `.env` file. Nothing in this repo can
leak a secret because no secret is ever in this repo.

**Per-service dedicated Postgres, not one shared instance — with one
grandfathered exception.** Nearly every stack that needs a database runs
its *own* Postgres container (AirTrail, Authentik, Mealie, Reactive Resume,
Infisical, Jellystat all do this). That means one stack's database problem
can't take down another stack's, upgrading one app's schema can't touch
anyone else's data, and a stack really is portable — its data travels with
it. The one exception is the standalone `postgres/` stack, a single shared
instance kept around only because Arcane itself depends on it
(`ARCANE_DATABASE_URL`). That's a historical dependency, not a pattern to
extend — don't point a new service at the central Postgres container; give
it its own, the way everything else here does.

**File-based Docker secrets over plaintext env vars — a migration in
progress, not a finished one.** `postgres/` (the central instance) and
`Infisical/`'s database both use Docker's `secrets:` block — a credential
lives in a file under `./secrets/`, mounted read-only into the container at
a fixed path, rather than sitting in `environment:` where it'd show up in
`docker inspect` output, process listings, and Arcane's own UI. This is
strictly better and is the pattern any new service's credentials should
follow. It is **not** yet universal: most existing stacks still pass
passwords and tokens as plain environment variables sourced from `.env`.
Migrating every stack to Docker secrets is a real, tracked backlog item,
not something to assume is already done.

**The `appname.${INTERNAL_DOMAIN}` / `appname.external.valdeze.ch` split,
and Authentik OIDC by default.** Every service that needs a hostname picks
one of two shapes: `appname.internal.valdeze.ch` for anything that should
only ever be reachable from inside the house, or `appname.external.valdeze.ch`
for anything meant to be reachable from anywhere, routed out through
Pangolin (`newt`, in `EdgeGateway/`). Splitting on hostname rather than on
network makes the intent visible in the URL itself — no one has to go
check a compose file to know whether a service is supposed to be reachable
from a coffee shop. For anything exposed via the `external` hostname,
authentication should default to OIDC (OpenID Connect — a standard way for
an app to delegate "who is this user" to a separate identity provider
instead of implementing its own login system) against Authentik at
`auth.valdeze.ch`, rather than a one-off username/password scheme per app.
Apps that can't speak OIDC natively fall back to Authentik's forward-auth
outpost (`authentik-outpost`, living in `Traefik/`) or its LDAP outpost
(`AuthentikOutpost/`). `auth.valdeze.ch` is the *only* URL for Authentik —
there's no internal-only alias, so don't invent one.

## Repo layout

| Folder | What it is |
|---|---|
| [`AdGuardHome`](./AdGuardHome/README.md) | Network-wide DNS + ad/tracker blocking |
| [`AirTrail`](./AirTrail/README.md) | Flight-tracking/travel app — the first stack migrated to Infisical-backed secrets |
| [`arcane`](./arcane/README.md) | Arcane itself, the Docker-stack management UI that Git-syncs every stack from this repo |
| [`Authentik`](./Authentik/README.md) | Authentik core (identity provider): Postgres + Redis + server + worker |
| [`AuthentikOutpost`](./AuthentikOutpost/README.md) | Authentik's LDAP outpost |
| [`Cloudflared`](./Cloudflared/README.md) | Standalone Cloudflare Tunnel container — a deliberate standby/fallback path, not the primary external-access route |
| [`EdgeGateway`](./EdgeGateway/README.md) | `newt` (Pangolin) — the primary external-access path |
| [`FileBrowser`](./FileBrowser/README.md) | Simple web file manager for the media library |
| [`HomeAssistant`](./HomeAssistant/README.md) | Home Assistant + Matter server + Mosquitto + Scrypted + Music Assistant |
| [`Infisical`](./Infisical/README.md) | Self-hosted secrets manager — the source of truth for every other stack's `.env` |
| [`Mealie`](./Mealie/README.md) | Recipe manager, OIDC via Authentik |
| [`MinecraftServer`](./MinecraftServer/README.md) | The household's Minecraft server |
| [`postgres`](./postgres/README.md) | Central, shared Postgres instance — kept only because Arcane depends on it |
| [`ReactiveResume`](./ReactiveResume/README.md) | Resume builder, own Postgres + Redis + S3 storage |
| [`ServarrSuite`](./ServarrSuite/README.md) | The full *arr/download/playback/backup stack — ~28 services, including Duplicati |
| [`scripts`](./scripts/README.md) | `render-env.sh` and the systemd unit/timer that drive it |
| [`searxng`](./searxng/README.md) | Self-hosted metasearch engine |
| [`Traefik`](./Traefik/README.md) | Traefik v3.6 + `socket-proxy` + Authentik's forward-auth outpost |
| [`Trek`](./Trek/README.md) | A hardened Node.js app (purpose not fully documented — see its README) |
| [`YTzero`](./YTzero/README.md) | A YouTube-related app, OIDC via Authentik |

## Prerequisites for the whole stack

- A Linux Docker host with Docker Engine and the Compose plugin.
- [Arcane](https://github.com/getarcaneapp/arcane) running on that host,
  with its `PROJECTS_DIRECTORY` pointed at wherever these stacks live
  (`/docker` on the real host), and its native Git Sync feature available
  (this repo assumes a build recent enough to have per-project Git Sync —
  it's a genuinely new Arcane feature, first shipped ~January 2026, so keep
  Arcane itself reasonably current).
- A reverse proxy already in place expecting to discover containers by
  Docker labels — this repo assumes Traefik (see `Traefik/`), not Nginx
  Proxy Manager (retired here) or anything else.
- Cloudflare DNS access for the domain(s) you're issuing certificates for,
  if you want Traefik's Let's Encrypt DNS-01 flow (see `Traefik/README.md`)
  — DNS-01 is a certificate-issuance method that proves domain ownership by
  creating a DNS TXT record, rather than by serving a file over HTTP, which
  is what lets Traefik issue wildcard certs without exposing port 80 to the
  world for that purpose.
- [Infisical](https://infisical.com/) (self-hosted or cloud) if you want the
  full secrets pipeline; see the bootstrap order below for why it has to be
  stood up first, by hand.
- The [Infisical CLI](https://infisical.com/docs/cli/overview) installed on
  the host, for `scripts/render-env.sh` to call.
- The Docker networks each stack expects to already exist as `external:
  true` networks — see each stack's README for which ones, and the
  Networking convention below.

## Full-stack quickstart / bootstrap order

This is a chicken-and-egg problem: Infisical can't hand out secrets for its
own deployment before it exists. The order that resolves it:

1. **Deploy Infisical the "old-fashioned" way first.** Its own database
   credentials and encryption keys are generated by hand and stored as
   file-based Docker secrets (or a root-owned, chmod-600 `.env` for values
   Infisical's own image doesn't support as Docker secrets) — never pulled
   from Infisical itself, since it can't distribute secrets before it's
   running. See `Infisical/README.md`.
2. **Create the secrets-management project.** In Infisical, create one
   project with one folder per stack, using the exact folder names this
   repo uses (matching the real on-host directory names) — plus, if you
   want to avoid repeating `PUID`/`PGID`/`TZ`/`INTERNAL_DOMAIN` in every
   stack's folder, set those as Arcane's own global Variables instead
   (Arcane resolves compose variables from global Variables, then the
   project's own `.env`, then compose defaults).
3. **Create a read-only machine identity** (Universal Auth) scoped to read
   secrets only, for `scripts/render-env.sh` to authenticate as. Store its
   client secret in a root-owned, mode-600 file on the host — never in git,
   never in a chat.
4. **Populate real secret values into Infisical by hand**, one stack at a
   time, using the variable names each stack's `.env.example` documents.
5. **Run `scripts/render-env.sh`** (optionally scoped to one stack via its
   positional args) to materialize each stack's real `.env` file next to
   where Arcane expects it. Install the accompanying systemd timer
   (`scripts/homelab-env-render.*`) so this keeps happening on a schedule
   without a human remembering to re-run it.
6. **Only then, point Arcane's Git Sync at that stack's folder** in this
   repo (Add Git Sync → link the existing project → this repo, that
   stack's subfolder, `docker-compose.yml`). Leave "Redeploy After Sync"
   off until you've watched a manual redeploy succeed a few times — Arcane's
   Git Sync is still a fairly young feature with open bugs, and rolling
   back a bad automated redeploy is a worse afternoon than doing one
   redeploy by hand.

Two stacks are permanent exceptions to step 6's automated-redeploy part:
`arcane` and `postgres` stay on Git Sync for drift-tracking (so you can
still see when the on-host compose file diverges from what's committed),
but neither ever auto-redeploys. Arcane refuses to redeploy its own compose
project outright (a deliberate upstream guard against the container killing
itself mid-redeploy and failing to come back); `postgres` is excluded on
purpose because of its blast radius — nearly every other stateful stack's
data eventually depends on Postgres being healthy, so a change there gets a
manual, watched `docker compose up -d` instead.

## Running a single component elsewhere

Every stack folder's own README says explicitly how portable it is, but the
general shape is the same everywhere:

- **You won't have Infisical.** Populate a real `.env` file by hand, using
  that stack's `.env.example` as the list of what it needs. Nothing in a
  compose file here cares whether its `.env` came from Infisical or your
  own text editor.
- **You probably won't have `shared-services` / `proxy_net` / `MediaServer`
  already defined.** Every stack's compose file declares these as
  `external: true` networks — meaning it expects them to already exist,
  created outside that compose file, so multiple stacks can share them.
  Lifting a stack out means either creating your own network(s) with those
  names, or editing the compose file's `networks:` section to point at
  whatever you do have.
- **You probably won't have Traefik + `socket-proxy` + Cloudflare DNS-01 set
  up the same way.** Either stand up an equivalent (Traefik with your own
  cert resolver), drop the `traefik.*` labels and reverse-proxy some other
  way, or just publish the service's port directly if it doesn't need to
  sit behind a proxy at all.
- **Some stacks are tightly coupled to this specific homelab and will take
  real work to separate**, not just a config tweak — anything that expects
  Authentik for auth needs *some* OIDC provider in its place; anything that
  expects the shared central `postgres` container (in practice, only
  `arcane`) needs its own database instead. Each stack's README says
  plainly when this is the case rather than pretending everything is
  trivially portable.

## Known open / unconfirmed items

These are flagged here deliberately rather than asserted as settled fact —
they're genuinely open as of this writing, and worth checking with Tucker
directly before building on top of any of them:

- **n8n, YTzero, and Nextcloud** — whether n8n and YTzero are in current
  active use isn't fully confirmed here (Nextcloud has been separately
  confirmed decommissioned, its Docker network just hasn't been cleaned up
  yet). Don't assume any of the three's current status without asking.
- **Watchtower** — no Watchtower-style auto-updater exists in any compose
  file in this repo as of this writing. Nothing here auto-updates itself;
  don't assume any service will pick up a new image on its own.
- **`ha.khaosadv.com`** — this domain doesn't appear in Home Assistant's
  compose file (which routes `ha.internal.valdeze.ch` via Traefik instead).
  Whether it's still a live external entry point (e.g. DDNS/port-forward),
  retired, or a mix-up in older notes isn't confirmed.
- **Mealie's Traefik reachability — resolved.** Its `traefik.*` labels are
  commented out on purpose: Tucker confirmed (Sept 17, 2026) he reaches it
  at `meals.valdeze.ch` via Pangolin and deliberately dropped internal
  Traefik access because it was clunky for phone/computer apps. Treat
  Mealie as intentionally Pangolin-only, not an unrouted app.
- **Reactive Resume's Traefik reachability — still unconfirmed.** Its
  `traefik.*` labels are commented out in its real compose file in this
  repo (a separate, fully-commented-out duplicate service block does have
  labels, but the active block does not). Whether that's intentional
  (routed some other way, e.g. Traefik's `./dynamic` file provider) or an
  oversight isn't confirmed — don't assume it's actually reachable through
  Traefik today.
- **Pangolin vs. Cloudflare Tunnel** — current understanding is that
  Pangolin (`newt`, in `EdgeGateway/`) is the primary path for
  `*.external.valdeze.ch` services, and the standalone Cloudflare Tunnel in
  `Cloudflared/` is a deliberate standby/fallback kept running in case
  Pangolin has trouble with a particular service — not a competing or
  partially-used primary route. Treat this as the current understanding,
  not an eternal fact, if it comes up again later.

## Why is Duplicati inside `ServarrSuite/`?

Duplicati isn't its own top-level stack in this repo, even though it backs
up nearly everything. It's one service defined inside
`ServarrSuite/docker-compose.yml`, alongside the rest of the media stack.
The pattern: one Duplicati container, with one read-only bind mount per
stack under `/source/<name>` (e.g. `/source/sonarr`, `/source/authentik/data`,
`/source/Infisical`), and one backup job per stack inside Duplicati's own
job configuration — all going to the same S3-compatible destination. If
you're looking for how a given stack's backups are configured, check
Duplicati's mounts and job list in `ServarrSuite/docker-compose.yml`, not a
`Duplicati/` folder that doesn't exist. Adding a newly-deployed stack to
backup coverage means adding its source mount and job explicitly here — it
isn't automatic just because the stack exists under `/docker`.

## Pre-commit secret scanning

Before pushing, run [gitleaks](https://github.com/gitleaks/gitleaks)
against this repo (config already in `.gitleaks.toml`):

```
gitleaks detect --source . -v
```

and wire `gitleaks protect --staged -v` in as a pre-commit hook, so a real
secret can't land in a commit by accident. This matters more than usual
here specifically because every stack's `.env.example` is meant to be
edited by hand from time to time (documentation, new variables) — always
double-check a diff to `.env.example` contains a variable *name* and a
comment, never a real value.
