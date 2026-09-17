# HomeAssistant

The home automation heart of the household: [Home Assistant](https://www.home-assistant.io/)
itself, plus four closely related services that all run alongside it in
this one compose file — a Matter server (for Matter-protocol smart-home
devices), Mosquitto (an MQTT broker, the messaging protocol a lot of
smart-home gear speaks), [Scrypted](https://www.scrypted.app/) (a camera/NVR
integration hub), and [Music Assistant](https://music-assistant.io/) (a
multi-room audio/streaming controller). They're bundled together here
because they're all part of the same smart-home stack and several of them
need to discover each other and local network devices directly.

## Prerequisites

- `network_mode: host` for every service in this file — meaning **all
  five** run directly on the host's network stack, not an isolated Docker
  bridge network. This is required for mDNS/device-discovery protocols
  (Matter, MQTT-based device discovery, Scrypted's camera discovery,
  AirPlay/Chromecast for Music Assistant) to actually find devices on the
  LAN — none of it works reliably behind Docker's default NAT'd bridge
  networking.
- `homeassistant` runs `privileged: true` — needed for USB/Bluetooth/serial
  device access (Zigbee/Z-Wave dongles, etc.).
- Host directories that must exist and be correctly permissioned:
  `./homeassistant/config`, `./matter-server/data`, `./mosquitto/{config,data,log}`,
  `./scrypted`, `./music-assistant-server/data`.
- `/run/dbus` and (for Scrypted) `/var/run/avahi-daemon/socket` available
  on the host for device discovery.

## Running it standalone

This is one of the least portable stacks in this repo, precisely because
of `network_mode: host` — it assumes it *is* the host's network, full
stop. Lifting it out means accepting the same trade-off wherever you run
it: the containers will bind directly to host ports and can see (and be
seen on) your LAN the same way a native install would. Beyond that, it's
straightforward: populate the image/tag/container-name variables in
`.env.example` (several services parameterize their image reference via
env vars, e.g. `${HA_IMAGE}:${HA_TAG}`, so pin real values), point the
volumes at your own host paths, and drop the Traefik labels if you don't
have Traefik running the same way.

## How it fits into this homelab

- **Traefik / hostnames**: `homeassistant` routes
  `ha.internal.valdeze.ch`; `scrypted` routes `scrypted.internal.valdeze.ch`;
  `music-assistant-server` routes `music.internal.valdeze.ch`. `matter-server`
  and `mosquitto` have no Traefik labels — they're consumed by other
  services on the local network (or by Home Assistant itself) rather than
  browsed directly.
- **Networks**: none of these show up in a bridge-network table at all —
  `network_mode: host` means they're not attached to `MediaServer`,
  `shared-services`, or any other Docker network. Traefik still reaches
  them because it, too, effectively sees the host's network via routing —
  the labels work the same way regardless.
- **Git Sync**: wired up like every other non-exempt stack.
- **Secrets/config**: `render-env.sh` populates a genuinely long list of
  image/tag/container-name/port variables from Infisical (see
  `.env.example`) — none of these are "secret" in the sensitive-credential
  sense, but they're still centrally managed the same way as everything
  else, mostly so version pins can be changed in one place.

## Notes / gotchas

- Config lives at `./homeassistant/config` on the host, mounted to
  `/config` inside the container. **The host-side directory is likely
  root-owned or otherwise not directly editable from a normal user
  session** — edit Home Assistant's config through `docker exec
  homeassistant <command>` (or its own file editor integration/UI) rather
  than trying to hand-edit files on the host directly.
- If you're building a new automation here, this homelab already has an
  established pattern worth following: an Aqara FP2 presence sensor paired
  with adaptive lighting (brightness responding to presence/time of day) —
  ask whether a new automation should follow that same presence/brightness
  logic rather than inventing a new pattern.
- No Watchtower-style auto-update exists for any of these five services —
  image tags are pinned via env vars and updated deliberately, not
  automatically (see the top-level README's open questions on Watchtower).
