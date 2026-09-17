"""Fluxer leg of the Fluxer <-> Discord voice bridge.

v1 scope: authenticate a Fluxer bot once at boot, then sit idle until told
-- over this container's local control API (consumed by ../panel/) --
which guild voice channel to join. Only long-lived credentials
(FLUXER_BOT_TOKEN, FLUXER_INSTANCE_URL) are static config; guild/channel
selection is runtime, not baked into .env. No per-participant identity in
v1 -- see the build spec doc, section 2/6, for the v2 design.

This is a real, runnable scaffold, not a hardened production bot. Two
things specifically worth re-checking against the installed `livekit`
package version before relying on this: the exact rtc.AudioSource/
AudioStream/AudioFrame API shape (LiveKit's Python SDK has changed these
signatures across versions) and the Gateway reconnect/resume behavior
(this scaffold reconnects from scratch on drop rather than implementing
the Gateway's resume opcode). The control API is unauthenticated by
design -- it never leaves the docker-compose internal network (see
docker-compose.yml).
"""

import asyncio
import json
import os
import socket
import sys

import aiohttp
import websockets
from aiohttp import web
from livekit import rtc

FLUXER_INSTANCE_URL = os.environ.get("FLUXER_INSTANCE_URL", "https://fluxer.app")
FLUXER_BOT_TOKEN = os.environ["FLUXER_BOT_TOKEN"]

DISCORD_LEG_HOST = os.environ.get("DISCORD_LEG_HOST", "discord-leg")
DISCORD_LEG_UDP_PORT = int(os.environ.get("DISCORD_LEG_UDP_PORT", "5101"))
FLUXER_LEG_UDP_PORT = int(os.environ.get("FLUXER_LEG_UDP_PORT", "5100"))
CONTROL_PORT = int(os.environ.get("CONTROL_PORT", "5103"))

SAMPLE_RATE = 48000
CHANNELS = 2
FRAME_MS = 20
SAMPLES_PER_FRAME = SAMPLE_RATE // 1000 * FRAME_MS  # per channel


class FluxerGateway:
    """Fluxer Gateway client: Identify, heartbeat, and voice placement
    (Voice State Update / Voice Server Update)."""

    def __init__(self, gateway_url: str, token: str):
        self.gateway_url = gateway_url
        self.token = token
        self.ws = None
        self.heartbeat_interval = None
        self.last_sequence = None
        self.ready_event = asyncio.Event()
        self.pending_grant: asyncio.Future | None = None

    async def connect(self):
        self.ws = await websockets.connect(f"{self.gateway_url}?v=1&encoding=json")

        hello = json.loads(await self.ws.recv())
        assert hello["op"] == 10, f"expected Hello (op 10), got {hello}"
        self.heartbeat_interval = hello["d"]["heartbeat_interval"] / 1000

        await self.ws.send(json.dumps({
            "op": 2,
            "d": {
                "token": self.token,
                "properties": {
                    "os": "linux",
                    "browser": "fluxer-discord-bridge",
                    "device": "docker",
                },
            },
        }))

        asyncio.create_task(self._heartbeat_loop())
        asyncio.create_task(self._read_loop())

    async def _heartbeat_loop(self):
        while True:
            await asyncio.sleep(self.heartbeat_interval)
            try:
                await self.ws.send(json.dumps({"op": 1, "d": self.last_sequence}))
            except websockets.ConnectionClosed:
                return

    async def _read_loop(self):
        async for raw in self.ws:
            msg = json.loads(raw)
            if msg.get("s") is not None:
                self.last_sequence = msg["s"]
            if msg["op"] != 0:
                continue

            event_name = msg.get("t")
            data = msg.get("d")

            if event_name == "READY":
                print("Fluxer gateway ready")
                self.ready_event.set()
            elif event_name == "VOICE_SERVER_UPDATE":
                if self.pending_grant is not None and not self.pending_grant.done():
                    self.pending_grant.set_result(data)

    async def join_voice_channel(self, guild_id: str, channel_id: str) -> dict:
        """Sends Voice State Update and awaits the resulting grant."""
        self.pending_grant = asyncio.get_event_loop().create_future()
        await self.ws.send(json.dumps({
            "op": 4,
            "d": {
                "guild_id": guild_id,
                "channel_id": channel_id,
                "connection_id": None,
                "self_mute": False,
                "self_deaf": False,
                "self_video": False,
                "self_stream": False,
            },
        }))
        return await asyncio.wait_for(self.pending_grant, timeout=15)

    async def leave_voice_channel(self, guild_id: str, connection_id: str):
        # Null channel_id + a connection_id, in a guild -> drops that
        # connection (per the Gateway commands doc's placement table).
        await self.ws.send(json.dumps({
            "op": 4,
            "d": {
                "guild_id": guild_id,
                "channel_id": None,
                "connection_id": connection_id,
                "self_mute": False,
                "self_deaf": False,
                "self_video": False,
                "self_stream": False,
            },
        }))


