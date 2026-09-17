# FluxerDiscordBridge

Bridges **audio** between a Discord guild voice channel and a Fluxer guild
voice channel, so a Discord community and a Fluxer community can talk to
each other live -- built to lower the friction of a community migrating to
Fluxer without forcing an all-at-once switch. Which channel is bridged on
each side is chosen **at runtime**, through one control panel, at one
public URL.

```
Discord voice channel                      Fluxer voice channel
        |                                          |
        v                                          v
  [discord-leg]  <---- UDP audio relay ---->  [fluxer-leg]
  (Node, discord.js + @discordjs/voice)       (Python, LiveKit SDK)
        ^                                          ^
        |            control API (HTTP)            |
        +------------------+  +--------------------+
                           |  |
                        [panel]
              fluxerbridge.valdeze.ch (via Pangolin)
        Discord/Fluxer OAuth2 login + live per-guild admin checks
```

This is **v1** for the audio path: one mixed audio stream in each
direction, no per-speaker identity on either side. See the full build-spec
doc (linked from project memory / the original planning conversation) for
the v2 per-speaker-identity design; per-user volume control specifically is
**not** built (v1 has no per-participant identity to attach a volume to).

## Access model (v3)

There is **one** control surface (`panel/`), at **one** public URL
(`fluxerbridge.valdeze.ch`, via Pangolin). This replaced an earlier
two-panel design (an Authentik-gated LAN admin panel + a separate public
disconnect-only panel) -- Tucker asked for a single simple front door, and
for "admin" to be based on actually administering the relevant Discord/
Fluxer server rather than a fixed Authentik group. Concretely:

- **Log in** with Discord OR Fluxer OAuth2. Either one creates or resumes
  an "account" in the panel's local database, and once logged in you can
  **link your other platform's account** to the same one (so a Discord
  admin who also has a Fluxer account can manage both sides from one
  login).
- **Nothing about being an admin is stored anywhere.** Every connect,
  disconnect, and hand-off claim asks the relevant leg's bot -- live,
  right then -- whether any of your linked identities on that platform is
  an Administrator or has Manage Server on the guild in question. There's
  no cached role, no group membership, no long-lived grant to steal or
  spoof.
- **What's stored** (`panel/db.js`, a small SQLite file) is just platform
  user IDs and display names, linked into accounts, plus hand-off-token
  records. No OAuth access or refresh tokens are ever persisted -- each
  login's token is used once, to fetch "who am I", then discarded. See
  `panel/db.js`'s top comment for why that keeps this low-stakes to store.
- **Hand-off links**: if you're logged in but not an admin of the guild
  that's (or should be) bridged, you can generate a link and send it to
  someone who is. That link carries **no authority of its own** -- it's
  just a pointer with some context ("X wants help with Y"). Whoever opens
  it still has to log in and pass the exact same live admin check as
  anyone else; claiming it just records who ended up taking over, for the
  original requester's benefit.

This is a genuine architecture change from the previous revision, not an
addition -- the old `web-panel` (Authentik/VoiceBridgeAdmin) and old
`user-panel` (OAuth + voice-channel-presence check, disconnect only) are
both **gone**, replaced by the single `panel` service described above. If
you already set up the `VoiceBridgeAdmin` Authentik group or a Proxy
Provider for this stack, that's no longer needed and can be torn down.

**Deviation from this homelab's usual naming convention, flagged
explicitly**: every other stack here uses `appname.internal.valdeze.ch` /
`appname.external.valdeze.ch`. This one uses a single bare
`fluxerbridge.valdeze.ch`, registered directly in Pangolin, because Tucker
asked for one simple public hostname rather than the internal/external
split -- there is no LAN-only route for this stack anymore.

## Prerequisites

- A registered Discord **bot** application (never a self-bot/automated user
  account -- see Notes / gotchas), invited into every Discord guild you
  want selectable, with CONNECT + SPEAK in whichever voice channels should
  be joinable, and enough access to fetch guild members (used for the live
  admin checks).
