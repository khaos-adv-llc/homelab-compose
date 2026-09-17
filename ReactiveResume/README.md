# ReactiveResume

[Reactive Resume](https://rxresu.me/) is a free, open-source resume/CV
builder — build a resume in a web UI, export it, share a public link.
This deployment runs its own Postgres and Redis, and uses S3-compatible
object storage (MEGA S4, a Mega.io S3-compatible offering) for storing
resume assets rather than local disk.

## Prerequisites

- An existing `reactive_resume_network` Docker network — this stack's
  Postgres, Redis, and app container are all only on this one network
  (Traefik and `newt` also attach to it externally to reach this stack).
- A set of S3-compatible credentials (access key, secret, bucket, region,
  endpoint) — see `.env.example`.
- An OAuth/OIDC provider for login — the env vars are generically named
  (`OAUTH_PROVIDER_NAME`, `OAUTH_DISCOVERY_URL`, etc.) rather than
  Authentik-specific, though Authentik is the likely provider in this
  homelab (unconfirmed — see the gotcha below).

## Running it standalone

Fairly self-contained: its own Postgres and Redis ship in the same compose
file, so the only real external dependencies are an S3-compatible bucket
and an OAuth/OIDC provider. Swap `reactive_resume_network` for your own
network, point the `OAUTH_*` variables at whatever identity provider you
use, and bring your own S3-compatible storage (any provider implementing
the S3 API works, not just MEGA S4).

## How it fits into this homelab

- **Traefik / hostname**: intended host is `resume.${DOMAIN}` (`DOMAIN`
  defaults to `valdeze.ch` in `.env.example`) — but **the enabled service
  block in this compose file has no Traefik labels at all**. A second,
  fully-commented-out duplicate `reactive_resume` service block *does*
  have Traefik labels, suggesting the labels were meant to move to the
  active block at some point but that migration wasn't finished (or was
  deliberately deferred) — see the gotcha below.
- **Networks**: `reactive_resume_network` for all three of its own
  services (Postgres, Redis, app).
- **Git Sync**: wired up like every other non-exempt stack.
- **Secrets**: `POSTGRES_PASSWORD`, `AUTH_SECRET`, `ENCRYPTION_SECRET`, the
  full `OAUTH_*` block, and the S3 credential block are all
  Infisical-backed via `render-env.sh`.

## Notes / gotchas

- **This stack's actual Traefik reachability today is unconfirmed** — the
  live, enabled service block has no `traefik.*` labels, only a disabled
  duplicate block does. Don't assume `resume.valdeze.ch` currently
  resolves to this container without checking Traefik's routing directly
  (or, per the top-level README's open questions, whether Traefik's
  `./dynamic` file provider is doing this routing instead).
- The disabled duplicate block's Traefik labels have their own internal
  bug worth knowing about if you ever un-comment it: one label reads
  `traefik.http.routers.prowlarr.tls=true` — a copy-paste leftover
  referencing Prowlarr's router name instead of `reactive-resume`'s. Fix
  that mismatch if you ever restore this block rather than assuming it was
  intentional.
- `NEXTAUTH_URL_INTERNAL=http://127.0.0.1:3000` is set specifically to
  avoid a WAN-loop timeout (the app calling back out to its own public URL
  and looping through the whole external routing path unnecessarily) — keep
  this if you're troubleshooting slow internal auth callbacks rather than
  removing it as apparently redundant.
- The generic `OAUTH_*` naming makes it likely, but not confirmed, that
  Authentik is the actual provider behind this — worth confirming before
  assuming it behaves identically to Mealie's native Authentik OIDC
  integration.
