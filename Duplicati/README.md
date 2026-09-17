# Duplicati

[Duplicati](https://duplicati.com) (via the `lscr.io/linuxserver/duplicati`
image) does scheduled, encrypted, incremental backups of every service's
config volume across the homelab -- the actual settings/database/history for
each *arr app, Jellyfin, Overseerr, Authentik, Infisical, YTzero, etc. This
is what makes the whole homelab recoverable if the host is lost; media
libraries themselves are not backed up here (they're re-downloadable), only
configuration and state.

Split out of `ServarrSuite/docker-compose.yml` (previously its "10. BACKUPS"
section) into its own stack so it can be tracked and redeployed
independently of the media stack it backs up.

## Prerequisites

- An existing `MediaServer` Docker network (`external: true` in the compose
  file -- this stack expects it to already exist, not create it). Traefik
  also sits on `MediaServer` and reaches this container by name.
- Two secret values: the web UI login password and a settings-encryption key
  (see `.env.example`).
- Every source directory this backs up must actually exist at the absolute
  host path the compose file references (mostly `/docker/ServarrSuite/<name>`,
  plus `/docker/Authentik/...`, `/docker/YTzero/data`, `/docker/Infisical`) --
  a missing path just means that one source silently doesn't appear as a
  backup set option, not a startup failure.

## Running it standalone

Not really portable as-is -- most of its value (and most of its `volumes:`
block) is host-specific absolute paths into other stacks' config
directories. To run it elsewhere you'd need to:

- Point every `/source/<name>` mount at wherever the corresponding stack's
  config actually lives on your host.
- Populate `.env` with `DUPLICATI_WEBUI_PASSWORD` and
  `DUPLICATI_SETTINGS_ENCRYPTION_KEY` (generate the latter with
  `openssl rand -hex 32`).
- Configure the actual backup job(s) -- schedule, retention, and a remote
  destination (rclone remote, S3, B2, etc.) -- through Duplicati's web UI
  after first start. Nothing is scheduled by default; a fresh container has
  empty job history.

## How it fits into this homelab

- **Traefik / hostname**: `duplicati.internal.valdeze.ch`, LAN-only (no
  `external.valdeze.ch` router -- this shouldn't be reachable off-LAN).
- **Networks**: `MediaServer` only. All the `/source` mounts are host
  bind-mounts, not container-to-container traffic, so this doesn't need to
  share a network with anything it backs up -- it only needs `MediaServer`
  so Traefik can reach its web UI.
- **Config/backup volumes**: `./config` (job definitions, history, the
  Duplicati SQLite database) and `./backups` (local backup destination, if
  used) live at `/docker/Duplicati/config` and `/docker/Duplicati/backups`
  on the host -- moved here intact from `/docker/ServarrSuite/duplicati/`
  during the split, not recreated from scratch, so existing job history
  survived the migration.
- **Git Sync**: registered as its own Arcane Git Sync project, Auto Sync on,
  Redeploy off (per this repo's standing convention -- redeploy is turned on
  manually, stack by stack, only after watching a few successful pulls).
- **Secrets**: Infisical-backed. `DUPLICATI_WEBUI_PASSWORD` and
  `DUPLICATI_SETTINGS_ENCRYPTION_KEY` live in Infisical's `Duplicati` folder,
  and `render-env.sh` renders them into `/docker/Duplicati/.env`.

## Notes / gotchas

- **No YAML anchor.** `ServarrSuite/docker-compose.yml` shares a
  `PUID`/`PGID`/`TZ`/`UMASK` block across services via a `x-env-common` YAML
  anchor. Anchors don't work across separate compose files, so this stack
  spells those four out explicitly in its own `environment:` block instead.
- **Absolute vs. relative source paths.** The original `ServarrSuite`
  version of this service used `./sonarr:/source/sonarr:ro`-style relative
  mounts, which resolved against `/docker/ServarrSuite/` (where that compose
  file lived). Moved verbatim into this stack's directory, those same
  relative paths would resolve against `/docker/Duplicati/` instead and
  silently point at nothing -- so every mount that's still backing up
  something in `ServarrSuite` uses an absolute `/docker/ServarrSuite/<name>`
  path here. Only `./config` and `./backups` stay relative, since those two
  actually moved with the container.
- If you add a new stack later and want Duplicati to back up its config too,
  add a new `/source/<name>:ro` mount here pointing at that stack's real
  host config path -- it won't show up automatically.