class Bridge:
    """Owns the current (at most one, in v1) LiveKit room connection and
    the UDP relay to/from the discord-leg container."""

    def __init__(self, gateway: FluxerGateway, http_session: aiohttp.ClientSession, api_base: str):
        self.gateway = gateway
        self.http = http_session
        self.api_base = api_base  # endpoints.api_public + /v1
        self.current: dict | None = None  # {guild_id, channel_id, guild_name, channel_name, connection_id}
        self._room: rtc.Room | None = None
        self._source: rtc.AudioSource | None = None
        self._udp_out = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._udp_in: socket.socket | None = None
        self._pump_task: asyncio.Task | None = None

    def _headers(self) -> dict:
        return {"Authorization": f"Bot {FLUXER_BOT_TOKEN}"}

    async def list_guilds(self) -> list:
        async with self.http.get(f"{self.api_base}/users/@me/guilds", headers=self._headers()) as resp:
            resp.raise_for_status()
            guilds = await resp.json()
        return [{"id": g["id"], "name": g["name"]} for g in guilds]

    async def is_guild_admin(self, guild_id: str, user_id: str) -> bool:
        """Consumed by the panel's live admin gate for connect/disconnect/
        hand-off-claim -- the Discord-side equivalent is discord-leg's
        isGuildAdmin, backed by a well-documented permissions API.

        CONFIRMED against the real Fluxer API (Sept 17 2026): the member
        object (GET /guilds/{guild_id}/members/{user_id}) has NO
        permissions/is_owner/owner field at all -- it only returns
        {user, nick, roles: [role_id, ...], ...}. Admin status instead
        comes from the GUILD object: GET /guilds/{guild_id} returns
        `owner_id` (the owner is always admin) plus an inline `roles`
        array, each role carrying its own Discord-style `permissions`
        bitfield string. A member is admin if they own the guild, or if
        any role they hold -- including the implicit @everyone role,
        whose id equals the guild id -- has ADMINISTRATOR (0x8) or
        MANAGE_GUILD (0x20) set. Permission values can exceed 32 bits
        (seen "137543147073" on @everyone in a real guild), so these are
        parsed as plain Python ints, never masked to 32 bits. Fails
        CLOSED (returns False) on any unexpected response shape or
        error, rather than guessing "yes".
        """
        ADMINISTRATOR = 0x8
        MANAGE_GUILD = 0x20
        try:
            async with self.http.get(
                f"{self.api_base}/guilds/{guild_id}", headers=self._headers()
            ) as resp:
                if resp.status != 200:
                    return False
                guild = await resp.json()

            if str(guild.get("owner_id")) == str(user_id):
                return True

            role_perms = {
                str(r["id"]): int(r.get("permissions") or 0)
                for r in guild.get("roles", [])
            }

            async with self.http.get(
                f"{self.api_base}/guilds/{guild_id}/members/{user_id}", headers=self._headers()
            ) as resp:
                if resp.status != 200:
                    return False
                member = await resp.json()
        except Exception as exc:  # noqa: BLE001 -- fail closed, never raise into the caller
            print(f"warning: is_guild_admin check failed for user {user_id} in guild {guild_id}: {exc}")
            return False

        member_role_ids = set(member.get("roles") or [])
        member_role_ids.add(str(guild_id))  # implicit @everyone role, id == guild id

        bits = 0
        for role_id in member_role_ids:
            bits |= role_perms.get(str(role_id), 0)

        return bool(bits & ADMINISTRATOR) or bool(bits & MANAGE_GUILD)

    async def list_admin_guilds(self, user_id: str) -> list:
        guilds = await self.list_guilds()
        results = []
        for g in guilds:
            if await self.is_guild_admin(g["id"], user_id):
                results.append(g)
        return results

    async def list_channels(self, guild_id: str) -> list:
        async with self.http.get(f"{self.api_base}/guilds/{guild_id}/channels", headers=self._headers()) as resp:
            resp.raise_for_status()
            channels = await resp.json()
        # type 2 == GUILD_VOICE. No client-side CONNECT/SPEAK pre-check
        # here (unlike the Discord leg) -- computing effective permissions
        # from role/channel overwrites would need more API calls than is
        # worth it for v1. A channel the bot can't actually join will just
        # fail at /connect (VOICE_PERMISSION_DENIED, surfaced as a
        # gateway Dispatch the client observes only as "no grant arrives"
        # -- see the Voice doc's "Fluxer reports a refusal by sending no
        # Dispatch" note). The /connect timeout below is what catches that.
        return [{"id": c["id"], "name": c["name"]} for c in channels if c.get("type") == 2]

    async def connect(self, guild_id: str, channel_id: str, guild_name: str, channel_name: str):
        if self.current is not None:
            await self.disconnect()

        try:
            grant = await self.gateway.join_voice_channel(guild_id, channel_id)
        except asyncio.TimeoutError:
            raise RuntimeError(
                "no voice grant arrived -- likely VOICE_PERMISSION_DENIED, "
                "VOICE_CHANNEL_FULL, or the instance has voice disabled"
            )

        self._room = rtc.Room()
        self._source = rtc.AudioSource(SAMPLE_RATE, CHANNELS)

        @self._room.on("participant_connected")
        def on_participant_connected(participant):
            print(f"[audio] participant connected: {participant.identity}")

        @self._room.on("track_published")
        def on_track_published(publication, participant):
            print(f"[audio] track published by {participant.identity}: kind={publication.kind}")

        @self._room.on("track_subscribed")
        def on_track_subscribed(track, publication, participant):
            print(f"[audio] track_subscribed: kind={track.kind} from {participant.identity}")
            if track.kind == rtc.TrackKind.KIND_AUDIO:
                asyncio.create_task(self._relay_remote_audio(track))

        await self._room.connect(grant["endpoint"], grant["token"])

        track = rtc.LocalAudioTrack.create_audio_track("discord-bridge", self._source)
        options = rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        await self._room.local_participant.publish_track(track, options)

        self._udp_in = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._udp_in.bind(("0.0.0.0", FLUXER_LEG_UDP_PORT))
        self._udp_in.setblocking(False)
        self._pump_task = asyncio.create_task(self._pump_discord_audio_into_livekit())

        self.current = {
            "guild_id": guild_id,
            "channel_id": channel_id,
            "guild_name": guild_name,
            "channel_name": channel_name,
            "connection_id": grant.get("connection_id"),
        }
        print(f"Bridging Fluxer voice channel {channel_name} ({guild_name})")

    async def disconnect(self):
        if self.current is None:
            return

        if self._pump_task:
            self._pump_task.cancel()
            self._pump_task = None
        if self._udp_in:
            self._udp_in.close()
            self._udp_in = None
        if self._room:
            await self._room.disconnect()
            self._room = None
        self._source = None

        try:
            await self.gateway.leave_voice_channel(
                self.current["guild_id"], self.current["connection_id"]
            )
        except Exception as exc:  # noqa: BLE001 -- best-effort cleanup
            print(f"warning: failed to send leave voice state: {exc}")

        print("Disconnected from Fluxer voice channel")
        self.current = None

    async def _relay_remote_audio(self, track: "rtc.RemoteAudioTrack"):
        # v1: forwards each remote participant's frames independently
        # rather than sample-summing multiple simultaneous Fluxer
        # speakers -- see README.md's "Notes / gotchas".
        stream = rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=CHANNELS)
        frames_sent = 0
        async for event in stream:
            if self.current is None:
                return
            pcm_bytes = bytes(event.frame.data)
            self._udp_out.sendto(pcm_bytes, (DISCORD_LEG_HOST, DISCORD_LEG_UDP_PORT))
            frames_sent += 1
            if frames_sent == 1 or frames_sent % 250 == 0:
                print(f"[audio-out] sent {frames_sent} frames to discord-leg ({DISCORD_LEG_HOST}:{DISCORD_LEG_UDP_PORT})")

    async def _pump_discord_audio_into_livekit(self):
        loop = asyncio.get_event_loop()
        frame_bytes = SAMPLES_PER_FRAME * CHANNELS * 2  # 16-bit samples
        frames_received = 0
        while True:
            try:
                data = await loop.sock_recv(self._udp_in, frame_bytes)
            except (BlockingIOError, OSError) as exc:
                print(f"[audio-in] sock_recv exception: {type(exc).__name__}: {exc}")
                await asyncio.sleep(0.001)
                continue
            if len(data) != frame_bytes or self._source is None:
                if data:
                    print(f"[audio-in] dropped packet: got {len(data)} bytes, expected {frame_bytes}, source_ready={self._source is not None}")
                continue  # drop partial/oversized packets rather than desync
            frames_received += 1
            if frames_received <= 10 or frames_received % 250 == 0:
                print(f"[audio-in] received {frames_received} frames from discord-leg (len={len(data)})")
            # Everything from here down used to be unguarded -- an exception
            # in AudioFrame.create() or the data assignment (neither of
            # which was inside any try/except) would silently kill this
            # whole background task, since it's a fire-and-forget
            # asyncio.create_task() that nothing ever awaits or checks the
            # result of. asyncio swallows that kind of dead-task exception
            # by default. Confirmed Sept 17 2026: logs showed exactly one
            # "received 1 frames" line and then total silence -- not even
            # the unconditional, no-await "capture_frame #1 starting" print
            # that comes right after it in source -- which is only possible
            # if something threw before reaching it. This wraps the whole
            # block and logs+continues instead of dying quietly.
            try:
                frame = rtc.AudioFrame.create(SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME)
                if frames_received <= 10:
                    print(f"[audio-in] frame #{frames_received} created ok, assigning data (data len={len(data)}, frame.data len={len(frame.data)})")
                # ROOT CAUSE (confirmed Sept 17 2026): frame.data[:] = data
                # raised "ValueError: memoryview assignment: lvalue and
                # rvalue have different structures" on every single frame
                # since this pipeline was first built -- silently, because
                # this pump task is fire-and-forget and nothing was ever
                # catching/logging its exceptions until the debug wrapper
                # added above. frame.data is a typed memoryview of 16-bit
                # PCM samples (format 'h', itemsize 2); `data` from the UDP
                # socket is a plain bytes object (format 'B', itemsize 1).
                # Same total byte length, but memoryview slice-assignment
                # requires matching item format, not just matching size.
                # Casting the incoming bytes to frame.data's own format
                # before assigning reinterprets the same underlying bytes
                # without copying, and actually succeeds.
                frame.data[:] = memoryview(data).cast(frame.data.format)
                if frames_received <= 10:
                    print(f"[audio-in] capture_frame #{frames_received} starting")
                await self._source.capture_frame(frame)
                if frames_received <= 10:
                    print(f"[audio-in] capture_frame #{frames_received} completed")
            except Exception as exc:
                import traceback
                print(f"[audio-in] pump loop EXCEPTION on frame #{frames_received}: {type(exc).__name__}: {exc}")
                traceback.print_exc()
                continue

    def status(self) -> dict:
        return {"connected": self.current is not None, "current": self.current}

    def current_members(self) -> list[str]:
        """Consumed by user-panel to verify someone is ACTUALLY, right now,
        present in the bridged voice channel before letting them touch
        anything -- never trust a client-supplied claim. Parses the real
        LiveKit room's remote participants (the bridge's own published
        participant is a LOCAL participant, not remote, so it's naturally
        excluded).

        NOTE: identity parsing assumes Fluxer's default participant
        identity shape `user_{user_id}_{connection_id}` per the Voice doc.
        `room.remote_participants` is the attribute name in recent
        `livekit` Python SDK versions -- re-check this against whatever
        version actually resolves from requirements.txt if this starts
        returning nothing despite people being visibly connected.
        """
        if self._room is None:
            return []
        user_ids = set()
        for participant in self._room.remote_participants.values():
            identity = participant.identity
            if identity.startswith("user_") and "_" in identity[len("user_"):]:
                user_id, _, _connection_id = identity[len("user_"):].rpartition("_")
                if user_id:
                    user_ids.add(user_id)
        return sorted(user_ids)


