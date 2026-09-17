# searxng

[SearXNG](https://docs.searxng.org/) is a self-hosted, privacy-respecting
metasearch engine — it queries other search engines on your behalf and
aggregates the results, so no single upstream search provider sees your
queries directly tied to your identity. This deployment pairs SearXNG's
`core` service with [Valkey](https://valkey.io/) (an open-source Redis
fork) as its cache backend.

This is one of the two stacks used as a **pilot** for the Infisical/Arcane
migration pipeline (alongside AirTrail) — specifically chosen as a useful
complementary test case because it has effectively no real secrets, and
uses `env_file:` interpolation rather than AirTrail's implicit top-level
`.env` interpolation, validating that `render-env.sh`'s output works
correctly under both mechanisms.

## Prerequisites

- An existing `shared-services` Docker network.
- Nothing else — SearXNG's real configuration lives in
  `./core-config/settings.yml`, a bind-mounted config directory, not in
  environment variables. The `.env.example` here is entirely optional,
  commented-out overrides.

## Running it standalone

Very portable. SearXNG's own [installation docs](https://docs.searxng.org/admin/installation-docker.html)
are the best reference for configuration beyond what's in this compose
file. Swap `shared-services` for your own network (or expose it directly
via the commented-out `ports:` section if you don't want it behind a
reverse proxy at all), and adjust `./core-config/` to your own SearXNG
settings.

## How it fits into this homelab

- **No Traefik labels in this compose file** — reachability through
  Traefik, if any, isn't defined here. No port is published either (the
  `ports:` section is fully commented out), so as deployed, this stack is
  reached only via its Docker network, by whatever else is set up to route
  to it.
- **Networks**: `shared-services` for both `core` and `valkey`.
- **Git Sync**: wired up and validated as one of the two pilot stacks —
  Auto Sync on, Redeploy After Sync left off initially per this repo's
  general rollout caution, then confirmed working via manual redeploy.
- **Secrets**: effectively none — `.env.example` is entirely commented-out
  optional overrides (`SEARXNG_VERSION`, `SEARXNG_HOST`, `SEARXNG_PORT`).
  `render-env.sh` still renders a near-empty `.env` for this stack for
  consistency with the rest of the `STACKS` array.

## Notes / gotchas

- Uses `env_file: ./.env` rather than the implicit top-level `.env`
  interpolation most other stacks in this repo rely on — functionally
  equivalent for this repo's purposes (both follow the same
  quote-stripping, no-`export`-keyword parsing rules per the Compose
  Specification), but worth knowing if you're comparing this stack's
  compose file structure to another's.
- The volume mount `./core-config/:/etc/searxng/:Z` includes an SELinux
  relabeling flag (`:Z`) — harmless on a non-SELinux host (most Ubuntu-style
  Docker hosts, including this one), but worth knowing what it does if
  you're porting this compose file to an SELinux-enforcing host (e.g.
  Fedora/RHEL-based).
