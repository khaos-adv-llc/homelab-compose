# scripts

This folder isn't an app stack like the other 18 folders in this repo —
it's the tooling that keeps every stack's real `.env` file in sync with
Infisical. Three files:

- **`render-env.sh`** — the actual renderer. Authenticates to Infisical as
  a read-only machine identity (Universal Auth), then for each stack, runs
  `infisical export --format=dotenv` scoped to that stack's folder in
  Infisical and writes the result to `/docker/<stack>/.env` on the host
  (mode `600`, owned by the host's primary user).
- **`homelab-env-render.service`** — a systemd oneshot unit that runs
  `render-env.sh` once.
- **`homelab-env-render.timer`** — a systemd timer that fires the service
  on a schedule (5 minutes after boot, then hourly, with `Persistent=true`
  so a missed run while the host was off still fires once it's back up).

## Why this exists

Arcane's Git Sync keeps each stack's `docker-compose.yml` current from
GitHub, but a compose file on its own is useless if the `.env` file it
references doesn't exist or is stale — and Arcane's Git Sync currently
fails outright on a project whose compose file references a variable with
no local `.env` present at all
([known upstream issue](https://github.com/getarcaneapp/arcane/issues/2566)).
`render-env.sh` is the piece that makes sure a real `.env` exists on disk
*before* Arcane ever needs one, and keeps refreshing it afterward so a
secret rotated in Infisical actually reaches the running stack.

## How `render-env.sh` works

```
./render-env.sh                    # render every stack listed in STACKS
./render-env.sh SearXNG AirTrail   # render only the named stack(s)
```

- Requires the [Infisical CLI](https://infisical.com/docs/cli/overview)
  installed on the host, and a machine identity's client secret at
  `/docker/.infisical/client-secret.txt` (root-owned, mode 600, never in
  git).
- `REPO_ROOT` (default `/docker`) can be overridden to point at a scratch
  directory instead — useful for a dry run before pointing it at the real
  host tree:
  ```
  sudo REPO_ROOT=/tmp/render-env-test ./render-env.sh
  ```
- The `STACKS` array hardcodes the 18 real stack folder names (matching
  this repo's layout, Infisical's folder layout, and the real
  `/docker/<Name>` directory names on the host — all three are kept in
  sync deliberately). Passing stack names as positional arguments
  restricts a run to just those stacks, validated against the known list
  so a typo fails loudly rather than silently doing nothing.
- A stack with no real secrets (e.g. `postgres`, `AdGuardHome`, `FileBrowser`,
  `searxng`) still renders — just an empty or near-empty `.env` — which is
  harmless and keeps every stack's render step identical.
- On failure for a given stack, the script leaves that stack's existing
  `.env` untouched (logs a warning) rather than overwriting it with a
  half-written or empty file — a transient Infisical outage shouldn't be
  able to break a stack that was working fine a moment ago.

## Installing the systemd unit + timer

```bash
# Adjust ExecStart in the .service file first if this repo isn't checked
# out at /home/tuckeraa/homelab-compose on your host.
sudo cp scripts/homelab-env-render.service /etc/systemd/system/
sudo cp scripts/homelab-env-render.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now homelab-env-render.timer

# Verify it's scheduled:
systemctl list-timers homelab-env-render.timer

# Run it once immediately rather than waiting for the timer:
sudo systemctl start homelab-env-render.service
journalctl -u homelab-env-render.service -n 50
```

## Notes / gotchas

- **The `ExecStart` path in `homelab-env-render.service` must match where
  this repo is actually cloned on your host** — a hardcoded, unadjusted
  path here fails with `status=203/EXEC` (systemd's code for "executable
  not found") the moment the timer fires, and that failure won't be
  obvious until you check `systemctl status`/`journalctl` directly.
- **Restarting the *timer* does not force the *service* to run
  immediately.** Both `OnBootSec` (boot-relative, likely already elapsed by
  the time you're troubleshooting) and `OnUnitActiveSec` (relative to the
  service's own last run) mean a timer restart alone won't re-trigger a
  fresh run — use `systemctl start homelab-env-render.service` directly to
  force one.
- This script is a **single point of failure** for every stack's secrets
  freshness — if Infisical or the machine identity's token has a problem,
  affected stacks simply keep their last-successfully-rendered `.env`
  (safe, just potentially stale) rather than being left without one. Worth
  a monitoring widget on Infisical's own health if you're building out
  Homepage further.
- Requires the running user to be able to write to `/docker/<stack>/`
  (see the ownership gotchas called out in `arcane/README.md` and
  `postgres/README.md`) — a root-owned stack directory will cause this
  script's own writes to fail, separately from any Arcane Git Sync issue.