- A Fluxer **bot** application/token, authorized into every Fluxer guild
  you want selectable, with the same permissions.
- A Discord OAuth2 application (Client ID + Secret) for panel login -- can
  be the same Discord application as the bot, or a separate one.
- A Fluxer OAuth2 application (Client ID + Secret) for panel login, same
  flexibility.
- Both server admins' consent -- this stack needs a bot account with real
  voice permissions on each side, in whichever guilds you point it at.
- No GPU, no special host privileges.

## One-time setup this stack needs beyond `.env`

None of this is in compose or Infisical -- it's manual setup in each
platform's own admin UI:

1. **Discord bot + OAuth app**: Developer Portal -> your application.
   Bot tab for `DISCORD_BOT_TOKEN`. OAuth2 tab for
   `DISCORD_OAUTH_CLIENT_ID`/`DISCORD_OAUTH_CLIENT_SECRET`, and add
   `https://fluxerbridge.valdeze.ch/auth/discord/callback` to its redirect
   URIs.
2. **Fluxer bot + OAuth app**: equivalent steps in Fluxer's application
   settings (see `docs.fluxer.app/http-api/oauth2/` and
   `docs.fluxer.app/http-api/applications/`), redirect URI
   `https://fluxerbridge.valdeze.ch/auth/fluxer/callback`.
3. **Pangolin**: register `fluxerbridge.valdeze.ch` -> `panel` container :
   port `8080`, the same way AirTrail and Mealie are registered (this repo
   has no compose-label-driven Pangolin integration confirmed anywhere, so
   this is a dashboard step, not a compose change).
4. **Infisical**: create the `FluxerDiscordBridge` folder (doesn't exist
   yet) and populate all 6 real values from `.env.example`.
5. (If you previously set this stack up with the old two-panel design)
   **tear down** the `VoiceBridgeAdmin` Authentik group / Proxy Provider /
   policy binding you created for it -- no longer used.

## Running it standalone

- Complete the one-time setup above (at minimum: both bot tokens, both
  OAuth apps, `USER_PANEL_SESSION_SECRET`) and populate a real `.env`.
