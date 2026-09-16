# homelab-compose

Source-of-truth repo for the valdeze.ch homelab's Docker Compose stacks. The
full migration plan (architecture, research findings, rollout phases) lives
in the HomeLab claude.ai project as `github-infisical-migration-plan.md` --
read that first. Short version of how the pieces fit:

- **This repo** holds every stack's `docker-compose.yml` and an
  `.env.example` documenting which variables it needs. No real secret ever
  belongs here -- see `.gitignore` and `.gitleaks.toml`.
- **Arcane** (already running on the host, `PROJECTS_DIRECTORY: /docker`)
  pulls each folder here via its native Git integration and redeploys from
  it.
- **Infisical** (self-hosted, see `Infisical/`) holds every real secret
  value. `scripts/render-env.sh` runs on the host, exports each stack's
  secrets to its actual `.env` file (gitignored, never committed), and must
  run **before** Arcane's first Git sync for a given stack -- Arcane's Git
  sync currently fails if a compose file references a variable and no `.env`
  exists yet locally
  ([known issue](https://github.com/getarcaneapp/arcane/issues/2566)).

## Layout

One folder per stack, matching the real `/docker/<AppName>` names on the
host **exactly** -- these folder names were corrected on Sept 16, 2026 to
match what `tree -L 2 /docker` plus a couple of targeted `grep`s actually
confirmed (they were originally scaffolded as kebab-case guesses before that
check happened; see `github-infisical-migration-plan.md`'s Sept 16 finding
for the full story). Casing is a genuine mix of PascalCase and lowercase on
the host, not a typo here:

| Folder | What it is |
|---|---|
| `Traefik/` | Traefik v3.6 + `socket-proxy` + the Authentik forward-auth outpost (confirmed via grep to live in this same compose file) |
| `EdgeGateway/` | `newt` (Pangolin external access) -- confirmed Sept 16, 2026 to be its own stack, separate from Traefik |
| `Cloudflared/` | Standalone Cloudflare Tunnel container |
| `AuthentikOutpost/` | Authentik's LDAP outpost (confirmed via its image, `ghcr.io/goauthentik/ldap`) |
| `Authentik/` | Authentik core app: Postgres + Redis + server + worker + daily pg backup sidecar |
| `postgres/` | Central Postgres (already uses file-based Docker secrets) |
| `arcane/` | Arcane itself |
| `ServarrSuite/` | The full *arr/download/playback stack (gluetun, sonarr, radarr, jellyfin, dispatcharr, homepage, duplicati, etc. -- ~28 services in one compose file, as in the original) |
| `HomeAssistant/` | Home Assistant + Matter server + Mosquitto + Scrypted + Music Assistant (all `network_mode: host`) |
| `Mealie/`, `ReactiveResume/`, `Trek/`, `YTzero/`, `AirTrail/`, `searxng/` | Individual apps |
| `AdGuardHome/`, `FileBrowser/`, `MinecraftServer/` | Individual apps, no secrets |
| `Infisical/` | Infisical's own self-hosted deployment (bootstrapped manually first -- see below; actually deployed Sept 16, 2026) |
| `scripts/` | The host-side secret-rendering script + systemd unit/timer |

Two stacks -- **Mealie** and **Reactive Resume** -- have their Traefik labels
commented out in the compose files exactly as given; that's carried over
as-is rather than "fixed," per the brief's Open Questions (unconfirmed
whether that's intentional or an oversight).

## Bootstrap order (read this before touching anything)

1. Deploy `Infisical/` the old-fashioned way first -- its own DB credentials
   as file-based Docker secrets (matching the `postgres` pattern),
   **not** pulled from Infisical itself, since it can't hand out secrets
   before it exists. See `Infisical/.env.example` for what to generate.
   **Done Sept 16, 2026** -- deployed and reachable at
   `infisical.internal.valdeze.ch`, on its own dedicated Postgres + Redis. In
   practice the backend itself doesn't read Docker secrets files directly
   (only its Postgres container does), so `ENCRYPTION_KEY`/`AUTH_SECRET`/
   `DB_CONNECTION_URI` ended up in a root-owned, chmod-600 `.env` instead --
   see the migration plan doc for the full writeup, including a couple of
   real gotchas hit along the way (a `traefik.docker.network` pin needed
   because the backend sits on two networks, and generating the Postgres
   password with `openssl rand -hex` rather than `-base64` to avoid a `/`
   breaking the connection URI).
2. In Infisical, create the "Homelab" project, one folder per stack
   (matching this repo's layout -- **done Sept 16, 2026**, all 18 folders
   created using the real host names above), plus a `shared` folder for
   `PUID`/`PGID`/`TZ`/`INTERNAL_DOMAIN` -- or set those as Arcane's own
   *global Variables* instead, since Arcane resolves compose variables from
   global Variables, then the project's `.env`, then compose defaults; that
   avoids repeating the same four values in every stack.
3. Create a machine identity (Universal Auth) scoped read-only, for
   `scripts/render-env.sh` to use. Its client secret goes in
   `/docker/.infisical/client-secret.txt` on the host (mode 600), never in
   git. **Not yet done.**
4. Populate real secret values into Infisical by hand (never through git,
   never through a chat) using the variable names in each stack's
   `.env.example`.
5. Run `scripts/render-env.sh` once per stack to materialize its real `.env`
   next to where Arcane expects it (`/docker/<stack>/.env`).
6. Only then point Arcane's Git sync at that stack's folder in this repo.

## Pilot first

Per the migration plan: start with a low-risk stack (`searxng/` or
`AirTrail/`), not `Traefik/`, `postgres/`, or `AuthentikOutpost/`. Validate
the full loop (Infisical -> rendered `.env` -> Arcane pull -> redeploy ->
healthy container -> rollback via `git revert`) before doing anything with
the stacks everything else depends on. Keep the old "edit compose on host,
`docker compose up` by hand" path as a fallback per-stack until each one's
pilot period is over -- Arcane's native Git sync is a genuinely new feature
(shipped ~January 2026) with open bugs.

## Pre-commit secret scanning

Before your first `git push`, install and run gitleaks against this repo
(config in `.gitleaks.toml`):

```
gitleaks detect --source . -v
```

and wire `gitleaks protect --staged -v` in as a pre-commit hook so a real
secret can never land in a commit by accident.
