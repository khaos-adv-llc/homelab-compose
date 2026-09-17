// Discord leg of the Fluxer <-> Discord voice bridge.
//
// v1 scope (matches the design doc): ONE mixed audio stream in each
// direction, no per-speaker identity -- see the build spec doc, section
// 2/6, for the v2 per-participant design.
//
// Guild/channel selection is RUNTIME, driven by the panel service (see
// ../panel/) rather than baked into .env -- this container logs in and
// sits idle until told, over its local control API, which voice channel to
// join. Only long-lived credentials (DISCORD_BOT_TOKEN) are static config.
//
// This is a real, runnable scaffold, not a finished production bot: it has
// no jitter buffer, no reconnect backoff beyond discord.js's own defaults,
// and the UDP relay + control API are unencrypted/unauthenticated by
// design (neither ever leaves the docker-compose internal network -- see
// docker-compose.yml). Read README.md's "Notes / gotchas" section before
// deploying this for real.

import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  generateDependencyReport,
} from '@discordjs/voice';
import prism from 'prism-media';
import dgram from 'node:dgram';
import http from 'node:http';
import { PassThrough } from 'node:stream';

// Temporary, one-time-at-boot diagnostic: confirms which optional deps
// (encryption package, opus encoder, ffmpeg) @discordjs/voice actually
// detected and is using, rather than us assuming sodium-native "being
// installed" means it's actually being picked up correctly.
console.log(generateDependencyReport());

const {
  DISCORD_BOT_TOKEN,
  // Where this container sends mixed Discord-side audio TO (the fluxer-leg
  // container's inbound UDP port). Docker Compose service-name DNS resolves
  // this on the internal bridge network.
  FLUXER_LEG_HOST = 'fluxer-leg',
  FLUXER_LEG_UDP_PORT = '5100',
  // Port this container listens on for incoming mixed Fluxer-side audio.
  DISCORD_LEG_UDP_PORT = '5101',
  // Port this container's control API (used by web-panel) listens on.
  CONTROL_PORT = '5102',
} = process.env;

if (!DISCORD_BOT_TOKEN) {
  console.error('FATAL: DISCORD_BOT_TOKEN is not set -- check .env / Infisical');
  process.exit(1);
}

// Discord voice PCM: 48kHz, stereo, 16-bit signed little-endian.
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE / 1000) * FRAME_MS * CHANNELS * BYTES_PER_SAMPLE; // 3840 bytes

// ---------------------------------------------------------------------
// Current connection state -- there is at most one active voice
// connection at a time in v1 (matches the single-mixed-stream design).
// ---------------------------------------------------------------------

/** @type {{ guildId: string, channelId: string, guildName: string, channelName: string } | null} */
let current = null;
/** The live VoiceChannel object for the current connection, so
 * /current-members can read its real-time .members -- kept separate from
 * `current` (a plain serializable snapshot) so `current` stays cheap to
 * JSON.stringify for /status. */
let currentChannelObj = null;
/** userId -> { pending: Buffer[] } of pending 20ms PCM frames from that speaker. */
let activeSpeakers = new Map();
let mixerInterval = null;

// ---------------------------------------------------------------------
// Outbound: mix every active Discord speaker down to one PCM stream and
// ship it to the fluxer-leg over UDP. Only runs while connected.
// ---------------------------------------------------------------------

const udpOut = dgram.createSocket('udp4');
let framesSentToFluxer = 0;

function sendMixedFrame() {
  if (activeSpeakers.size === 0) return;

  const mixed = Buffer.alloc(FRAME_BYTES);
  let anyContributed = false;

  for (const speaker of activeSpeakers.values()) {
    const frame = speaker.pending.shift();
    if (!frame) continue;
    anyContributed = true;
    for (let i = 0; i < FRAME_BYTES; i += 2) {
      const existing = mixed.readInt16LE(i);
      const add = frame.readInt16LE(i);
      // Simple additive mix with clipping -- fine for a handful of
      // concurrent speakers; revisit with gain-scaling if this clips
      // audibly with many simultaneous talkers.
      const sum = Math.max(-32768, Math.min(32767, existing + add));
      mixed.writeInt16LE(sum, i);
    }
  }

  if (anyContributed) {
    udpOut.send(mixed, Number(FLUXER_LEG_UDP_PORT), FLUXER_LEG_HOST);
    framesSentToFluxer += 1;
    if (framesSentToFluxer === 1 || framesSentToFluxer % 250 === 0) {
      console.log(`[audio-out] sent ${framesSentToFluxer} mixed frames to fluxer-leg (${FLUXER_LEG_HOST}:${FLUXER_LEG_UDP_PORT})`);
    }
  }
}

