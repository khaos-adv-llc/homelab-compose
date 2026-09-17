# YTzero

YTzero (`ghcr.io/pelski/ytzero`) is a service whose purpose is inferred
from its name (something YouTube-related) but **not independently
confirmed** — it simply wasn't included in the first batch of compose
files this repo was built from, and hasn't been documented further since.
Treat "something YouTube-related" as a reasonable guess, not a fact to
build on. It does have native OIDC login via Authentik
(`YTZERO_AUTH_MODE=oidc`), and its data directory is one of the paths
Duplicati backs up from `ServarrSuite/docker-compose.yml`
(`/docker/YTzero/data`), which at least confirms it's treated as a real,
ongoing service worth backing up.

Note: a stray, empty, lowercase `ytzero/` directory also exists on the
host alongside the real (capitalized) `YTzero/` — confirmed unused, almost
certainly a casing artifact from early setup, safe to ignore.

## Prerequisites

- An existing `shared-services` Docker network.
- Authentik configured with an OIDC application/provider for YTzero, if you
  want login to work (`YTZERO_OIDC_ISSUER`, `YTZERO_OIDC_CLIENT_ID`,
  `YTZERO_OIDC_CLIENT_SECRET`).

## Running it standalone

Simple as a compose file — one container, a bind-mounted data directory,
one Docker network. Swap `shared-services` for your own network, point the
`YTZERO_OIDC_*` variables at your own OIDC provider (or check whether the
image supports a non-OIDC auth mode if you don't have one), and update
`YTZERO_BASE_URL` to your own hostname. Because what this app actually
*does* isn't confirmed here, there's no further guidance to give about its
internal behavior or data model.

## How it fits into this homelab

- **Traefik / hostname**: intended host is `yt.valdeze.ch` (per
  `YTZERO_BASE_URL`) — but **this compose file has no `traefik.*` labels
  at all**, so its actual Traefik reachability today is unconfirmed (same
  open question as Mealie, Reactive Resume, and Trek — see the top-level
  README).
- **Networks**: `shared-services` only.
- **Git Sync**: wired up like every other non-exempt stack.
- **Secrets**: `YTZERO_OIDC_ISSUER`, `YTZERO_OIDC_CLIENT_ID`,
  `YTZERO_OIDC_CLIENT_SECRET` are Infisical-backed via `render-env.sh`.
- **Backups**: `/docker/YTzero/data` is backed up by Duplicati (living in
  `ServarrSuite/docker-compose.yml`) to the same S3 destination as
  everything else — see the top-level README's Duplicati callout.

## Notes / gotchas

- **Whether YTzero is in current active use at all isn't fully confirmed**
  — flag this rather than assuming it's a live, actively-used service (see
  the top-level README's open questions).
- `version: '3.8'` at the top of this compose file is a legacy Compose
  Specification version key that modern Docker Compose ignores (with a
  harmless warning) — every other stack in this repo omits it. Not worth
  fixing on its own, but don't copy it into a new stack's compose file.
- Runs as a fixed non-root user (`1000:1000`), like FileBrowser — adjust if
  your host's primary user isn't UID/GID 1000.