async def discover_endpoints(session: aiohttp.ClientSession) -> dict:
    url = f"{FLUXER_INSTANCE_URL}/.well-known/fluxer"
    async with session.get(url) as resp:
        resp.raise_for_status()
        doc = await resp.json()
    return doc["endpoints"]


def build_app(bridge: Bridge) -> web.Application:
    app = web.Application()

    async def get_guilds(request):
        return web.json_response(await bridge.list_guilds())

    async def get_channels(request):
        guild_id = request.match_info["guild_id"]
        return web.json_response(await bridge.list_channels(guild_id))

    async def post_connect(request):
        body = await request.json()
        guild_id, channel_id = body.get("guildId"), body.get("channelId")
        guild_name, channel_name = body.get("guildName", ""), body.get("channelName", "")
        if not guild_id or not channel_id:
            return web.json_response({"error": "guildId and channelId are required"}, status=400)
        try:
            await bridge.connect(guild_id, channel_id, guild_name, channel_name)
        except Exception as exc:  # noqa: BLE001 -- surfaced to the panel as-is
            return web.json_response({"error": str(exc)}, status=500)
        return web.json_response({"ok": True, "current": bridge.current})

    async def post_disconnect(request):
        await bridge.disconnect()
        return web.json_response({"ok": True})

    async def get_status(request):
        return web.json_response(bridge.status())

    async def get_current_members(request):
        return web.json_response(bridge.current_members())

    async def get_is_admin(request):
        guild_id = request.match_info["guild_id"]
        user_id = request.match_info["user_id"]
        return web.json_response({"isAdmin": await bridge.is_guild_admin(guild_id, user_id)})

    async def get_admin_guilds(request):
        user_id = request.match_info["user_id"]
        return web.json_response(await bridge.list_admin_guilds(user_id))

    app.router.add_get("/guilds", get_guilds)
    app.router.add_get("/guilds/{guild_id}/channels", get_channels)
    app.router.add_post("/connect", post_connect)
    app.router.add_post("/disconnect", post_disconnect)
    app.router.add_get("/status", get_status)
    app.router.add_get("/current-members", get_current_members)
    app.router.add_get("/guilds/{guild_id}/members/{user_id}/is-admin", get_is_admin)
    app.router.add_get("/users/{user_id}/admin-guilds", get_admin_guilds)
    return app


async def main():
    http_session = aiohttp.ClientSession()
    endpoints = await discover_endpoints(http_session)

    gateway = FluxerGateway(endpoints["gateway"], FLUXER_BOT_TOKEN)
    await gateway.connect()
    await asyncio.wait_for(gateway.ready_event.wait(), timeout=30)

    api_base = f"{endpoints['api_public']}/v1"
    bridge = Bridge(gateway, http_session, api_base)

    app = build_app(bridge)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", CONTROL_PORT)
    await site.start()
    print(f"Fluxer leg control API listening on :{CONTROL_PORT} -- idle, waiting for /connect")

    await asyncio.Event().wait()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