function subscribeToSpeaker(receiver, userId) {
  if (activeSpeakers.has(userId)) return;

  const opusStream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
  });
  const decoder = new prism.opus.Decoder({
    rate: SAMPLE_RATE,
    channels: CHANNELS,
    frameSize: (SAMPLE_RATE / 1000) * FRAME_MS,
  });

  const state = { pending: [] };
  activeSpeakers.set(userId, state);

  const pcmStream = opusStream.pipe(decoder);
  let loggedFirstChunk = false;
  pcmStream.on('data', (chunk) => {
    if (!loggedFirstChunk) {
      loggedFirstChunk = true;
      console.log(`[audio] first decoded PCM chunk from user ${userId}: ${chunk.length} bytes`);
    }
    for (let offset = 0; offset + FRAME_BYTES <= chunk.length; offset += FRAME_BYTES) {
      state.pending.push(chunk.subarray(offset, offset + FRAME_BYTES));
    }
  });
  pcmStream.on('end', () => activeSpeakers.delete(userId));
  pcmStream.on('error', (err) => {
    console.error(`voice decode error for user ${userId}:`, err.message);
    activeSpeakers.delete(userId);
  });
}

// ---------------------------------------------------------------------
// Inbound: receive mixed PCM from the fluxer-leg over UDP, encode to
// Opus, and play it as this bot's own voice output. The player/encoder
// are created once at boot and simply have nothing subscribed to them
// while disconnected -- cheaper than tearing down/rebuilding per connect.
// ---------------------------------------------------------------------

const incomingPcm = new PassThrough();
const udpIn = dgram.createSocket('udp4');
let framesReceivedFromFluxer = 0;
udpIn.on('message', (msg) => {
  if (current) {
    incomingPcm.write(msg);
    framesReceivedFromFluxer += 1;
    if (framesReceivedFromFluxer === 1 || framesReceivedFromFluxer % 250 === 0) {
      console.log(`[audio-in] received ${framesReceivedFromFluxer} frames from fluxer-leg (msg size ${msg.length} bytes)`);
    }
  }
});
udpIn.bind(Number(DISCORD_LEG_UDP_PORT), () => {
  console.log(`listening for Fluxer-side audio on udp/${DISCORD_LEG_UDP_PORT}`);
});

const opusEncoder = new prism.opus.Encoder({
  rate: SAMPLE_RATE,
  channels: CHANNELS,
  frameSize: (SAMPLE_RATE / 1000) * FRAME_MS,
});
incomingPcm.pipe(opusEncoder);

const audioPlayer = createAudioPlayer();
const resource = createAudioResource(opusEncoder, { inputType: StreamType.Opus });
audioPlayer.play(resource);

// ---------------------------------------------------------------------
// Discord client.
// ---------------------------------------------------------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let ready = false;
client.once('ready', () => {
  ready = true;
  console.log(`Discord leg logged in as ${client.user.tag} -- idle, waiting for /connect`);
});
client.on('error', (err) => console.error('Discord client error:', err));
client.login(DISCORD_BOT_TOKEN);

// ---------------------------------------------------------------------
// Connect / disconnect, driven by the control API.
// ---------------------------------------------------------------------

