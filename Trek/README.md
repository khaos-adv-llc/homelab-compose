# Trek

Trek (`mauriceboe/trek`) is a Node.js application whose exact purpose
**isn't fully documented in this repo as of this writing** — treat that as
an open question to confirm with Tucker rather than a guess to build on.
What is clear from its compose file is that it's configured unusually
defensively for a homelab app: a read-only root filesystem, every Linux
capability dropped except `CHOWN`/`SETUID`/`SETGID`, `no-new-privileges`,
admin-credential login rather than OIDC, and its own dedicated
`ENCRYPTION_KEY` for data at rest. That combination suggests it stores
something sensitive enough to warrant hardening beyond most other stacks
in this repo — but that's an inference from its configuration, not a
confirmed fact about what it actually does.

## Prerequisites

- An existing `shared-services` Docker network.
- Generated values for `ENCRYPTION_KEY` (used for data-at-rest encryption
  — generate this once and never change it without a data-migration plan,
  since existing encrypted data won't decrypt with a different key),
  `ADMIN_EMAIL`, and `ADMIN_PASSWORD`.

## Running it standalone

Straightforward as a compose file — one container, no database dependency
visible in this file, host bind mounts for its own data
(`/docker/Trek/{data,uploads}`). Swap the network for your own, generate
your own `ENCRYPTION_KEY`/admin credentials, and update `APP_URL` and
`ALLOWED_ORIGINS` to whatever hostname you'll actually serve it from. Since
what Trek actually does isn't confirmed here, there's no further
homelab-specific guidance to give beyond "the compose file is portable" —
what matters *inside* the app once it's running is genuinely unknown from
this repo alone.

## How it fits into this homelab

- **Traefik / hostname**: intended host is `trek.external.valdeze.ch`
  (per its `APP_URL`/`ALLOWED_ORIGINS` env vars) — but **this compose file
  has no `traefik.*` labels at all**, so whether it's actually reachable
  through Traefik today is unconfirmed (see the top-level README's open
  questions, and the `./dynamic` hypothesis noted in `Traefik/README.md`).
- **Networks**: `shared-services` only.
- **Git Sync**: wired up like every other non-exempt stack.
- **Secrets**: `ENCRYPTION_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` are
  Infisical-backed via `render-env.sh`.

## Notes / gotchas

- **What Trek is actually for is genuinely unconfirmed** — don't assert a
  purpose for it in any documentation, automation, or firewall rule based
  on a guess. Ask Tucker directly if this matters for whatever you're
  building.
- The hardened container config (read-only root FS, dropped capabilities,
  `no-new-privileges`) is worth preserving as-is if this compose file is
  ever modified — it's a stronger security posture than most other stacks
  in this repo, and loosening it "to make debugging easier" would undercut
  whatever it was set up to protect.
- Uses admin-credential login (`ADMIN_EMAIL`/`ADMIN_PASSWORD`), not OIDC —
  one of the few apps in this homelab that doesn't delegate auth to
  Authentik. Whether that's a deliberate choice (e.g., Trek predates the
  OIDC rollout, or doesn't support it) or worth revisiting isn't
  documented here.