- `docker compose up -d --build` (all three images build from source --
  there's no prebuilt image published for this stack).
- Open `panel` (port `8080` if not using Pangolin locally), log in, and
  pick a server you admin on each side to connect.

## How it works

- **discord-leg** and **fluxer-leg** each log in/authenticate at boot and
  then sit **idle** -- they don't join any voice channel until told to.
  Each exposes a small internal-only control API: `/guilds`,
  `/guilds/:id/channels`, `/connect`, `/disconnect`, `/status`,
  `/current-members`, `/guilds/:id/members/:userId/is-admin`, and
  `/users/:userId/admin-guilds` (the last two back the panel's live
  permission checks and guild picker).
- **panel** handles Discord/Fluxer OAuth2 login itself (a small SQLite
  database for account linking, no platform tokens persisted -- see
  `panel/db.js`), and on every connect, disconnect, and hand-off claim,
  calls the relevant leg's `is-admin` endpoint live before acting.
- Once connected, audio flows exactly as the v1 design describes: each leg
  mixes/relays PCM to the other over the `bridge-relay` network's UDP ports
  (5100/5101), independent of the control plane.

## Styling

`panel/public/style.css` is styled to sit comfortably next to a real Fluxer
client. The brand colors (`#4641d9` / `#6b5ce7`), the deep near-black
background (`#0a0822`), and the font (`Radio Canada Big`) were read
directly from `fluxer.app`'s live computed styles, not guessed -- they're
Fluxer's actual design tokens. The panel/card background, borders, and
muted-text shades are this project's own extrapolation to fit a dark
app-panel layout, since Fluxer's marketing site didn't expose its
logged-in client's dark-mode panel tokens the same way -- close in spirit,
not lifted from the real client chrome. Worth revisiting with the real
values if you can pull them from `app.fluxer.app`'s devtools while logged
in.

## How it fits into this homelab

- **Networking**: `discord-leg`/`fluxer-leg` stay on the private
  `bridge-relay` network only. `panel` joins `bridge-relay` +
  `shared-services` (Pangolin's path, matching AirTrail's confirmed
  pattern) -- no `proxy_net`, no Traefik labels (see the naming-convention
  deviation called out above).
- **Secrets**: all 6 values in `.env.example` belong in Infisical's
  `FluxerDiscordBridge` folder (create it) and get rendered by
  `scripts/render-env.sh`, whose `STACKS` array already includes
  `FluxerDiscordBridge`.
- **Data**: `panel`'s SQLite file (linked-account + hand-off-token records)
  lives in the `fluxer-discord-bridge-panel-data` named volume, not
  bind-mounted -- back it up like any other stateful volume if that matters
  to you; losing it just means everyone re-links their accounts.
- **Git Sync**: not yet wired up in Arcane. This stack **builds images from
  source** -- confirm whatever redeploys it runs `docker compose up -d
  --build`.

## Notes / gotchas

- **This is a real, runnable scaffold -- not a hardened production
  service.** None of the three containers have been run against live
  Discord/Fluxer servers or real OAuth apps yet.
- **Fluxer's admin-permission check is UNCONFIRMED.**
  `fluxer-leg/bridge.py`'s `is_guild_admin` assumes a
  `GET /guilds/{id}/members/{user_id}` endpoint shaped like Discord's
  (a `permissions` bitfield or an owner/admin flag). This has not been
  verified against real Fluxer API docs or a live instance -- it fails
  closed (denies) on anything unexpected, which is the safe failure mode,
  but means "nobody can control the Fluxer side" is a plausible symptom of
  this being wrong, not evidence the whole stack is broken. Verify this
  against `docs.fluxer.app` (or a live instance's actual response shape)
  before relying on it.
- **The account-linking "merge" case is simplified, not solved.** If you
  try to link a Discord/Fluxer identity that's already tied to a different
  account here, `panel/server.js`'s `completeLogin` just switches your
  session to that other account rather than merging the two -- see its
  comment. Fine for the expected case (linking your own two accounts
  together for the first time), surprising if two different people's
  accounts collide.
- **Hand-off links are context, not authority** -- worth re-reading if
  you're auditing this for security: claiming one runs the exact same live
  admin check as every other action in this panel. If that check is wrong
  (see the Fluxer caveat above), the hand-off flow inherits that, but it
  never adds a SEPARATE way to gain control.
- **No permission pre-check on the Fluxer side's channel list** -- see the
  Fluxer-side code comments; a channel the bot can't actually join just
  fails at Connect.
- **Discord side is fully sanctioned bot API**, both for the bridge itself
  and for OAuth login -- no self-botting anywhere in this stack. Discord
  video/screen-share bridging remains explicitly out of scope for the ToS
  reasons in the build-spec doc.
- **v1 does no real per-speaker mixing on the Fluxer->Discord path** for
  multiple simultaneous Fluxer speakers, **no jitter buffer, no Gateway
  resume** -- see the bridge legs' own code comments.
- **The `livekit` Python package's `rtc` API has changed shape across
  versions** -- re-check `fluxer-leg/bridge.py` against whatever version
  actually resolves from `requirements.txt`.
- **`panel/db.js` uses `node:sqlite`**, built into Node since 22.5
  (unflagged) -- if the image's Node predates that, the panel won't boot;
  see the Dockerfile's comment.
- **UDP relay and both legs' control APIs are unauthenticated by design**
  -- neither ever leaves the `bridge-relay` network. `panel` is the only
  actually-exposed surface now, which is exactly why its live-admin-check
  correctness (and the Fluxer-side caveat above) is the thing worth taking
  seriously before relying on this for a real community.