async function connectToChannel(guildId, channelId) {
  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    throw new Error('not a voice channel');
  }

  const me = await guild.members.fetchMe();
  const perms = channel.permissionsFor(me);
  if (!perms?.has('Connect') || !perms?.has('Speak')) {
    throw new Error('bot lacks CONNECT/SPEAK in that channel');
  }

  // Tear down any existing connection first -- v1 only bridges one
  // channel at a time.
  const existing = getVoiceConnection(guildId);
  if (existing) existing.destroy();
  activeSpeakers = new Map();

  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, // must hear the channel to bridge it
    selfMute: false,
  });

  // Temporary, verbose -- @discordjs/voice's own internal state machine and
  // networking layer report every transition and low-level failure over
  // 'debug'/'stateChange', which says WHY it's stuck (bad encryption mode
  // negotiation, invalid discovery response, websocket close code, etc.)
  // instead of us guessing from a bare 30s timeout or raw packet captures.
  // Safe to remove once the real cause here is found.
  //
  // The connection-level 'debug' forwarding didn't surface anything last
  // time this ran, so this also hooks the networking sub-object directly
  // (it appears on newState once the connection reaches 'connecting') --
  // that layer is what actually does the voice-gateway websocket handshake
  // and UDP setup, and has its own 'debug'/'error'/'close' events.
  const hookedNetworkings = new WeakSet();
  connection.on('stateChange', (oldState, newState) => {
    console.log(`[voice] state: ${oldState.status} -> ${newState.status}`);
    const networking = newState.networking;
    if (networking && !hookedNetworkings.has(networking)) {
      hookedNetworkings.add(networking);
      networking.on('stateChange', (oldNetState, newNetState) => {
        console.log(`[voice-net] state: ${oldNetState.code} -> ${newNetState.code}`);
      });
      networking.on('debug', (message) => {
        console.log(`[voice-net-debug] ${message}`);
      });
      networking.on('error', (err) => {
        console.error('[voice-net] error:', err);
      });
      networking.on('close', (code) => {
        console.warn(`[voice-net] websocket closed, code: ${code}`);
      });
    }
  });
  connection.on('debug', (message) => {
    console.log(`[voice-debug] ${message}`);
  });
  connection.on('error', (err) => {
    console.error('[voice] connection-level error:', err);
  });

  console.log(`attempting to join voice: ${channel.name} (${guild.name}) [guild=${guildId} channel=${channelId}]`);
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch (err) {
    // The bare AbortError from @discordjs/voice's own timeout gives no clue
    // which channel/guild it was, or that it's a network-level failure, not
    // a permissions one (permissions were already checked above -- this is
    // the actual UDP voice handshake with Discord not completing in time).
    // Most likely: outbound UDP from this container/host isn't reaching
    // Discord's voice servers -- check firewall/NAT on the path out, not
    // the bot's Discord-side permissions.
    connection.destroy();
    throw new Error(
      `voice connection to Discord timed out after 30s joining "${channel.name}" (${guild.name}) -- ` +
        `permissions checked out fine, so this looks like the voice UDP handshake itself isn't completing. ` +
        `Check outbound UDP connectivity from this container/host to Discord's voice servers. Original error: ${err.message}`
    );
  }
  connection.subscribe(audioPlayer);

  connection.receiver.speaking.on('start', (userId) => {
    console.log(`[audio] speaking start: user ${userId}`);
    subscribeToSpeaker(connection.receiver, userId);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    console.warn('voice connection disconnected -- attempting to recover');
    try {
      await Promise.race([
        entersState(connection, 'signalling', 5_000),
        entersState(connection, 'connecting', 5_000),
      ]);
    } catch {
      connection.destroy();
      current = null;
      if (mixerInterval) clearInterval(mixerInterval);
      mixerInterval = null;
      console.error('voice connection could not recover -- back to idle');
    }
  });

  if (mixerInterval) clearInterval(mixerInterval);
  mixerInterval = setInterval(sendMixedFrame, FRAME_MS);

  current = {
    guildId,
    channelId,
    guildName: guild.name,
    channelName: channel.name,
  };
  currentChannelObj = channel;
  console.log(`Bridging Discord voice channel ${channel.name} (${guild.name})`);
}

