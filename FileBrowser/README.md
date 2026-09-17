# FileBrowser

[Filebrowser](https://github.com/filebrowser/filebrowser) is a simple,
lightweight web-based file manager. In this homelab it's pointed at the
media library (`/home/tuckeraa/media`) for quick browsing/management
through a browser, without needing SSH or a full file-sync client. It's
deliberately simpler than the media stack's own `filestash` (see
`ServarrSuite/`) — both exist side by side, apparently for different
preferences/use cases rather than one replacing the other.

## Prerequisites

- An existing `MediaServer` Docker network.
- The host media directory (`/home/tuckeraa/media`) to exist and be
  readable/writable by UID/GID `1000:1000`, since the container runs as
  that user explicitly.
- A `./database.db` file next to the compose file — Filebrowser's own
  SQLite database, must exist as a file (even empty) before first start for
  the bind mount to work as a file rather than a directory.

## Running it standalone

Very portable — one container, no secrets, no dependency on any other
stack. Point the `/home/tuckeraa/media:/srv` bind mount at whatever
directory you actually want to browse, and adjust the `user: "1000:1000"`
line if your host uses different UID/GIDs. No `.env` is needed at all (see
`.env.example`).

## How it fits into this homelab

- **No Traefik labels** — reached directly at `<host-ip>:8085`, not via a
  `*.internal.valdeze.ch` hostname.
- **Networks**: `MediaServer` only.
- **Git Sync**: wired up like every other non-exempt stack.
- **Secrets**: none — `render-env.sh` still renders an empty `.env` for
  consistency with the rest of the `STACKS` array, but there's nothing in
  Infisical for this stack.

## Notes / gotchas

- No authentication is layered on top by Traefik/Authentik here since
  there are no Traefik labels at all — access control is whatever
  Filebrowser's own built-in login provides, and reachability is limited to
  whoever can reach `<host-ip>:8085` directly (i.e., LAN-only in practice,
  since it isn't routed externally).
- Runs as a fixed non-root user (`1000:1000`) rather than `PUID`/`PGID` env
  vars like most LinuxServer.io images in this homelab — if the host's
  primary user isn't UID/GID 1000, this needs to be changed explicitly
  rather than assumed to auto-adjust.