// Consumed by the panel to answer "is this Discord user an admin of this
// guild, right now" -- checked live off the bot's own membership fetch,
// never cached. Administrator or Manage Server both count as "admin" for
// bridge-control purposes.
async function isGuildAdmin(guild, userId) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return false;
  return member.permissions.has('Administrator') || member.permissions.has('ManageGuild');
}

function disconnect() {
  if (!current) return;
  const existing = getVoiceConnection(current.guildId);
  if (existing) existing.destroy();
  if (mixerInterval) clearInterval(mixerInterval);
  mixerInterval = null;
  activeSpeakers = new Map();
  current = null;
  currentChannelObj = null;
  console.log('Disconnected from Discord voice channel');
}

// ---------------------------------------------------------------------
// Control HTTP API -- internal-network-only, consumed by web-panel.
// ---------------------------------------------------------------------

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (req, res) => {
  try {
    if (!ready) {
      sendJson(res, 503, { error: 'discord client not ready yet' });
      return;
    }

    const url = new URL(req.url, 'http://internal');

    if (req.method === 'GET' && url.pathname === '/guilds') {
      const guilds = [...client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name }));
      sendJson(res, 200, guilds);
      return;
    }

    const channelsMatch = url.pathname.match(/^\/guilds\/(\d+)\/channels$/);
    if (req.method === 'GET' && channelsMatch) {
      const guild = await client.guilds.fetch(channelsMatch[1]);
      const me = await guild.members.fetchMe();
      const channels = [...(await guild.channels.fetch()).values()]
        .filter((c) => c && c.type === ChannelType.GuildVoice)
        .map((c) => {
          const perms = c.permissionsFor(me);
          return {
            id: c.id,
            name: c.name,
            joinable: Boolean(perms?.has('Connect') && perms?.has('Speak')),
          };
        });
      sendJson(res, 200, channels);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/connect') {
      const { guildId, channelId } = await readJsonBody(req);
      if (!guildId || !channelId) {
        sendJson(res, 400, { error: 'guildId and channelId are required' });
        return;
      }
      await connectToChannel(guildId, channelId);
      sendJson(res, 200, { ok: true, current });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/disconnect') {
      disconnect();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      sendJson(res, 200, { connected: current !== null, current });
      return;
    }

    // Consumed by user-panel to verify someone is ACTUALLY, right now, in
    // the bridged voice channel before letting them touch anything --
    // never trust a client-supplied "I'm in the channel" claim, always
    // check the bot's own live view via channel.members.
    if (req.method === 'GET' && url.pathname === '/current-members') {
      if (!currentChannelObj) {
        sendJson(res, 200, []);
        return;
      }
      // .members on a cached VoiceChannel reflects real-time voice state
      // (backed by the GuildVoiceStates intent), not guild membership.
      const memberIds = [...currentChannelObj.members.keys()];
      sendJson(res, 200, memberIds);
      return;
    }

    // Consumed by the panel's live admin gate for connect/disconnect/
    // hand-off-claim -- see isGuildAdmin above.
    const isAdminMatch = url.pathname.match(/^\/guilds\/(\d+)\/members\/(\d+)\/is-admin$/);
    if (req.method === 'GET' && isAdminMatch) {
      const guild = await client.guilds.fetch(isAdminMatch[1]).catch(() => null);
      if (!guild) {
        sendJson(res, 404, { error: 'bot is not in that guild' });
        return;
      }
      sendJson(res, 200, { isAdmin: await isGuildAdmin(guild, isAdminMatch[2]) });
      return;
    }

    // Consumed by the panel to populate "servers you can pick from" --
    // every guild the bot can see where this Discord user is an admin.
    const adminGuildsMatch = url.pathname.match(/^\/users\/(\d+)\/admin-guilds$/);
    if (req.method === 'GET' && adminGuildsMatch) {
      const userId = adminGuildsMatch[1];
      const results = [];
      for (const guild of client.guilds.cache.values()) {
        if (await isGuildAdmin(guild, userId)) results.push({ id: guild.id, name: guild.name });
      }
      sendJson(res, 200, results);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('control API error:', err);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(Number(CONTROL_PORT), () => {
  console.log(`Discord leg control API listening on :${CONTROL_PORT}`);
});
